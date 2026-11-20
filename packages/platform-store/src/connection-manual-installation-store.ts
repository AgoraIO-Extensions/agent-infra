import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	ConnectionInstallationAuthorizationV1Schema,
	type ConnectionInstallCommandResponseV1,
	ConnectionInstallCommandResponseV1Schema,
	type ConnectionInstallReadbackRequestV1,
	ConnectionInstallReadbackRequestV1Schema,
	type ConnectionManualConfirmCandidateV1,
	ConnectionManualConfirmCandidateV1Schema,
	type ConnectionManualInstallDescriptorV1,
	ConnectionManualInstallDescriptorV1Schema,
	type ConnectionRegistrationReceiptV1,
	ConnectionRegistrationReceiptV1Schema,
	type ConnectionRegistrationTemplateV1,
	ConnectionRegistrationTemplateV1Schema,
	type RuntimeOAuthConfigurationV1,
	RuntimeOAuthConfigurationV1Schema,
	type RuntimeOAuthResponseV1,
	RuntimeOAuthResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import {
	connectionInstallConfigurationDigestV1,
	connectionManualConfirmCandidateDigestV1,
	connectionManualInstallConfigurationV1,
	connectionManualInstallDescriptorDigestV1,
	connectionManualInstallDescriptorV1,
	connectionRegistrationKeyHashV1,
	connectionRegistrationReceiptDigestV1,
	connectionRegistrationTemplateDigestV1,
	matchConnectionRegistrationReceiptV1,
} from "@agent-infra/contracts/runtime/connection-install-node";
import {
	ConnectionInstallationErrorV1,
	type ConnectionManualInstallationCurrentV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { parseConnectionInstallationAuthorizationRedirectV1 } from "./connection-installation.js";
import {
	type ConnectionManualInstallationClaimV1,
	type ConnectionManualInstallationPolicyInputV1,
	type ConnectionManualInstallationPolicyV1,
	captureConnectionManualInstallationPolicyV1,
	connectionManualCurrentAllowedV1,
	connectionManualExceptionLiveV1,
	lockConnectionManualAssociationForInstallationV1,
	manualTemplateMatchesCurrentV1,
	readConnectionManualInstallationFactsV1,
} from "./connection-manual-installations.js";
import {
	connectionPrincipalPinDeadlineSql,
	connectionPrincipalPinPermitsSql,
	insertConnectionPrincipalPinAuditV1,
	sweepConnectionPrincipalPinRulesV1,
} from "./connection-principal-pin-rules.js";
import postgres from "./observed-postgres.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
type Row = Record<string, unknown>;
type ManualCommand = ConnectionManualInstallationClaimV1["command"]["command"];

const manualCommands: readonly ManualCommand[] = [
	"prepare",
	"status",
	"revoke",
	"begin",
	"begin_status",
	"confirm",
];
/** §13.5.6 exception confirm phase commands; each is a row of the original confirm. */
type ConfirmPhaseCommand = "confirm_binding_readback" | "confirm_exchange";
/** Two bounded network hops (supply, then one Connection request) per attempt. */
const attemptLifetime = sql`interval '60 seconds'`;
/**
 * One unsupplied-prepare recovery pass reads at most one page and starts no new
 * candidate after its deadline or on cancellation. Each candidate is a single
 * transaction under the lock and statement timeouts; the rest of the backlog
 * keeps its eligibility and the next tick continues after the last handled id.
 */
const unsuppliedPassBudget = 32;
const unsuppliedPassMs = 2_000;

function unavailable(): never {
	throw new ConnectionInstallationErrorV1("unavailable");
}

function sha256(value: string) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Final-write predicate (§13.5.7 领取 fence): the original outbox claim still
 * holds at the database clock. The same lease owner and delivery fence must be
 * on both the outbox item and the Execution, so a renewed-after-loss claim,
 * a changed fence or another outbox of the same Worker never matches.
 */
function originalClaimHolds(
	reference: { readonly conversationId: string; readonly executionId: string },
	claim: { readonly owner: string; readonly fence: number },
) {
	return sql`exists (select 1 from platform.outbox_items o
		join platform.conversation_executions e on e.execution_id=o.payload->>'executionId' and e.conversation_id=o.scope_id
		where o.scope_type='conversation' and o.scope_id=${reference.conversationId}
			and o.payload->>'executionId'=${reference.executionId}
			and o.status='processing' and o.lease_owner=${claim.owner}
			and o.lease_expires_at > clock_timestamp()
			and o.delivery_fence=${claim.fence} and e.delivery_fence=${claim.fence}
			and o.operation in ('conversation.turn.submit.v1','conversation.turn.regenerate.v1','conversation.turn.supplement.v1'))`;
}

/** The fixed template's original claim, or a predicate that never holds. */
function templateClaimHolds(template: unknown) {
	if (!template) return sql`false`;
	const fixed = ConnectionRegistrationTemplateV1Schema.parse(template);
	return originalClaimHolds(fixed.reference, fixed.claim);
}

/** SQL predicate for when a manual command may be claimed, by its kind. */
const eligible = sql`(
	(c.command = 'prepare' and a.status = 'preparing' and m.registration_state = 'pending' and m.supply_state in ('pending','confirmed'))
	or (c.command = 'status' and a.status = 'preparing' and ((m.registration_state = 'unknown' and m.supply_state = 'confirmed')
		or (m.registration_state = 'pending' and m.supply_state = 'unknown')))
	or (c.command = 'begin' and a.status in ('awaiting_confirmation','confirmed') and m.registration_state = 'registered' and m.supply_state = 'confirmed')
	or (c.command = 'begin_status' and a.status in ('awaiting_confirmation','confirmed') and m.registration_state = 'registered' and m.supply_state = 'confirmed')
	or (c.command = 'revoke' and m.revoke_state = 'pending' and m.supply_state = 'confirmed')
	or (c.command = 'confirm' and a.status = 'confirmed' and m.registration_state = 'registered'
		and m.supply_state = 'confirmed' and m.revoke_state = 'not_required' and m.descriptor_digest is not null)
) and (c.command = 'revoke' or a.expires_at > clock_timestamp())`;

/**
 * Worker-side Store port of the first manual Owner EP-1060 install (§13.5.5–
 * §13.5.7). Every transition is a CAS on the original authorization, manual
 * row and command attempt; nothing here holds or returns credential bytes
 * except the original application ciphertext handed to the Worker keyring.
 */
export class PostgresConnectionManualInstallationStoreV1 {
	readonly #client: ReturnType<typeof postgres>;
	readonly #database: ReturnType<typeof drizzle>;
	readonly #directory: TaskUserDirectoryV1;
	readonly #policy: ConnectionManualInstallationPolicyV1;
	/** Last unsupplied prepare a recovery pass handled; the next pass continues after it. */
	#unsuppliedAfter = "";

	constructor(options: {
		readonly databaseUrl: string;
		readonly directory: TaskUserDirectoryV1;
		readonly policy: ConnectionManualInstallationPolicyInputV1;
	}) {
		this.#policy = captureConnectionManualInstallationPolicyV1(options.policy);
		this.#directory = options.directory;
		this.#client = postgres(options.databaseUrl, { max: 4 });
		this.#database = drizzle(this.#client);
	}

	async #transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
		try {
			return await this.#database.transaction(
				async (tx) => {
					await tx.execute(sql`set local lock_timeout = '5s'`);
					await tx.execute(sql`set local statement_timeout = '15s'`);
					return work(tx);
				},
				{ isolationLevel: "read committed" },
			);
		} catch (error) {
			if (error instanceof ConnectionInstallationErrorV1) throw error;
			unavailable();
		}
	}

	async #lockInstallation(
		tx: Transaction,
		authorizationId: string,
		lock: "update" | "share" = "update",
	): Promise<(Row & { associationLocked: boolean }) | undefined> {
		const associationLocked =
			await lockConnectionManualAssociationForInstallationV1(
				tx,
				authorizationId,
			);
		await tx.execute(sql`select id from platform.connection_installation_authorizations
			where id=${authorizationId} ${lock === "update" ? sql`for update` : sql`for share`}`);
		const row = await this.#row(tx, authorizationId, lock);
		return row ? { ...row, associationLocked } : undefined;
	}

	async #facts(tx: Transaction, userId: string, executionId: string) {
		const current = await readConnectionManualInstallationFactsV1(
			tx,
			this.#directory,
			userId,
			executionId,
		);
		return connectionManualCurrentAllowedV1(current, userId) ? current : null;
	}

	/**
	 * A prepare claimed but expired before fixSupply committed sent nothing: no
	 * template, supply attempt or ciphertext exists, and registration needs a
	 * confirmed supply. Each such prepare, across Executions, either reopens for
	 * the same installation or, when its authorization or association no longer
	 * holds, closes as unknown with its original key. The locks follow
	 * association → authorization → installation → command. A pass is bounded
	 * (see `unsuppliedPassBudget`); the blind sweep below never touches these
	 * rows, so whatever a pass leaves stays eligible for the next one.
	 */
	async #reopenUnsuppliedPrepares(signal?: AbortSignal) {
		const deadline = performance.now() + unsuppliedPassMs;
		const read = (after: string, upTo: string | null, limit: number) =>
			this.#transaction((tx) =>
				tx.execute(sql`
				select c.id, c.authorization_id from platform.connection_installation_commands c
				join platform.connection_manual_installations m on m.authorization_id=c.authorization_id
				where c.command='prepare' and c.status='pending' and c.attempt_id is not null
					and c.attempt_expires_at <= clock_timestamp() and c.delivery_digest is null
					and m.template is null and m.supply_attempt_id is null
					and m.supply_state='pending' and m.registration_state='pending'
					and c.id > ${after} and (${upTo === null} or c.id <= ${upTo ?? ""})
				order by c.id limit ${limit}
			`),
			);
		// Continue after the previous pass, then wrap to the ids before it.
		const cursor = this.#unsuppliedAfter;
		const page = [...(await read(cursor, null, unsuppliedPassBudget))];
		if (page.length < unsuppliedPassBudget && cursor !== "")
			page.push(
				...(await read("", cursor, unsuppliedPassBudget - page.length)),
			);
		for (const candidate of page) {
			if (signal?.aborted || performance.now() >= deadline) return;
			this.#unsuppliedAfter = candidate.id as string;
			try {
				await this.#settleUnsuppliedPrepare(
					candidate.id as string,
					candidate.authorization_id as string,
				);
			} catch {
				// A failed candidate keeps its eligibility; a later pass retries it.
			}
		}
		// Every candidate fit in this pass; the next one starts from the beginning.
		if (page.length < unsuppliedPassBudget) this.#unsuppliedAfter = "";
	}

	async #settleUnsuppliedPrepare(commandId: string, authorizationId: string) {
		await this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, authorizationId);
			if (!row) return;
			const reopened = row.associationLocked
				? await tx.execute(sql`
					update platform.connection_installation_commands c
					set status='pending', attempt_id=null, attempt_owner=null, attempt_expires_at=null,
						updated_at=clock_timestamp()
					from platform.connection_manual_installations m, platform.connection_installation_authorizations a
					where c.id=${commandId} and c.command='prepare' and c.status='pending'
						and c.attempt_id is not null and c.attempt_expires_at <= clock_timestamp()
						and c.delivery_digest is null
						and m.authorization_id=c.authorization_id and a.id=c.authorization_id
						and a.status='preparing' and a.expires_at > clock_timestamp()
						and m.template is null and m.supply_attempt_id is null
						and m.supply_state='pending' and m.registration_state='pending'
					returning c.id
				`)
				: [];
			if (reopened.length === 1) return;
			await tx.execute(sql`
				update platform.connection_installation_commands set status='unknown', updated_at=clock_timestamp()
				where id=${commandId} and command='prepare' and status='pending'
					and attempt_id is not null and attempt_expires_at <= clock_timestamp()
			`);
		});
	}

	/** Expired attempts become unknown, including the registration they were sending. */
	async #sweep(signal?: AbortSignal) {
		// §13.5.1 exception items 4, 6 and 8: deadlines, expiry and pending releases.
		await this.#transaction((tx) =>
			sweepConnectionPrincipalPinRulesV1(tx, this.#policy),
		);
		if (signal?.aborted) return;
		await this.#reopenUnsuppliedPrepares(signal);
		if (signal?.aborted) return;
		await this.#transaction((tx) =>
			tx.execute(sql`
			update platform.connection_installation_commands c set status='unknown', updated_at=clock_timestamp()
			where (c.status='sending' or (c.status='pending' and c.command='prepare' and c.attempt_id is not null
					and not exists (select 1 from platform.connection_manual_installations unsupplied
						where unsupplied.authorization_id=c.authorization_id and unsupplied.template is null
							and unsupplied.supply_attempt_id is null and unsupplied.supply_state='pending'
							and unsupplied.registration_state='pending')))
				and c.attempt_expires_at is not null and c.attempt_expires_at <= clock_timestamp()
				and c.authorization_id in (select authorization_id from platform.connection_manual_installations)
		`),
		);
		await this.#transaction((tx) =>
			tx.execute(sql`
			update platform.connection_manual_installations m
			set registration_state = case when m.registration_state = 'sending' then 'unknown' else m.registration_state end,
				supply_state = case when m.registration_state = 'pending' then 'unknown' else m.supply_state end,
				revision = m.revision + 1, updated_at = clock_timestamp()
			where (m.registration_state = 'sending' or m.supply_state = 'sending'
				or (m.registration_state = 'pending' and m.supply_state = 'confirmed'
					and exists (select 1 from platform.connection_installation_commands original
						where original.authorization_id=m.authorization_id and original.command='prepare'
							and original.status='unknown' and original.delivery_digest is null)))
				and not exists (select 1 from platform.connection_installation_commands c
					where c.authorization_id = m.authorization_id and c.attempt_id is not null
						and (c.status = 'sending' or (c.command='prepare' and c.status='pending'))
						and c.command in ('prepare','status'))
		`),
		);
		await this.#transaction((tx) =>
			tx.execute(sql`
			update platform.connection_manual_installations m set revoke_state='unknown', revision=m.revision+1, updated_at=clock_timestamp()
			where m.revoke_state='sending' and not exists (select 1 from platform.connection_installation_commands c
				where c.authorization_id = m.authorization_id and c.command='revoke' and c.status='sending')
		`),
		);
	}

	/**
	 * Pending manual commands of Executions this Worker currently holds. The
	 * expiry sweep before the listing is one bounded recovery pass; a cancelled
	 * signal yields before or after it without listing.
	 */
	async listPending(
		limit: number,
		executionIds: readonly string[],
		signal?: AbortSignal,
	): Promise<
		readonly {
			readonly commandId: string;
			readonly command: ManualCommand;
			readonly authorizationId: string;
			readonly executionId: string;
		}[]
	> {
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 256 ||
			executionIds.length === 0 ||
			signal?.aborted
		)
			return [];
		await this.#sweep(signal);
		if (signal?.aborted) return [];
		const rows = await this.#transaction(async (tx) => {
			return tx.execute(sql`
				select c.id, c.command, c.authorization_id, a.execution_id
				from platform.connection_installation_commands c
				join platform.connection_installation_authorizations a on a.id = c.authorization_id
				join platform.connection_manual_installations m on m.authorization_id = a.id
				where c.status = 'pending' and c.attempt_id is null and ${eligible}
					and a.execution_id in (${sql.join(
						executionIds.map((id) => sql`${id}`),
						sql`, `,
					)})
					and not exists (select 1 from platform.connection_installation_commands prior
						where prior.authorization_id = c.authorization_id and prior.created_at < c.created_at
							and prior.status in ('pending','sending'))
				order by c.created_at, c.id limit ${limit}
			`);
		});
		return rows.map((row) => ({
			commandId: row.id as string,
			command: row.command as ManualCommand,
			authorizationId: row.authorization_id as string,
			executionId: row.execution_id as string,
		}));
	}

	async #row(
		tx: Transaction,
		authorizationId: string,
		lock: "update" | "share",
	) {
		const rows =
			lock === "update"
				? await tx.execute(sql`
					select a.id, a.user_id, a.confirmation_revision, a.binding, a.status, a.expires_at,
						a.execution_id, m.template, m.template_digest, m.registration_key, m.registration_key_hash,
						m.supply_attempt_id, m.supply_state, m.registration_state, m.receipt, m.configuration,
						m.revoke_state, m.consumer_id, m.agent_id, m.association_revision, m.connection_agent_id,
						m.descriptor, m.descriptor_digest,
						a.expires_at > clock_timestamp() as live
					from platform.connection_installation_authorizations a
					join platform.connection_manual_installations m on m.authorization_id = a.id
					where a.id = ${authorizationId}
					for update of a, m`)
				: await tx.execute(sql`
					select a.id, a.user_id, a.confirmation_revision, a.binding, a.status, a.expires_at,
						a.execution_id, m.template, m.template_digest, m.registration_key, m.registration_key_hash,
						m.supply_attempt_id, m.supply_state, m.registration_state, m.receipt, m.configuration,
						m.revoke_state, m.consumer_id, m.agent_id, m.association_revision, m.connection_agent_id,
						m.descriptor, m.descriptor_digest,
						a.expires_at > clock_timestamp() as live
					from platform.connection_installation_authorizations a
					join platform.connection_manual_installations m on m.authorization_id = a.id
					where a.id = ${authorizationId}
					for share of a, m`);
		return rows[0];
	}

	#authorization(
		row: Row,
	): ConnectionManualInstallationClaimV1["authorization"] {
		const binding = row.binding as {
			principal: { kind: "user"; id: string };
			reference: ConnectionManualInstallationClaimV1["authorization"]["reference"];
		};
		return {
			authorizationId: row.id as string,
			confirmationRevision: row.confirmation_revision as string,
			principal: { kind: "user", id: binding.principal.id },
			reference: structuredClone(binding.reference),
			expiresAt: new Date(row.expires_at as string).getTime(),
		};
	}

	#installation(row: Row): ConnectionManualInstallationClaimV1["installation"] {
		return {
			...(row.template
				? {
						template: ConnectionRegistrationTemplateV1Schema.parse(
							row.template,
						),
					}
				: {}),
			...(row.registration_key
				? { registrationKey: row.registration_key as string }
				: {}),
			...(row.supply_attempt_id
				? { supplyAttemptId: row.supply_attempt_id as string }
				: {}),
			supplyState: row.supply_state as string,
			registrationState: row.registration_state as string,
			...(row.receipt
				? { receipt: ConnectionRegistrationReceiptV1Schema.parse(row.receipt) }
				: {}),
			...(row.configuration
				? {
						configuration: RuntimeOAuthConfigurationV1Schema.parse(
							row.configuration,
						),
					}
				: {}),
			revokeState: row.revoke_state as string,
		};
	}

	/**
	 * Commits `sending` for one command attempt of the claim holder. A command
	 * whose original claim, Execution, Sandbox, Pod or association changed is
	 * rejected here (nothing was sent) and never moves to another claim.
	 */
	async claim(input: {
		readonly commandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
	}): Promise<ConnectionManualInstallationClaimV1 | null> {
		return this.#transaction(async (tx) => {
			const [command] = await tx.execute(sql`
				select c.id, c.command, c.authorization_id from platform.connection_installation_commands c
				where c.id = ${input.commandId} and c.status = 'pending' and c.attempt_id is null
			`);
			if (
				!command ||
				!manualCommands.includes(command.command as ManualCommand)
			)
				return null;
			const row = await this.#lockInstallation(
				tx,
				command.authorization_id as string,
			);
			if (!row) return null;
			const authorization = this.#authorization(row);
			const current = row.associationLocked
				? await this.#facts(
						tx,
						authorization.principal.id,
						authorization.reference.executionId,
					)
				: null;
			if (
				!current ||
				current.claim.owner !== input.attemptOwner ||
				!isDeepStrictEqual(current.reference, authorization.reference) ||
				String(row.association_revision) !==
					String(current.preparation.association.revision) ||
				row.connection_agent_id !==
					current.preparation.association.connectionAgentId ||
				(row.template &&
					!manualTemplateMatchesCurrentV1(
						this.#policy,
						ConnectionRegistrationTemplateV1Schema.parse(row.template),
						authorization,
						current,
						row.registration_key_hash as string,
					))
			) {
				// The original claim or Host binding no longer holds: nothing is sent.
				return this.#claimLost(tx, input.commandId, command.command as string);
			}
			const updated = await tx.execute(sql`
				update platform.connection_installation_commands c
				set status=case when c.command='prepare' then 'pending' else 'sending' end, attempt_id=${input.attemptId}, attempt_owner=${input.attemptOwner},
					attempt_expires_at=clock_timestamp() + ${attemptLifetime}, delivery_digest=null,
					updated_at=clock_timestamp()
				from platform.connection_installation_authorizations a, platform.connection_manual_installations m
				where c.id=${input.commandId} and c.status='pending' and c.attempt_id is null
					and a.id=c.authorization_id and m.authorization_id=a.id and ${eligible}
					and ${originalClaimHolds(current.reference, current.claim)}
					and not exists (select 1 from platform.connection_installation_commands prior
						where prior.authorization_id = c.authorization_id and prior.created_at < c.created_at
							and prior.status in ('pending','sending'))
				returning c.id
			`);
			if (updated.length !== 1) {
				// A claim lost during the directory read is final for its fence.
				const [held] = await tx.execute(
					sql`select ${originalClaimHolds(current.reference, current.claim)} as held`,
				);
				if (held?.held !== true)
					return this.#claimLost(
						tx,
						input.commandId,
						command.command as string,
					);
				return null;
			}
			if (command.command === "revoke")
				await tx.execute(sql`
					update platform.connection_manual_installations set revoke_state='sending', revision=revision+1,
						updated_at=clock_timestamp() where authorization_id=${authorization.authorizationId}
				`);
			return {
				command: {
					commandId: input.commandId,
					command: command.command as ManualCommand,
					attemptId: input.attemptId,
					attemptOwner: input.attemptOwner,
				},
				authorization,
				current,
				installation: this.#installation(row),
			};
		});
	}

	/**
	 * A command whose original claim or binding no longer holds sends nothing.
	 * A pending compensation revoke keeps its original key and receipt as
	 * unknown for the Connection owner instead of a rejected command beside a
	 * still-pending installation.
	 */
	async #claimLost(tx: Transaction, commandId: string, command: string) {
		if (command === "revoke") {
			const [lost] = await tx.execute(sql`
				update platform.connection_installation_commands set status='unknown', updated_at=clock_timestamp()
				where id=${commandId} and status='pending' and attempt_id is null
				returning authorization_id
			`);
			if (lost)
				await tx.execute(sql`
					update platform.connection_manual_installations set revoke_state='unknown', revision=revision+1,
						updated_at=clock_timestamp()
					where authorization_id=${lost.authorization_id as string} and revoke_state='pending'
				`);
			return null;
		}
		await tx.execute(sql`
			update platform.connection_installation_commands set status='rejected', updated_at=clock_timestamp()
			where id=${commandId} and status='pending'
		`);
		return null;
	}

	async #sending(
		tx: Transaction,
		input: {
			commandId: string;
			attemptId: string;
			attemptOwner: string;
			authorizationId: string;
		},
		command: ManualCommand | ConfirmPhaseCommand,
		allowReservedPrepare = false,
		includeExpired = false,
	) {
		const [row] = await tx.execute(sql`
			select id, authorization_id, delivery_digest, attempt_expires_at > clock_timestamp() as live
			from platform.connection_installation_commands
			where id=${input.commandId} and command=${command} and authorization_id=${input.authorizationId}
				and (status='sending' or (${allowReservedPrepare} and command='prepare' and status='pending'))
				and attempt_id=${input.attemptId} and attempt_owner=${input.attemptOwner}
			for update
		`);
		return row && (includeExpired || row.live === true) ? row : undefined;
	}

	/**
	 * Fixes the template, registration key and supply attempt in the original
	 * installation transaction, then returns the association ciphertext for the
	 * Worker keyring. Ciphertext is issued only for the first delivery.
	 */
	async fixSupply(input: {
		readonly commandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly command:
			| "prepare"
			| "status"
			| "revoke"
			| "begin"
			| "begin_status";
		readonly template: ConnectionRegistrationTemplateV1;
		readonly registrationKey: string;
		readonly supplyAttemptId: string;
	}): Promise<{
		readonly ciphertext: unknown;
		readonly binding: {
			readonly agentId: string;
			readonly ownerId: string;
			readonly associationRevision: number;
		};
	} | null> {
		const template = ConnectionRegistrationTemplateV1Schema.parse(
			input.template,
		);
		const keyHash = connectionRegistrationKeyHashV1(input.registrationKey);
		return this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, template.authorizationId);
			if (
				!(await this.#sending(
					tx,
					{ ...input, authorizationId: template.authorizationId },
					input.command,
					true,
				))
			)
				return null;
			if (row?.live !== true) return null;
			const authorization = this.#authorization(row);
			const current = row.associationLocked
				? await this.#facts(
						tx,
						authorization.principal.id,
						authorization.reference.executionId,
					)
				: null;
			if (
				!current ||
				current.claim.owner !== input.attemptOwner ||
				!manualTemplateMatchesCurrentV1(
					this.#policy,
					template,
					authorization,
					current,
					keyHash,
				)
			)
				return null;
			const digest = connectionRegistrationTemplateDigestV1(template);
			if (
				input.command !== "prepare" ||
				row.template !== null ||
				row.supply_state !== "pending" ||
				row.registration_state !== "pending"
			)
				return null;
			// Recheck the attempt, authorization and original claim after the directory read.
			const fixed = await tx.execute(sql`
					update platform.connection_manual_installations m
					set template=${JSON.stringify(template)}::jsonb, template_digest=${digest},
						registration_key=${input.registrationKey}, registration_key_hash=${keyHash},
						supply_attempt_id=${input.supplyAttemptId}, supply_state='sending',
						revision=m.revision+1, updated_at=clock_timestamp()
					from platform.connection_installation_commands c, platform.connection_installation_authorizations a
					where m.authorization_id=${template.authorizationId} and m.template is null
						and c.id=${input.commandId} and c.authorization_id=m.authorization_id
						and c.command='prepare' and c.status='pending' and c.attempt_id=${input.attemptId}
						and c.attempt_owner=${input.attemptOwner} and c.attempt_expires_at > clock_timestamp()
						and a.id=m.authorization_id and a.expires_at > clock_timestamp()
						and ${originalClaimHolds(template.reference, template.claim)}
					returning m.authorization_id
				`);
			if (fixed.length !== 1) return null;
			const [association] = await tx.execute(sql`
				select credential_ciphertext, owner_id, association_revision
				from platform.connection_manual_associations
				where agent_id=${current.reference.agentId}
					and association_revision=${template.association.revision}
					and connection_agent_id=${template.association.connectionAgentId}
				for share
			`);
			if (!association) return null;
			return {
				ciphertext: association.credential_ciphertext,
				binding: {
					agentId: current.reference.agentId,
					ownerId: association.owner_id as string,
					associationRevision: Number(association.association_revision),
				},
			};
		});
	}

	/** Records the supply delivery outcome of the same fixed attempt only. */
	async settleSupply(input: {
		readonly commandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly command:
			| "prepare"
			| "status"
			| "revoke"
			| "begin"
			| "begin_status";
		readonly authorizationId: string;
		readonly supplyAttemptId: string;
		readonly outcome: "confirmed" | "unknown";
	}): Promise<boolean> {
		return this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, input.authorizationId);
			if (!row) return false;
			if (
				input.command !== "prepare" ||
				!(await this.#sending(tx, input, "prepare", true, true))
			)
				return false;
			// The supply was already sent: a late or unbound outcome keeps the original key as unknown.
			const [updated] = await tx.execute(sql`
				update platform.connection_manual_installations m
				set supply_state = case when ${row.associationLocked}
						and c.attempt_expires_at > clock_timestamp() and a.expires_at > clock_timestamp()
						and ${templateClaimHolds(row.template)}
					then ${input.outcome} else 'unknown' end,
					revision = m.revision + 1, updated_at = clock_timestamp()
				from platform.connection_installation_commands c, platform.connection_installation_authorizations a
				where m.authorization_id=${input.authorizationId} and m.supply_attempt_id=${input.supplyAttemptId}
					and m.supply_state = 'sending' and m.registration_state = 'pending'
					and c.id=${input.commandId} and c.authorization_id=m.authorization_id and a.id=m.authorization_id
				returning m.supply_state
			`);
			if (!updated) return false;
			if (updated.supply_state === "unknown")
				await this.#finishCommand(tx, input.commandId, "unknown");
			return updated.supply_state === input.outcome;
		});
	}

	/** Reopens only a prepare that provably never entered sending. */
	async recoverSupply(input: {
		readonly commandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly authorizationId: string;
		readonly supplyAttemptId: string;
		readonly confirmed: boolean;
	}): Promise<void> {
		await this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, input.authorizationId);
			const status = await this.#sending(tx, input, "status", false, true);
			if (
				!status?.delivery_digest ||
				row?.live !== true ||
				row.status !== "preparing" ||
				row.registration_state !== "pending" ||
				row.supply_state !== "unknown" ||
				row.supply_attempt_id !== input.supplyAttemptId
			)
				return;
			const authorization = this.#authorization(row);
			const current = row.associationLocked
				? await this.#facts(
						tx,
						authorization.principal.id,
						authorization.reference.executionId,
					)
				: null;
			if (
				status.live !== true ||
				!input.confirmed ||
				!current ||
				current.claim.owner !== input.attemptOwner ||
				!manualTemplateMatchesCurrentV1(
					this.#policy,
					ConnectionRegistrationTemplateV1Schema.parse(row.template),
					authorization,
					current,
					row.registration_key_hash as string,
				)
			) {
				await this.#finishCommand(tx, input.commandId, "unknown");
				return;
			}
			const originals = await tx.execute(sql`
				select id from platform.connection_installation_commands
				where authorization_id=${input.authorizationId} and command='prepare'
					and status='unknown' and delivery_digest is null
				for update
			`);
			const [original] = originals;
			if (originals.length !== 1 || !original) {
				await this.#finishCommand(tx, input.commandId, "unknown");
				return;
			}
			// Both commands are locked. Reopen prepare only if the original status is still live.
			const reopened = await tx.execute(sql`
				update platform.connection_installation_commands p
				set status='pending', attempt_id=null, attempt_owner=null,
					attempt_expires_at=null, updated_at=clock_timestamp()
				from platform.connection_installation_commands c
				join platform.connection_installation_authorizations a on a.id=c.authorization_id
				where p.id=${original.id as string} and p.authorization_id=a.id
					and c.id=${input.commandId} and c.status='sending'
					and c.attempt_id=${input.attemptId} and c.attempt_owner=${input.attemptOwner}
					and c.attempt_expires_at > clock_timestamp() and a.expires_at > clock_timestamp()
					and ${templateClaimHolds(row.template)}
				returning p.id
			`);
			if (reopened.length !== 1) {
				await this.#finishCommand(tx, input.commandId, "unknown");
				return;
			}
			await tx.execute(sql`
				update platform.connection_manual_installations
				set supply_state='confirmed', revision=revision+1, updated_at=clock_timestamp()
				where authorization_id=${input.authorizationId}
			`);
			await tx.execute(sql`
				update platform.connection_installation_commands set status='completed', updated_at=clock_timestamp()
				where id=${input.commandId}
			`);
		});
	}

	/**
	 * Persists the exact signed wire digest and, for prepare, registration
	 * `sending` before any byte is sent; the Host's readback compares it.
	 */
	async commitDelivery(input: {
		readonly commandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly command: ManualCommand | ConfirmPhaseCommand;
		readonly authorizationId: string;
		readonly deliveryDigest: string;
	}): Promise<boolean> {
		if (!/^[a-f0-9]{64}$/.test(input.deliveryDigest)) return false;
		return this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, input.authorizationId);
			const command = await this.#sending(tx, input, input.command, true);
			if (!command || command.delivery_digest !== null) return false;
			const supplyStatus =
				input.command === "status" &&
				row?.supply_state === "unknown" &&
				row.registration_state === "pending" &&
				row.status === "preparing";
			if (row?.supply_state !== "confirmed" && !supplyStatus) return false;
			if (
				input.command === "prepare" &&
				(row.registration_state !== "pending" || row.status !== "preparing")
			)
				return false;
			if (!row.associationLocked) return false;
			// Commit point: attempt, authorization (revoke uses its own attempt) and original claim.
			const committed = await tx.execute(sql`
				update platform.connection_installation_commands c set status='sending', delivery_digest=${input.deliveryDigest},
					updated_at=clock_timestamp()
				from platform.connection_installation_authorizations a
				where c.id=${input.commandId} and c.delivery_digest is null
					and c.attempt_id=${input.attemptId} and c.attempt_owner=${input.attemptOwner}
					and c.attempt_expires_at > clock_timestamp()
					and a.id=c.authorization_id and (c.command='revoke' or a.expires_at > clock_timestamp())
					and ${templateClaimHolds(row.template)}
				returning c.id
			`);
			if (committed.length !== 1) return false;
			if (input.command === "prepare")
				await tx.execute(sql`
					update platform.connection_manual_installations set registration_state='sending',
						revision=revision+1, updated_at=clock_timestamp()
					where authorization_id=${input.authorizationId} and registration_state='pending'
				`);
			return true;
		});
	}

	/**
	 * §13.5.6 exception confirm: final-write predicate of a phase. The phase and
	 * its logical confirm are sending for the same attempt, the original
	 * Execution is processing, the authorization is confirmed and live, the
	 * installation is open with its descriptor, and the original claim, fence and
	 * the exception's `notAfter` hold at the database clock.
	 */
	#phaseHolds(input: {
		readonly confirmCommandId: string;
		readonly phaseCommandId: string;
		readonly phase: ConfirmPhaseCommand;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly authorizationId: string;
		readonly template: ConnectionRegistrationTemplateV1;
	}) {
		return sql`exists (select 1 from platform.connection_installation_commands p
			join platform.connection_installation_commands c on c.id=${input.confirmCommandId}
				and c.authorization_id=p.authorization_id
			join platform.connection_installation_authorizations a on a.id=p.authorization_id
			join platform.connection_manual_installations m on m.authorization_id=a.id
			join platform.conversation_executions e on e.execution_id=a.execution_id
			where p.id=${input.phaseCommandId} and p.command=${input.phase} and p.status='sending'
				and p.attempt_id=${input.attemptId} and p.attempt_owner=${input.attemptOwner}
				and p.attempt_expires_at > clock_timestamp() and p.delivery_digest is not null
				and c.command='confirm' and c.status='sending'
				and c.attempt_id=${input.attemptId} and c.attempt_owner=${input.attemptOwner}
				and c.attempt_expires_at > clock_timestamp()
				and a.id=${input.authorizationId} and a.status='confirmed' and a.expires_at > clock_timestamp()
				and e.status='processing'
				and m.registration_state='registered' and m.supply_state='confirmed'
				and m.revoke_state='not_required' and m.descriptor_digest is not null
				and ${connectionManualExceptionLiveV1(this.#policy)}
				and ${originalClaimHolds(input.template.reference, input.template.claim)})`;
	}

	/**
	 * Opens one exception confirm phase as `sending` under the logical confirm's
	 * attempt (§13.5.6). `binding_readback` comes first; `exchange` only after
	 * this confirm's first-pin receipt committed and its pin is still active.
	 * Neither phase is ever reopened, re-keyed or moved to another claim.
	 */
	async openConfirmPhase(input: {
		readonly confirmCommandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly authorizationId: string;
		readonly phase: ConfirmPhaseCommand;
	}): Promise<{
		readonly phaseCommandId: string;
		readonly requestDigest: string;
		readonly receipt?: {
			readonly id: string;
			readonly revision: number;
			readonly candidateDigest: string;
		};
	} | null> {
		return this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, input.authorizationId);
			if (!row?.associationLocked || !row.template) return null;
			const template = ConnectionRegistrationTemplateV1Schema.parse(
				row.template,
			);
			const [receipt] =
				input.phase === "confirm_exchange"
					? await tx.execute(sql`
						select r.id, r.revision, r.candidate_digest from platform.connection_principal_pin_receipts r
						join platform.connection_principal_pins pin on pin.id=r.pin_id and pin.revision=r.pin_revision
							and pin.released_at is null and ${connectionPrincipalPinPermitsSql("pin", this.#policy)}
						join platform.connection_installation_commands b on b.authorization_id=r.authorization_id
							and b.id=r.phase_command_id and b.command='confirm_binding_readback' and b.status='completed'
						where r.confirm_command_id=${input.confirmCommandId} and r.authorization_id=${input.authorizationId}
							and r.attempt_id=${input.attemptId} and r.claim_owner=${input.attemptOwner}
							and r.claim_fence=${template.claim.fence} and r.expires_at > clock_timestamp()`)
					: [undefined];
			if (input.phase === "confirm_exchange" && !receipt) return null;
			const phaseCommandId = randomUUID();
			const requestDigest = sha256(
				JSON.stringify([
					input.phase,
					input.confirmCommandId,
					input.authorizationId,
					receipt?.id ?? null,
					receipt?.candidate_digest ?? null,
				]),
			);
			// The phase row is inserted only while the logical confirm and every
			// binding still hold; a phase that ever existed is never opened again.
			const opened = await tx.execute(sql`
				insert into platform.connection_installation_commands
					(id, authorization_id, command, idempotency_key, request_digest, status,
					 attempt_id, attempt_owner, attempt_expires_at)
				select ${phaseCommandId}, c.authorization_id, ${input.phase},
					${`confirm-phase:${input.confirmCommandId}:${input.phase}`}, ${requestDigest}, 'sending',
					c.attempt_id, c.attempt_owner, c.attempt_expires_at
				from platform.connection_installation_commands c
				join platform.connection_installation_authorizations a on a.id=c.authorization_id
				join platform.connection_manual_installations m on m.authorization_id=a.id
				join platform.conversation_executions e on e.execution_id=a.execution_id
				where c.id=${input.confirmCommandId} and c.authorization_id=${input.authorizationId}
					and c.command='confirm' and c.status='sending'
					and c.attempt_id=${input.attemptId} and c.attempt_owner=${input.attemptOwner}
					and c.attempt_expires_at > clock_timestamp()
					and a.status='confirmed' and a.expires_at > clock_timestamp() and e.status='processing'
					and m.registration_state='registered' and m.supply_state='confirmed'
					and m.revoke_state='not_required' and m.descriptor_digest is not null
					and ${connectionManualExceptionLiveV1(this.#policy)}
					and ${originalClaimHolds(template.reference, template.claim)}
					and not exists (select 1 from platform.connection_installation_commands prior
						where prior.authorization_id=c.authorization_id
							and prior.idempotency_key=${`confirm-phase:${input.confirmCommandId}:${input.phase}`})
					and (${input.phase === "confirm_binding_readback"} or exists (
						select 1 from platform.connection_installation_commands b
						where b.authorization_id=c.authorization_id and b.command='confirm_binding_readback'
							and b.idempotency_key=${`confirm-phase:${input.confirmCommandId}:confirm_binding_readback`}
							and b.status='completed'))
				on conflict (authorization_id, command, idempotency_key) do nothing
				returning id
			`);
			if (opened.length !== 1) return null;
			return {
				phaseCommandId,
				requestDigest,
				...(receipt
					? {
							receipt: {
								id: receipt.id as string,
								revision: Number(receipt.revision),
								candidateDigest: receipt.candidate_digest as string,
							},
						}
					: {}),
			};
		});
	}

	/**
	 * §13.5.6 exception confirm, step 2: the Worker commits the first pin from
	 * the Host's phase-1 candidate. One Store CAS checks the candidate against
	 * this installation, the per-issuer uniqueness (pins and Principals confirmed
	 * outside the exception), the user's existing pin and the capacity, then
	 * saves the pin (or reuses the same one), the phase result and this confirm's
	 * own commit receipt. A refused candidate closes the installation and revokes
	 * its original key; a write whose bindings no longer hold commits nothing.
	 */
	async commitConfirmPin(input: {
		readonly confirmCommandId: string;
		readonly phaseCommandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly authorizationId: string;
		readonly candidate: ConnectionManualConfirmCandidateV1;
	}): Promise<
		| {
				readonly outcome: "pinned";
				readonly receipt: {
					readonly id: string;
					readonly revision: number;
					readonly candidateDigest: string;
				};
		  }
		| { readonly outcome: "rejected" | "unknown" | "stale" }
	> {
		const parsed = ConnectionManualConfirmCandidateV1Schema.safeParse(
			input.candidate,
		);
		// Rolls the whole CAS back; #transaction rethrows Connection errors as-is.
		class Uncommitted extends ConnectionInstallationErrorV1 {
			constructor() {
				super("unavailable");
			}
		}
		const uncommitted = () => new Uncommitted();
		try {
			return await this.#transaction(async (tx) => {
				const row = await this.#lockInstallation(tx, input.authorizationId);
				if (!row?.associationLocked || !row.template)
					return { outcome: "stale" };
				const template = ConnectionRegistrationTemplateV1Schema.parse(
					row.template,
				);
				const phase = await this.#sending(
					tx,
					{
						commandId: input.phaseCommandId,
						attemptId: input.attemptId,
						attemptOwner: input.attemptOwner,
						authorizationId: input.authorizationId,
					},
					"confirm_binding_readback",
				);
				if (!phase?.delivery_digest) return { outcome: "stale" };
				const authorization = this.#authorization(row);
				// Core recheck of the original user and Agent use, after which every
				// write below re-evaluates the bindings at the database clock.
				const current = await this.#facts(
					tx,
					authorization.principal.id,
					authorization.reference.executionId,
				);
				const holds = this.#phaseHolds({
					...input,
					phase: "confirm_binding_readback",
					template,
				});
				if (
					!current ||
					current.claim.owner !== input.attemptOwner ||
					!manualTemplateMatchesCurrentV1(
						this.#policy,
						template,
						authorization,
						current,
						row.registration_key_hash as string,
					)
				)
					return { outcome: "unknown" };
				const candidate = parsed.success ? parsed.data : undefined;
				const fixedReceipt = row.receipt
					? ConnectionRegistrationReceiptV1Schema.parse(row.receipt)
					: undefined;
				const exception = this.#policy.dynamic.principalMapping;
				const issuer = this.#policy.access.system.issuer;
				const matches =
					candidate !== undefined &&
					isDeepStrictEqual(candidate.principal, authorization.principal) &&
					isDeepStrictEqual(candidate.reference, authorization.reference) &&
					candidate.authorizationId === authorization.authorizationId &&
					candidate.confirmationRevision ===
						authorization.confirmationRevision &&
					candidate.association.connectionAgentId === row.connection_agent_id &&
					candidate.association.revision === Number(row.association_revision) &&
					candidate.confirm.commandId === input.confirmCommandId &&
					candidate.confirm.phaseCommandId === input.phaseCommandId &&
					candidate.confirm.requestDigest === phase.delivery_digest &&
					isDeepStrictEqual(candidate.target, template.target) &&
					candidate.descriptorDigest === row.descriptor_digest &&
					isDeepStrictEqual(candidate.supply, template.supply) &&
					isDeepStrictEqual(candidate.exceptionPolicy, exception.policy) &&
					candidate.verified.issuer === issuer &&
					fixedReceipt !== undefined &&
					candidate.verified.registrationKey === row.registration_key &&
					candidate.verified.clientId === fixedReceipt.clientId &&
					candidate.verified.consumerId === fixedReceipt.consumerId &&
					candidate.verified.instanceId === fixedReceipt.instanceId &&
					candidate.verified.redirectUri ===
						template.registration.redirectUri &&
					candidate.verified.resource === template.registration.resource;
				if (!candidate || !matches) {
					if (!(await this.#rejectConfirm(tx, input, holds)))
						throw uncommitted();
					return { outcome: "rejected" };
				}
				const principalId = candidate.verified.principalId;
				const userId = authorization.principal.id;
				// Serialize every pin decision for this Principal, this user and the
				// exception's capacity, in one fixed order. The capacity lock is taken on
				// every decision because whether this is a first pin is only known
				// under the user lock; without it two users' first pins could both
				// count the same free slot under READ COMMITTED. It spans every issuer
				// because `maximumPinnedPrincipals` bounds the total count below.
				for (const scope of [
					["connection-principal-pin", "capacity"],
					["connection-principal-pin", issuer, "principal", principalId],
					["connection-principal-pin", issuer, "user", userId],
				].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
					await tx.execute(
						sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(scope)}, 0))`,
					);
				const pins = await tx.execute(sql`
					select id, revision, principal_id, user_id,
						${connectionPrincipalPinPermitsSql("connection_principal_pins", this.#policy)} as permits
					from platform.connection_principal_pins
					where issuer=${issuer} and released_at is null
						and (principal_id=${principalId} or user_id=${userId})
					for update
				`);
				const own = pins.find((pin) => pin.user_id === userId);
				const holder = pins.find(
					(pin) => pin.principal_id === principalId && pin.user_id !== userId,
				);
				const conflict =
					holder !== undefined ||
					(own !== undefined && own.principal_id !== principalId) ||
					this.#policy.confirmedPrincipals.some(
						(entry) =>
							entry.issuer === issuer &&
							entry.principalId === principalId &&
							entry.userId !== userId,
					);
				// §13.5.1 item 4: a second user's verified readback on a held
				// `principalId` suspends the holder's new permits and restarts its
				// verification window, under this confirm's original claim and fence;
				// the holder resumes only on a consistent verification record.
				if (holder) {
					const suspended = await tx.execute(sql`
						update platform.connection_principal_pins
						set suspended_at=coalesce(suspended_at, clock_timestamp()), verification_state='pending',
							verified_at=null, verification_actor_id=null, verification_reference=null,
							verification_deadline=${connectionPrincipalPinDeadlineSql(this.#policy)},
							overdue_at=null, rule_revision=rule_revision+1
						where id=${holder.id as string} and released_at is null and release_requested_at is null
							and ${holds}
						returning id
					`);
					if (suspended.length === 1)
						await insertConnectionPrincipalPinAuditV1(tx, {
							action: "suspended",
							pinId: holder.id as string,
							actor: { type: "system", id: "platform-worker" },
							outcome: "succeeded",
							details: { userId: holder.user_id, conflictingUserId: userId },
						});
				}
				const [capacity] = own
					? [{ full: false }]
					: await tx.execute(sql`
						select count(*) >= ${exception.maximumPinnedPrincipals} as full
						from platform.connection_principal_pins where released_at is null`);
				// An own pin that no longer backs permits (overdue, inconsistent, being
				// released or suspended, or past `notAfter`) accepts no new installation.
				if (
					conflict ||
					capacity?.full === true ||
					(own !== undefined && own.permits !== true)
				) {
					if (!(await this.#rejectConfirm(tx, input, holds)))
						throw uncommitted();
					return { outcome: "rejected" };
				}
				const pinId = (own?.id as string | undefined) ?? randomUUID();
				if (!own) {
					const inserted = await tx.execute(sql`
						insert into platform.connection_principal_pins
							(id, issuer, principal_id, user_id, policy_ref, policy_revision, verification_deadline)
						select ${pinId}, ${issuer}, ${principalId}, ${userId},
							${exception.policy.ref}, ${exception.policy.revision},
							${connectionPrincipalPinDeadlineSql(this.#policy)}
						where ${holds}
						returning id
					`);
					if (inserted.length !== 1) throw uncommitted();
				}
				const receiptId = randomUUID();
				const candidateDigest =
					connectionManualConfirmCandidateDigestV1(candidate);
				const receipt = await tx.execute(sql`
					insert into platform.connection_principal_pin_receipts
						(id, authorization_id, confirm_command_id, phase_command_id, pin_id, pin_revision,
						 candidate, candidate_digest, claim_owner, claim_fence, attempt_id, expires_at)
					select ${receiptId}, a.id, ${input.confirmCommandId}, ${input.phaseCommandId}, pin.id, pin.revision,
						${JSON.stringify(candidate)}::jsonb, ${candidateDigest}, ${input.attemptOwner},
						${template.claim.fence}, ${input.attemptId}, a.expires_at
					from platform.connection_installation_authorizations a
					join platform.connection_principal_pins pin on pin.id=${pinId} and pin.released_at is null
						and pin.issuer=${issuer} and pin.principal_id=${principalId} and pin.user_id=${userId}
					where a.id=${input.authorizationId} and ${holds}
					returning id, revision
				`);
				const done = await tx.execute(sql`
					update platform.connection_installation_commands set status='completed', updated_at=clock_timestamp()
					where id=${input.phaseCommandId} and status='sending' and ${holds}
					returning id
				`);
				if (receipt.length !== 1 || done.length !== 1) throw uncommitted();
				return {
					outcome: "pinned",
					receipt: {
						id: receiptId,
						revision: Number(receipt[0]?.revision),
						candidateDigest,
					},
				};
			});
		} catch (error) {
			// Nothing of this CAS committed: no partial pin, phase result or receipt.
			if (error instanceof Uncommitted) return { outcome: "unknown" };
			throw error;
		}
	}

	/**
	 * Settles exception confirm phase 1 without a candidate. `rejected` means the
	 * Host's EP-1060 readback failed the exception gates (§13.5.1 item 2): no
	 * exchange, close and revoke the original key. Anything else, including a
	 * lost response, keeps the phase and the logical confirm unknown; neither is
	 * resent automatically.
	 */
	async settleConfirmPhase(input: {
		readonly confirmCommandId: string;
		readonly phaseCommandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly authorizationId: string;
		readonly outcome: "rejected" | "unknown";
	}): Promise<"rejected" | "unknown" | "stale"> {
		return this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, input.authorizationId);
			if (!row?.template) return "stale";
			const template = ConnectionRegistrationTemplateV1Schema.parse(
				row.template,
			);
			if (
				input.outcome === "rejected" &&
				(await this.#rejectConfirm(
					tx,
					input,
					this.#phaseHolds({
						...input,
						phase: "confirm_binding_readback",
						template,
					}),
				))
			)
				return "rejected";
			const settled = await tx.execute(sql`
				update platform.connection_installation_commands set status='unknown', updated_at=clock_timestamp()
				where id in (${input.phaseCommandId}, ${input.confirmCommandId})
					and authorization_id=${input.authorizationId} and status='sending'
					and attempt_id=${input.attemptId} and attempt_owner=${input.attemptOwner}
				returning id
			`);
			return settled.length === 2 ? "unknown" : "stale";
		});
	}

	/** Refused principal (§13.5.1 item 2): no exchange; close and revoke the original key. */
	async #rejectConfirm(
		tx: Transaction,
		input: {
			readonly confirmCommandId: string;
			readonly phaseCommandId: string;
			readonly authorizationId: string;
		},
		holds: ReturnType<typeof sql>,
	) {
		const closed = await tx.execute(sql`
			update platform.connection_installation_commands set status='rejected', updated_at=clock_timestamp()
			where id in (${input.phaseCommandId}, ${input.confirmCommandId}) and status='sending' and ${holds}
			returning id
		`);
		if (closed.length !== 2) return false;
		await tx.execute(sql`
			update platform.connection_installation_authorizations set status='revoked', revision=revision+1,
				updated_at=clock_timestamp() where id=${input.authorizationId} and status='confirmed'
		`);
		await tx.execute(sql`
			update platform.connection_manual_installations set revoke_state='pending', revision=revision+1,
				updated_at=clock_timestamp() where authorization_id=${input.authorizationId} and revoke_state='not_required'
		`);
		await tx.execute(sql`
			insert into platform.connection_installation_commands
				(id, authorization_id, command, idempotency_key, request_digest, status)
			select ${randomUUID()}, a.id, 'revoke', ${`manual-revoke:${input.authorizationId}`},
				${sha256(JSON.stringify(["revoke", "principal-unverified", input.authorizationId]))}, 'pending'
			from platform.connection_installation_authorizations a where a.id=${input.authorizationId}
			on conflict (authorization_id, command, idempotency_key) do nothing
		`);
		return true;
	}

	async #finishCommand(
		tx: Transaction,
		commandId: string,
		status: "completed" | "unknown" | "rejected",
	) {
		await tx.execute(sql`
			update platform.connection_installation_commands
			set status = case when attempt_expires_at > clock_timestamp() then ${status} else 'unknown' end,
				updated_at = clock_timestamp()
			where id = ${commandId} and (status='sending' or (command='prepare' and status='pending' and attempt_id is not null))
		`);
	}

	/**
	 * Receipt CAS (§13.5.7): the actual EP-1060 receipt must deep-match the
	 * original template and key while the original user, Agent, association,
	 * Host/Pod, generation, claim and fence still hold. Only then is the full
	 * configuration bound and the first begin enqueued. Late, replaced or
	 * mismatching receipts stay unknown and never open a link.
	 */
	async settleRegistration(input: {
		readonly commandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly command: "prepare" | "status";
		readonly authorizationId: string;
		readonly response?: ConnectionInstallCommandResponseV1;
	}): Promise<"registered" | "unknown" | "failed" | "rejected" | "stale"> {
		const response =
			input.response === undefined
				? undefined
				: ConnectionInstallCommandResponseV1Schema.parse(input.response);
		return this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, input.authorizationId);
			const command = await this.#sending(tx, input, input.command, true, true);
			if (!command) return "stale";
			if (!row) return "stale";
			if (
				response?.outcome !== "rejected" &&
				(!row.template || !row.registration_key)
			)
				return "stale";
			const expectedState = input.command === "prepare" ? "sending" : "unknown";
			const unknown = async (verified?: ConnectionRegistrationReceiptV1) => {
				// A verified late receipt is kept beside the original key for exact reconciliation.
				await tx.execute(sql`
					update platform.connection_manual_installations
					set registration_state = case when registration_state in ('sending','unknown') then 'unknown' else registration_state end,
						receipt = case when registration_state in ('sending','unknown')
							then coalesce(${verified ? JSON.stringify(verified) : null}::jsonb, receipt) else receipt end,
						revision = revision + 1, updated_at = clock_timestamp()
					where authorization_id = ${input.authorizationId}
				`);
				await this.#finishCommand(tx, input.commandId, "unknown");
				return "unknown" as const;
			};
			if (command.live !== true || row.live !== true) return unknown();
			if (
				!response ||
				response.outcome === "unknown" ||
				response.outcome === "revoked" ||
				response.outcome === "supply_confirmed"
			)
				return unknown();
			if (response.outcome === "rejected") {
				// Definite: the Host sent nothing to Connection for this command.
				if (
					input.command === "prepare" &&
					["pending", "sending"].includes(row.registration_state as string)
				) {
					await tx.execute(sql`
						update platform.connection_manual_installations set registration_state='failed',
							supply_state=case when supply_state='sending' then 'closed' else supply_state end,
							revision=revision+1, updated_at=clock_timestamp()
						where authorization_id=${input.authorizationId} and registration_state in ('pending','sending')
					`);
					await this.#finishCommand(tx, input.commandId, "rejected");
					return "failed";
				}
				await this.#finishCommand(tx, input.commandId, "rejected");
				return "rejected";
			}
			const template = ConnectionRegistrationTemplateV1Schema.parse(
				row.template,
			);
			const receipt = matchConnectionRegistrationReceiptV1(
				response.receipt,
				template,
				row.registration_key as string,
			);
			await this.#lockConsumerSettlement(tx, row);
			const authorization = this.#authorization(row);
			const current = row.associationLocked
				? await this.#facts(
						tx,
						authorization.principal.id,
						authorization.reference.executionId,
					)
				: null;
			const [deadline] = await tx.execute(sql`
				select c.attempt_expires_at > clock_timestamp() and a.expires_at > clock_timestamp()
					and ${originalClaimHolds(template.reference, template.claim)} as live,
					${connectionManualExceptionLiveV1(this.#policy)} as exception
				from platform.connection_installation_commands c
				join platform.connection_installation_authorizations a on a.id=c.authorization_id
				where c.id=${input.commandId}
			`);
			if (deadline?.live !== true) return unknown(receipt);
			// Past `notAfter` the exception binds no new installation; the registered
			// client of this attempt is compensated with its original key.
			const bindable =
				deadline.exception === true &&
				receipt !== undefined &&
				current !== null &&
				row.live === true &&
				row.status === "preparing" &&
				row.supply_state === "confirmed" &&
				row.registration_state === expectedState &&
				command.delivery_digest !== null &&
				current.claim.owner === input.attemptOwner &&
				manualTemplateMatchesCurrentV1(
					this.#policy,
					template,
					authorization,
					current,
					row.registration_key_hash as string,
				) &&
				(await this.#consumerConsistent(tx, row, receipt));
			if (!receipt || !bindable) {
				if (
					receipt &&
					current &&
					current.claim.owner === input.attemptOwner &&
					row.supply_state === "confirmed" &&
					manualTemplateMatchesCurrentV1(
						this.#policy,
						template,
						authorization,
						current,
						row.registration_key_hash as string,
					)
				) {
					// Compensation for this originating attempt only: our key now names
					// a client we cannot bind; close locally, then DELETE the same key.
					// It commits at the same attempt, authorization and claim check.
					const settled = await tx.execute(sql`
						update platform.connection_installation_commands c
						set status='completed', updated_at=clock_timestamp()
						from platform.connection_installation_authorizations a
						where c.id=${input.commandId} and a.id=c.authorization_id
							and c.status='sending' and c.attempt_id=${input.attemptId} and c.attempt_owner=${input.attemptOwner}
							and c.attempt_expires_at > clock_timestamp() and a.expires_at > clock_timestamp()
							and ${originalClaimHolds(template.reference, template.claim)}
						returning c.id
					`);
					if (settled.length !== 1) return unknown(receipt);
					await this.#closeForCompensation(tx, row, receipt);
					return "unknown";
				}
				return unknown(receipt);
			}
			const configuration = connectionManualInstallConfigurationV1({
				access: this.#policy.access,
				template,
				receipt,
			});
			// The first begin fixes this descriptor. No user has a pinned principalId
			// before the exception's first-pin CAS exists, so each install is a first one.
			const descriptor = connectionManualInstallDescriptorV1({
				approval: this.#policy.dynamic,
				template,
				receipt,
				configuration,
				pinnedPrincipalId: null,
			});
			const scope = {
				agentId: template.reference.agentId,
				sandboxId: template.target.sandboxId,
				podUid: template.target.podUid,
				sessionGeneration: template.target.sessionGeneration,
				configFingerprint: configuration.configFingerprint,
				source: configuration.source,
				oauthConfiguration: {
					ref: configuration.ref,
					revision: configuration.revision,
				},
			};
			const binding = {
				principal: authorization.principal,
				reference: authorization.reference,
				scope,
			};
			ConnectionInstallationAuthorizationV1Schema.parse({
				schemaVersion: 1,
				authorizationId: authorization.authorizationId,
				confirmationRevision: authorization.confirmationRevision,
				...binding,
				status: "awaiting_confirmation",
				expiresAt: authorization.expiresAt,
			});
			const accepted = await tx.execute(sql`
				update platform.connection_installation_commands c
				set status='completed', updated_at=clock_timestamp()
				from platform.connection_installation_authorizations a
				where c.id=${input.commandId} and a.id=c.authorization_id
					and c.status='sending' and c.attempt_id=${input.attemptId} and c.attempt_owner=${input.attemptOwner}
					and c.attempt_expires_at > clock_timestamp()
					and a.expires_at > clock_timestamp()
					and ${connectionManualExceptionLiveV1(this.#policy)}
					and ${originalClaimHolds(template.reference, template.claim)}
				returning c.id
			`);
			if (accepted.length !== 1) return unknown(receipt);
			await tx.execute(sql`
				update platform.connection_manual_installations
				set registration_state='registered', receipt=${JSON.stringify(receipt)}::jsonb,
					consumer_id=${receipt.consumerId}, client_id=${receipt.clientId}, instance_id=${receipt.instanceId},
					configuration=${JSON.stringify(configuration)}::jsonb,
					descriptor=${JSON.stringify(descriptor)}::jsonb,
					descriptor_digest=${connectionManualInstallDescriptorDigestV1(descriptor)},
					revision=revision+1, updated_at=clock_timestamp()
				where authorization_id=${input.authorizationId} and registration_state=${expectedState}
			`);
			await tx.execute(sql`
				update platform.connection_installation_authorizations
				set status='awaiting_confirmation', binding=${JSON.stringify(binding)}::jsonb,
					revision=revision+1, updated_at=clock_timestamp()
				where id=${input.authorizationId} and status='preparing'
			`);
			await tx.execute(sql`
				insert into platform.connection_installation_commands
					(id, authorization_id, command, idempotency_key, request_digest, status)
				values (${randomUUID()}, ${input.authorizationId}, 'begin',
					${`manual-first-begin:${input.authorizationId}`},
					${sha256(JSON.stringify(["begin", authorization.reference.executionId, input.authorizationId]))},
					'pending')
			`);
			return "registered";
		});
	}

	async #lockConsumerSettlement(tx: Transaction, row: Row) {
		// Hold the association-wide lock until the receipt and its next command commit.
		const lockScope = JSON.stringify([
			"connection-manual-consumer",
			row.agent_id,
			Number(row.association_revision),
		]);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${lockScope}, 0))`,
		);
	}

	/** The actual Consumer is pinned by the first verified receipt of an association. */
	async #consumerConsistent(
		tx: Transaction,
		row: Row,
		receipt: ConnectionRegistrationReceiptV1,
	) {
		const others = await tx.execute(sql`
			select distinct consumer_id from platform.connection_manual_installations
			where agent_id=${row.agent_id as string} and association_revision=${Number(row.association_revision)}
				and consumer_id is not null and authorization_id <> ${row.id as string}
		`);
		return others.every((entry) => entry.consumer_id === receipt.consumerId);
	}

	async #closeForCompensation(
		tx: Transaction,
		row: Row,
		receipt: ConnectionRegistrationReceiptV1,
	) {
		await tx.execute(sql`
			update platform.connection_manual_installations
			set registration_state='closed', receipt=${JSON.stringify(receipt)}::jsonb,
				client_id=${receipt.clientId}, instance_id=${receipt.instanceId},
				revoke_state='pending', revision=revision+1, updated_at=clock_timestamp()
			where authorization_id=${row.id as string}
		`);
		await tx.execute(sql`
			update platform.connection_installation_authorizations set status='revoked', revision=revision+1,
				updated_at=clock_timestamp() where id=${row.id as string} and status='preparing'
		`);
		await tx.execute(sql`
			insert into platform.connection_installation_commands
				(id, authorization_id, command, idempotency_key, request_digest, status)
			values (${randomUUID()}, ${row.id as string}, 'revoke', ${`manual-revoke:${row.id as string}`},
				${sha256(JSON.stringify(["revoke", row.execution_id, row.id]))}, 'pending')
			on conflict (authorization_id, command, idempotency_key) do nothing
		`);
	}

	/** DELETE of the original key only; lost responses stay unknown for the Connection owner. */
	async settleRevoke(input: {
		readonly commandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly authorizationId: string;
		readonly response?: ConnectionInstallCommandResponseV1;
	}): Promise<"revoked" | "unknown" | "stale"> {
		return this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, input.authorizationId);
			if (row?.revoke_state !== "sending") return "stale";
			if (!(await this.#sending(tx, input, "revoke", false, true)))
				return "stale";
			// Compensation applies to a closed authorization and uses its own attempt deadline
			// and the original claim and fence.
			const [settled] = await tx.execute(sql`
				with outcome as (
					update platform.connection_installation_commands
					set status=case when ${row.associationLocked && input.response?.outcome === "revoked"}
						and attempt_expires_at > clock_timestamp()
						and ${templateClaimHolds(row.template)} then 'completed' else 'unknown' end,
						updated_at=clock_timestamp()
					where id=${input.commandId} and authorization_id=${input.authorizationId} and command='revoke'
						and status='sending' and attempt_id=${input.attemptId} and attempt_owner=${input.attemptOwner}
					returning authorization_id, status
				)
				update platform.connection_manual_installations m
				set revoke_state=case when outcome.status='completed' then 'revoked' else 'unknown' end,
					supply_state='closed', revision=m.revision+1, updated_at=clock_timestamp()
				from outcome where m.authorization_id=outcome.authorization_id and m.revoke_state='sending'
				returning m.revoke_state
			`);
			if (!settled) return "stale";
			return settled.revoke_state === "revoked" ? "revoked" : "unknown";
		});
	}

	/** Bound facts the Worker needs for the first begin of a confirmed receipt CAS. */
	async firstBeginContext(input: {
		readonly commandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly authorizationId: string;
		/** `confirm` reads the same fixed facts for the logical confirm's phases. */
		readonly command: "begin" | "begin_status" | "confirm";
	}): Promise<{
		readonly template: ConnectionRegistrationTemplateV1;
		readonly registrationKey: string;
		readonly supplyAttemptId: string;
		readonly receipt: ConnectionRegistrationReceiptV1;
		readonly configuration: RuntimeOAuthConfigurationV1;
		readonly descriptor: ConnectionManualInstallDescriptorV1;
		readonly beginCommandId?: string;
	} | null> {
		return this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, input.authorizationId);
			if (!(await this.#sending(tx, input, input.command))) return null;
			if (
				row?.registration_state !== "registered" ||
				row.supply_state !== "confirmed" ||
				!row.template ||
				!row.receipt ||
				!row.configuration ||
				!row.descriptor
			)
				return null;
			const [begin] =
				input.command === "begin_status"
					? await tx.execute(sql`
						select id from platform.connection_installation_commands
						where authorization_id=${input.authorizationId} and command='begin' and status='unknown'
						order by created_at limit 1`)
					: [undefined];
			if (input.command === "begin_status" && !begin) return null;
			return {
				template: ConnectionRegistrationTemplateV1Schema.parse(row.template),
				registrationKey: row.registration_key as string,
				supplyAttemptId: row.supply_attempt_id as string,
				receipt: ConnectionRegistrationReceiptV1Schema.parse(row.receipt),
				configuration: RuntimeOAuthConfigurationV1Schema.parse(
					row.configuration,
				),
				descriptor: ConnectionManualInstallDescriptorV1Schema.parse(
					row.descriptor,
				),
				...(begin ? { beginCommandId: begin.id as string } : {}),
			};
		});
	}

	/**
	 * Persists the first begin's link and callback mapping (same format as the
	 * existing installation settle) or, for begin_status, recommits the mapping
	 * of the original consumed begin. A failed CAS keeps unknown and no link.
	 */
	async settleBegin(input: {
		readonly commandId: string;
		readonly attemptId: string;
		readonly attemptOwner: string;
		readonly command: "begin" | "begin_status";
		readonly authorizationId: string;
		readonly result?: RuntimeOAuthResponseV1;
	}): Promise<"mapped" | "unknown" | "stale"> {
		return this.#transaction(async (tx) => {
			const row = await this.#lockInstallation(tx, input.authorizationId);
			const command = await this.#sending(
				tx,
				input,
				input.command,
				false,
				true,
			);
			if (!command) return "stale";
			const result =
				input.result === undefined
					? undefined
					: RuntimeOAuthResponseV1Schema.safeParse(input.result);
			const fail = async () => {
				await this.#finishCommand(tx, input.commandId, "unknown");
				return "unknown" as const;
			};
			if (
				!row ||
				!result?.success ||
				command.live !== true ||
				command.delivery_digest === null ||
				row.live !== true ||
				!["awaiting_confirmation", "confirmed"].includes(
					row.status as string,
				) ||
				row.registration_state !== "registered" ||
				!row.configuration
			)
				return fail();
			const binding = row.binding as { callback?: unknown };
			if (binding.callback !== undefined) return fail();
			const authorization = this.#authorization(row);
			const current = row.associationLocked
				? await this.#facts(
						tx,
						authorization.principal.id,
						authorization.reference.executionId,
					)
				: null;
			const template = ConnectionRegistrationTemplateV1Schema.parse(
				row.template,
			);
			if (
				!current ||
				current.claim.owner !== input.attemptOwner ||
				!manualTemplateMatchesCurrentV1(
					this.#policy,
					template,
					authorization,
					current,
					row.registration_key_hash as string,
				)
			)
				return fail();
			const configuration = RuntimeOAuthConfigurationV1Schema.parse(
				row.configuration,
			);
			const value = result.data;
			if (
				value.authorizationId !== input.authorizationId ||
				value.phase !== "awaiting_callback" ||
				!value.authorizationUrl ||
				value.callbackStateHash !== undefined
			)
				return fail();
			// The Platform callback window never outlives the original authorization.
			const mappingExpiresAt = Math.min(
				value.expiresAt,
				authorization.expiresAt,
			);
			let state: string;
			try {
				state = parseConnectionInstallationAuthorizationRedirectV1(
					value.authorizationUrl,
					configuration,
					mappingExpiresAt,
				);
			} catch {
				return fail();
			}
			const callback = {
				stateHash: sha256(state),
				runtimeOrigin: configuration.runtimeOrigin,
				expiresAt: mappingExpiresAt,
				status: "pending",
			};
			// Commit the mapping and its command outcome at the same deadline check.
			const updated = await tx.execute(sql`
				with mapped as (
					update platform.connection_installation_authorizations a
					set binding = jsonb_set(jsonb_set(binding, '{authorizationUrl}', to_jsonb(${value.authorizationUrl}::text), true),
					'{callback}', ${JSON.stringify(callback)}::jsonb, true),
					revision = revision + 1, updated_at = clock_timestamp()
					where a.id = ${input.authorizationId} and a.binding->'callback' is null
						and a.expires_at > clock_timestamp()
						and to_timestamp(${mappingExpiresAt}::double precision / 1000) > clock_timestamp()
						and exists (select 1 from platform.connection_installation_commands c
							where c.id=${input.commandId} and c.authorization_id=a.id
								and c.status='sending' and c.attempt_id=${input.attemptId}
								and c.attempt_owner=${input.attemptOwner} and c.attempt_expires_at > clock_timestamp())
						and ${originalClaimHolds(template.reference, template.claim)}
					returning a.id
				)
				update platform.connection_installation_commands c
				set status='completed', updated_at=clock_timestamp()
				from mapped where c.id=${input.commandId} and c.authorization_id=mapped.id
				returning c.id
			`);
			if (updated.length !== 1) return fail();
			if (input.command === "begin_status")
				await tx.execute(sql`
					update platform.connection_installation_commands set status='completed', updated_at=clock_timestamp()
					where authorization_id=${input.authorizationId} and command='begin' and status='unknown'
				`);
			return "mapped";
		});
	}

	/**
	 * Host→Worker authoritative readback (§13.5.6). Read-only: purpose `supply`
	 * matches the original persisted supply attempt; purpose `command` matches the
	 * signed command's own persisted `sending` record and wire digest.
	 */
	async readback(
		input: ConnectionInstallReadbackRequestV1,
	): Promise<"allowed" | "denied" | "unavailable"> {
		let request: ConnectionInstallReadbackRequestV1;
		try {
			request = ConnectionInstallReadbackRequestV1Schema.parse(input);
		} catch {
			return "denied";
		}
		try {
			return await this.#transaction(async (tx) => {
				const row = await this.#lockInstallation(
					tx,
					request.authorizationId,
					"share",
				);
				if (!row?.associationLocked || !row.template || row.live !== true)
					return "denied";
				const authorization = this.#authorization(row);
				const template = ConnectionRegistrationTemplateV1Schema.parse(
					row.template,
				);
				if (
					row.user_id !== request.principal.id ||
					!isDeepStrictEqual(authorization.principal, request.principal) ||
					!isDeepStrictEqual(authorization.reference, request.reference) ||
					authorization.confirmationRevision !== request.confirmationRevision ||
					row.template_digest !== request.templateDigest ||
					connectionRegistrationTemplateDigestV1(template) !==
						request.templateDigest ||
					!isDeepStrictEqual(template.target, request.target) ||
					row.supply_attempt_id !== request.supply.attemptId ||
					template.supply.ref !== request.supply.ref ||
					template.supply.revision !== request.supply.revision
				)
					return "denied";
				const current = await this.#facts(
					tx,
					authorization.principal.id,
					authorization.reference.executionId,
				);
				if (
					!current ||
					!manualTemplateMatchesCurrentV1(
						this.#policy,
						template,
						authorization,
						current,
						row.registration_key_hash as string,
					)
				)
					return "denied";
				/**
				 * Final permit (§13.5.6 Worker 权威回读): the directory read may have
				 * outlasted the authorization or the original claim, so both are
				 * rechecked at the database clock. Only the template's own claim and
				 * fence count; another live claim of the same Execution never does.
				 */
				const permit = async (commandId?: string) => {
					const [final] = await tx.execute(sql`
						select a.expires_at > clock_timestamp()
							and ${originalClaimHolds(template.reference, template.claim)}
							and (${commandId === undefined} or exists (select 1 from platform.connection_installation_commands c
								where c.id=${commandId ?? null} and c.authorization_id=a.id and c.status='sending'
									and c.attempt_expires_at > clock_timestamp())) as live
						from platform.connection_installation_authorizations a where a.id=${request.authorizationId}
					`);
					return final?.live === true ? "allowed" : "denied";
				};
				if (request.purpose === "supply_delivery")
					return row.status === "preparing" &&
						row.supply_state === "sending" &&
						row.registration_state === "pending"
						? permit()
						: "denied";
				if (request.purpose === "supply")
					return ["sending", "confirmed"].includes(
						row.supply_state as string,
					) &&
						(!["failed", "closed"].includes(row.registration_state as string) ||
							// The originating attempt's compensation DELETE still needs its supply.
							row.revoke_state === "sending")
						? permit()
						: "denied";
				const command = request.command;
				if (!command) return "denied";
				const supplyStatus = command.command === "supply_status";
				if (row.supply_state !== (supplyStatus ? "unknown" : "confirmed"))
					return "denied";
				const [persisted] = await tx.execute(sql`
					select command, status, attempt_id, attempt_owner, delivery_digest,
						attempt_expires_at > clock_timestamp() as live
					from platform.connection_installation_commands
					where id=${command.commandId} and authorization_id=${request.authorizationId}
					for share
				`);
				if (
					!persisted ||
					persisted.command !== (supplyStatus ? "status" : command.command) ||
					persisted.status !== "sending" ||
					persisted.live !== true ||
					persisted.attempt_id !== command.attemptId ||
					persisted.attempt_owner !== command.attemptOwner ||
					persisted.delivery_digest !== command.requestDigest ||
					command.registrationKeyHash !== row.registration_key_hash ||
					current.claim.owner !== command.attemptOwner
				)
					return "denied";
				const binding = row.binding as { callback?: unknown };
				const allowed = () => permit(command.commandId);
				switch (command.command) {
					case "prepare":
						return row.status === "preparing" &&
							row.registration_state === "sending"
							? allowed()
							: "denied";
					case "supply_status":
						return row.status === "preparing" &&
							row.registration_state === "pending"
							? allowed()
							: "denied";
					case "status":
						return row.status === "preparing" &&
							row.registration_state === "unknown"
							? allowed()
							: "denied";
					case "revoke":
						return row.revoke_state === "sending" ? allowed() : "denied";
					case "confirm_binding_readback": {
						// §13.5.6 exception confirm phase 1: read-only; the phase and its
						// logical confirm are sending for this attempt and the descriptor holds.
						const [phase] = await tx.execute(sql`
							select 1 from platform.connection_installation_commands p
							join platform.connection_installation_commands c on c.authorization_id=p.authorization_id
								and c.command='confirm' and c.status='sending'
								and c.attempt_id=p.attempt_id and c.attempt_owner=p.attempt_owner
								and p.idempotency_key='confirm-phase:' || c.id || ':confirm_binding_readback'
							where p.id=${command.commandId}`);
						return phase &&
							row.status === "confirmed" &&
							row.registration_state === "registered" &&
							row.revoke_state === "not_required" &&
							row.descriptor_digest !== null &&
							command.descriptorDigest === row.descriptor_digest
							? allowed()
							: "denied";
					}
					case "confirm_exchange":
						// Phase 2 verification against the commit receipt arrives with the
						// Host exchange; until then nothing exchanges.
						return "denied";
					case "begin":
					case "begin_status": {
						if (
							!["awaiting_confirmation", "confirmed"].includes(
								row.status as string,
							) ||
							row.registration_state !== "registered" ||
							!row.configuration ||
							!row.receipt ||
							!row.descriptor_digest ||
							binding.callback !== undefined
						)
							return "denied";
						if (command.command === "begin_status") return allowed();
						const configuration = RuntimeOAuthConfigurationV1Schema.parse(
							row.configuration,
						);
						const receipt = ConnectionRegistrationReceiptV1Schema.parse(
							row.receipt,
						);
						return command.configurationDigest ===
							connectionInstallConfigurationDigestV1(configuration) &&
							command.receiptDigest ===
								connectionRegistrationReceiptDigestV1(receipt) &&
							command.descriptorDigest === row.descriptor_digest
							? allowed()
							: "denied";
					}
				}
			});
		} catch {
			return "unavailable";
		}
	}

	/** Current manual facts for one original Execution (Worker template building). */
	async current(
		userId: string,
		executionId: string,
	): Promise<ConnectionManualInstallationCurrentV1 | null> {
		return this.#transaction((tx) => this.#facts(tx, userId, executionId));
	}

	close() {
		return this.#client.end();
	}
}
