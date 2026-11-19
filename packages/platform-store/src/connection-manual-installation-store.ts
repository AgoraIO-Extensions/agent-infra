import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	ConnectionInstallationAuthorizationV1Schema,
	type ConnectionInstallCommandResponseV1,
	ConnectionInstallCommandResponseV1Schema,
	type ConnectionInstallReadbackRequestV1,
	ConnectionInstallReadbackRequestV1Schema,
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
	connectionManualInstallConfigurationV1,
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
	lockConnectionManualAssociationForInstallationV1,
	manualTemplateMatchesCurrentV1,
	readConnectionManualInstallationFactsV1,
} from "./connection-manual-installations.js";
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
];
/** Two bounded network hops (supply, then one Connection request) per attempt. */
const attemptLifetime = sql`interval '60 seconds'`;

function unavailable(): never {
	throw new ConnectionInstallationErrorV1("unavailable");
}

function sha256(value: string) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** SQL predicate for when a manual command may be claimed, by its kind. */
const eligible = sql`(
	(c.command = 'prepare' and a.status = 'preparing' and m.registration_state = 'pending' and m.supply_state in ('pending','confirmed'))
	or (c.command = 'status' and a.status = 'preparing' and ((m.registration_state = 'unknown' and m.supply_state = 'confirmed')
		or (m.registration_state = 'pending' and m.supply_state = 'unknown')))
	or (c.command = 'begin' and a.status in ('awaiting_confirmation','confirmed') and m.registration_state = 'registered' and m.supply_state = 'confirmed')
	or (c.command = 'begin_status' and a.status in ('awaiting_confirmation','confirmed') and m.registration_state = 'registered' and m.supply_state = 'confirmed')
	or (c.command = 'revoke' and m.revoke_state = 'pending' and m.supply_state = 'confirmed')
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

	/** Expired attempts become unknown, including the registration they were sending. */
	async #sweep() {
		await this.#transaction((tx) =>
			tx.execute(sql`
			update platform.connection_installation_commands set status='unknown', updated_at=clock_timestamp()
			where (status='sending' or (status='pending' and command='prepare' and attempt_id is not null)) and attempt_expires_at is not null and attempt_expires_at <= clock_timestamp()
				and authorization_id in (select authorization_id from platform.connection_manual_installations)
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

	/** Pending manual commands of Executions this Worker currently holds. */
	async listPending(
		limit: number,
		executionIds: readonly string[],
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
			executionIds.length === 0
		)
			return [];
		await this.#sweep();
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
				await tx.execute(sql`
					update platform.connection_installation_commands set status='rejected', updated_at=clock_timestamp()
					where id=${input.commandId} and status='pending'
				`);
				return null;
			}
			const updated = await tx.execute(sql`
				update platform.connection_installation_commands c
				set status=case when c.command='prepare' then 'pending' else 'sending' end, attempt_id=${input.attemptId}, attempt_owner=${input.attemptOwner},
					attempt_expires_at=clock_timestamp() + ${attemptLifetime}, delivery_digest=null,
					updated_at=clock_timestamp()
				from platform.connection_installation_authorizations a, platform.connection_manual_installations m
				where c.id=${input.commandId} and c.status='pending' and c.attempt_id is null
					and a.id=c.authorization_id and m.authorization_id=a.id and ${eligible}
					and not exists (select 1 from platform.connection_installation_commands prior
						where prior.authorization_id = c.authorization_id and prior.created_at < c.created_at
							and prior.status in ('pending','sending'))
				returning c.id
			`);
			if (updated.length !== 1) return null;
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

	async #sending(
		tx: Transaction,
		input: {
			commandId: string;
			attemptId: string;
			attemptOwner: string;
			authorizationId: string;
		},
		command: ManualCommand,
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
			await tx.execute(sql`
					update platform.connection_manual_installations
					set template=${JSON.stringify(template)}::jsonb, template_digest=${digest},
						registration_key=${input.registrationKey}, registration_key_hash=${keyHash},
						supply_attempt_id=${input.supplyAttemptId}, supply_state='sending',
						revision=revision+1, updated_at=clock_timestamp()
					where authorization_id=${template.authorizationId} and template is null
				`);
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
			if (!(await this.#lockInstallation(tx, input.authorizationId)))
				return false;
			if (
				input.command !== "prepare" ||
				!(await this.#sending(tx, input, "prepare", true))
			)
				return false;
			const updated = await tx.execute(sql`
				update platform.connection_manual_installations
				set supply_state = ${input.outcome}, revision = revision + 1, updated_at = clock_timestamp()
				where authorization_id=${input.authorizationId} and supply_attempt_id=${input.supplyAttemptId}
					and supply_state = 'sending' and registration_state = 'pending'
				returning authorization_id
			`);
			if (updated.length === 0) return false;
			if (input.outcome === "unknown")
				await this.#finishCommand(tx, input.commandId, "unknown");
			return true;
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
					and exists (select 1 from platform.outbox_items o
						where o.scope_type='conversation' and o.scope_id=${authorization.reference.conversationId}
							and o.payload->>'executionId'=${authorization.reference.executionId}
							and o.status='processing' and o.lease_owner=${input.attemptOwner}
							and o.lease_expires_at > clock_timestamp()
							and o.operation in ('conversation.turn.submit.v1','conversation.turn.regenerate.v1','conversation.turn.supplement.v1'))
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
		readonly command: ManualCommand;
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
			await tx.execute(sql`
				update platform.connection_installation_commands set status='sending', delivery_digest=${input.deliveryDigest},
					updated_at=clock_timestamp() where id=${input.commandId} and delivery_digest is null
			`);
			if (input.command === "prepare")
				await tx.execute(sql`
					update platform.connection_manual_installations set registration_state='sending',
						revision=revision+1, updated_at=clock_timestamp()
					where authorization_id=${input.authorizationId} and registration_state='pending'
				`);
			return true;
		});
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
			const unknown = async () => {
				await tx.execute(sql`
					update platform.connection_manual_installations
					set registration_state = case when registration_state in ('sending','unknown') then 'unknown' else registration_state end,
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
				select c.attempt_expires_at > clock_timestamp() and a.expires_at > clock_timestamp() as live
				from platform.connection_installation_commands c
				join platform.connection_installation_authorizations a on a.id=c.authorization_id
				where c.id=${input.commandId}
			`);
			if (deadline?.live !== true) return unknown();
			const bindable =
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
					await this.#closeForCompensation(tx, row, receipt);
					await this.#finishCommand(tx, input.commandId, "completed");
					return "unknown";
				}
				return unknown();
			}
			const configuration = connectionManualInstallConfigurationV1({
				access: this.#policy.access,
				template,
				receipt,
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
					and exists (select 1 from platform.outbox_items o
						where o.scope_type='conversation' and o.scope_id=${authorization.reference.conversationId}
							and o.payload->>'executionId'=${authorization.reference.executionId}
							and o.status='processing' and o.lease_owner=${input.attemptOwner}
							and o.lease_expires_at > clock_timestamp()
							and o.operation in ('conversation.turn.submit.v1','conversation.turn.regenerate.v1','conversation.turn.supplement.v1'))
				returning c.id
			`);
			if (accepted.length !== 1) return unknown();
			await tx.execute(sql`
				update platform.connection_manual_installations
				set registration_state='registered', receipt=${JSON.stringify(receipt)}::jsonb,
					consumer_id=${receipt.consumerId}, client_id=${receipt.clientId}, instance_id=${receipt.instanceId},
					configuration=${JSON.stringify(configuration)}::jsonb, revision=revision+1, updated_at=clock_timestamp()
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
			// Compensation applies to a closed authorization and uses its own attempt deadline.
			const [settled] = await tx.execute(sql`
				with outcome as (
					update platform.connection_installation_commands
					set status=case when ${row.associationLocked && input.response?.outcome === "revoked"}
						and attempt_expires_at > clock_timestamp() then 'completed' else 'unknown' end,
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
		readonly command: "begin" | "begin_status";
	}): Promise<{
		readonly template: ConnectionRegistrationTemplateV1;
		readonly registrationKey: string;
		readonly supplyAttemptId: string;
		readonly receipt: ConnectionRegistrationReceiptV1;
		readonly configuration: RuntimeOAuthConfigurationV1;
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
				!row.configuration
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
						and exists (select 1 from platform.outbox_items o
							where o.scope_type='conversation' and o.scope_id=${authorization.reference.conversationId}
								and o.payload->>'executionId'=${authorization.reference.executionId}
								and o.status='processing' and o.lease_owner=${input.attemptOwner}
								and o.lease_expires_at > clock_timestamp()
								and o.operation in ('conversation.turn.submit.v1','conversation.turn.regenerate.v1','conversation.turn.supplement.v1'))
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
				if (request.purpose === "supply_delivery")
					return row.status === "preparing" &&
						row.supply_state === "sending" &&
						row.registration_state === "pending"
						? "allowed"
						: "denied";
				if (request.purpose === "supply")
					return ["sending", "confirmed"].includes(
						row.supply_state as string,
					) &&
						(!["failed", "closed"].includes(row.registration_state as string) ||
							// The originating attempt's compensation DELETE still needs its supply.
							row.revoke_state === "sending")
						? "allowed"
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
				switch (command.command) {
					case "prepare":
						return row.status === "preparing" &&
							row.registration_state === "sending"
							? "allowed"
							: "denied";
					case "supply_status":
						return row.status === "preparing" &&
							row.registration_state === "pending"
							? "allowed"
							: "denied";
					case "status":
						return row.status === "preparing" &&
							row.registration_state === "unknown"
							? "allowed"
							: "denied";
					case "revoke":
						return row.revoke_state === "sending" ? "allowed" : "denied";
					case "begin":
					case "begin_status": {
						if (
							!["awaiting_confirmation", "confirmed"].includes(
								row.status as string,
							) ||
							row.registration_state !== "registered" ||
							!row.configuration ||
							!row.receipt ||
							binding.callback !== undefined
						)
							return "denied";
						if (command.command === "begin_status") return "allowed";
						const configuration = RuntimeOAuthConfigurationV1Schema.parse(
							row.configuration,
						);
						const receipt = ConnectionRegistrationReceiptV1Schema.parse(
							row.receipt,
						);
						return command.configurationDigest ===
							connectionInstallConfigurationDigestV1(configuration) &&
							command.receiptDigest ===
								connectionRegistrationReceiptDigestV1(receipt)
							? "allowed"
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
