import { ConnectionInstallationErrorV1 } from "@agent-infra/platform-core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
	type ConnectionManualInstallationPolicyInputV1,
	type ConnectionManualInstallationPolicyV1,
	captureConnectionManualInstallationPolicyV1,
} from "./connection-manual-installations.js";
import {
	type ConnectionPrincipalPinTransactionV1,
	closeConnectionExceptionInstallationsV1,
	insertConnectionPrincipalPinAuditV1,
	sweepConnectionPrincipalPinRulesV1,
} from "./connection-principal-pin-rules.js";
import postgres from "./observed-postgres.js";

/**
 * The administrator's written record of one exception pin operation. The
 * caller is the audited operations entry that re-verified a current
 * `system_admin` (Spec §9.1); this store records who and on what written
 * conclusion, never a Connection credential or session.
 */
export interface ConnectionPrincipalPinAdministrationInputV1 {
	readonly pinId: string;
	readonly expectedRuleRevision: number;
	readonly administratorId: string;
	/** Link to the written conclusion or request, e.g. the Issue comment. */
	readonly reference: string;
	readonly requestId: string;
	readonly traceId: string;
}

export type ConnectionPrincipalPinAdministrationResultV1 =
	| {
			readonly outcome: "recorded";
			readonly ruleRevision: number;
			/** Installations closed in this operation; their revokes are queued. */
			readonly closed: number;
	  }
	| { readonly outcome: "stale" | "not_found" };

function text(value: unknown, max = 1024): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		!value.includes("\0") &&
		value.trim() === value
	);
}

function parse(input: ConnectionPrincipalPinAdministrationInputV1) {
	if (
		!text(input?.pinId) ||
		!Number.isSafeInteger(input.expectedRuleRevision) ||
		input.expectedRuleRevision < 1 ||
		!text(input.administratorId) ||
		!text(input.reference, 512) ||
		!text(input.requestId) ||
		!text(input.traceId)
	)
		throw new ConnectionInstallationErrorV1("invalid_input");
	return input;
}

/**
 * §13.5.1 exception items 4 and 6: the administrator records for exception
 * pins. Each operation is one transaction with its audit event: a stale
 * `rule_revision` writes nothing. Closing installations queues their revoke
 * with the original key; the release itself completes in the drain sweep only
 * after every revoke settled (item 6: close and revoke first, then unpin).
 */
export class PostgresConnectionPrincipalPinAdministrationV1 {
	readonly #client: ReturnType<typeof postgres>;
	readonly #database: ReturnType<typeof drizzle>;
	readonly #policy: ConnectionManualInstallationPolicyV1;

	constructor(options: {
		readonly databaseUrl: string;
		readonly policy: ConnectionManualInstallationPolicyInputV1;
	}) {
		this.#policy = captureConnectionManualInstallationPolicyV1(options.policy);
		this.#client = postgres(options.databaseUrl, { max: 2 });
		this.#database = drizzle(this.#client);
	}

	async #transaction<T>(
		work: (tx: ConnectionPrincipalPinTransactionV1) => Promise<T>,
	): Promise<T> {
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
			throw new ConnectionInstallationErrorV1("unavailable");
		}
	}

	async #lock(tx: ConnectionPrincipalPinTransactionV1, pinId: string) {
		const [pin] = await tx.execute(sql`
			select id, user_id, issuer, policy_ref, policy_revision, rule_revision, verification_state,
				suspended_at, release_requested_at, released_at
			from platform.connection_principal_pins where id=${pinId}
			for update
		`);
		return pin;
	}

	/**
	 * Item 6: unpin. Stops new permits at once, closes the user's exception
	 * installations and queues their revoke; the drain sweep sets `released_at`
	 * after every revoke settled.
	 */
	async requestRelease(
		input: ConnectionPrincipalPinAdministrationInputV1,
	): Promise<ConnectionPrincipalPinAdministrationResultV1> {
		const request = parse(input);
		return this.#transaction(async (tx) => {
			const pin = await this.#lock(tx, request.pinId);
			if (!pin || pin.released_at !== null) return { outcome: "not_found" };
			if (
				Number(pin.rule_revision) !== request.expectedRuleRevision ||
				pin.release_requested_at !== null
			)
				return { outcome: "stale" };
			const [updated] = await tx.execute(sql`
				update platform.connection_principal_pins
				set release_requested_at=clock_timestamp(), release_reason='administrator',
					release_actor_id=${request.administratorId}, release_reference=${request.reference},
					rule_revision=rule_revision+1
				where id=${request.pinId} and rule_revision=${request.expectedRuleRevision}
					and released_at is null and release_requested_at is null
				returning rule_revision
			`);
			if (!updated) return { outcome: "stale" };
			const closed = await closeConnectionExceptionInstallationsV1(tx, {
				userId: pin.user_id as string,
				reason: "principal-pin-release",
			});
			await insertConnectionPrincipalPinAuditV1(tx, {
				action: "release_requested",
				pinId: request.pinId,
				actor: { type: "user", id: request.administratorId },
				outcome: "succeeded",
				requestId: request.requestId,
				traceId: request.traceId,
				details: {
					userId: pin.user_id,
					reference: request.reference,
					closedInstallations: closed,
				},
			});
			return {
				outcome: "recorded",
				ruleRevision: Number(updated.rule_revision),
				closed,
			};
		});
	}

	/**
	 * Item 4: records the verifier's written conclusion. `consistent` clears the
	 * "主体待核对" label and resumes a pin suspended by a uniqueness conflict;
	 * `inconsistent` stops permits, closes and revokes the user's exception
	 * installations and releases the pin once the revokes settle.
	 */
	async recordVerification(
		input: ConnectionPrincipalPinAdministrationInputV1 & {
			readonly result: "consistent" | "inconsistent";
		},
	): Promise<ConnectionPrincipalPinAdministrationResultV1> {
		const request = parse(input);
		if (input.result !== "consistent" && input.result !== "inconsistent")
			throw new ConnectionInstallationErrorV1("invalid_input");
		return this.#transaction(async (tx) => {
			const pin = await this.#lock(tx, request.pinId);
			if (!pin || pin.released_at !== null) return { outcome: "not_found" };
			if (
				Number(pin.rule_revision) !== request.expectedRuleRevision ||
				pin.release_requested_at !== null
			)
				return { outcome: "stale" };
			const consistent = input.result === "consistent";
			const [updated] = consistent
				? await tx.execute(sql`
					update platform.connection_principal_pins
					set verification_state='verified', verified_at=clock_timestamp(),
						verification_actor_id=${request.administratorId}, verification_reference=${request.reference},
						suspended_at=null, rule_revision=rule_revision+1
					where id=${request.pinId} and rule_revision=${request.expectedRuleRevision}
						and released_at is null and release_requested_at is null
					returning rule_revision`)
				: await tx.execute(sql`
					update platform.connection_principal_pins
					set verification_state='mismatch', verified_at=null,
						verification_actor_id=${request.administratorId}, verification_reference=${request.reference},
						release_requested_at=clock_timestamp(), release_reason='mismatch',
						release_actor_id=${request.administratorId}, release_reference=${request.reference},
						rule_revision=rule_revision+1
					where id=${request.pinId} and rule_revision=${request.expectedRuleRevision}
						and released_at is null and release_requested_at is null
					returning rule_revision`);
			if (!updated) return { outcome: "stale" };
			const closed = consistent
				? 0
				: await closeConnectionExceptionInstallationsV1(tx, {
						userId: pin.user_id as string,
						reason: "principal-verification-mismatch",
					});
			await insertConnectionPrincipalPinAuditV1(tx, {
				action: consistent ? "verified" : "verification_mismatch",
				pinId: request.pinId,
				actor: { type: "user", id: request.administratorId },
				outcome: "succeeded",
				requestId: request.requestId,
				traceId: request.traceId,
				details: {
					userId: pin.user_id,
					reference: request.reference,
					resumed: consistent && pin.suspended_at !== null,
					closedInstallations: closed,
				},
			});
			return {
				outcome: "recorded",
				ruleRevision: Number(updated.rule_revision),
				closed,
			};
		});
	}

	/** One bounded pass of the item 4/8 rules; the drain runs the same pass. */
	async sweep(): Promise<void> {
		await this.#transaction((tx) =>
			sweepConnectionPrincipalPinRulesV1(tx, this.#policy),
		);
	}

	async close(): Promise<void> {
		await this.#client.end();
	}
}
