import {
	type ConnectionConsumerRegisteredBindingV1,
	type ConnectionConsumerRegistrationDeliveryV1,
	type ConnectionConsumerRegistrationIntentV1,
	type ConnectionConsumerRegistrationPolicyV1,
	captureConnectionConsumerRegisteredBindingV1,
	captureConnectionConsumerRegistrationPolicyV1,
	connectionConsumerRegistrationOperationV1,
	isConnectionConsumerRegistrationCurrentV1,
	parseConnectionConsumerRegistrationDeliveryV1,
	parseConnectionConsumerRegistrationIntentV1,
	planConnectionConsumerRegistrationForTransitionV1,
} from "@agent-infra/platform-core";
import { eq, type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import type { ClaimedOutboxItem } from "./outbox.js";
import { connectionConsumerRegistrations, outboxItems } from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

/** The caller owns the existing Agent transaction; no external request occurs here. */
export async function insertConnectionConsumerRegistrationV1(
	transaction: Transaction,
	input: {
		readonly policy: ConnectionConsumerRegistrationPolicyV1;
		readonly platformAgentId: string;
		readonly platformOwnerId: string;
		readonly consumerName: string;
		readonly transition: Parameters<
			typeof planConnectionConsumerRegistrationForTransitionV1
		>[0]["transition"];
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	},
): Promise<void> {
	const intent = planConnectionConsumerRegistrationForTransitionV1(input);
	if (!intent) return;
	const [inserted] = await transaction
		.insert(connectionConsumerRegistrations)
		.values({
			operationId: intent.operationId,
			agentId: intent.platformAgentId,
			sourceNamespace: intent.sourceNamespace,
			sourceKey: intent.sourceKey,
			requestDigest: intent.requestDigest,
			idempotencyKey: intent.idempotencyKey,
			request: intent,
			createdAt: input.occurredAt,
			updatedAt: input.occurredAt,
		})
		.onConflictDoNothing()
		.returning({ operationId: connectionConsumerRegistrations.operationId });
	if (!inserted) {
		const [existing] = await transaction
			.select()
			.from(connectionConsumerRegistrations)
			.where(
				eq(connectionConsumerRegistrations.agentId, intent.platformAgentId),
			);
		if (
			!existing ||
			existing.operationId !== intent.operationId ||
			existing.requestDigest !== intent.requestDigest ||
			existing.sourceNamespace !== intent.sourceNamespace ||
			existing.idempotencyKey !== intent.idempotencyKey
		)
			throw new Error("CONNECTION_CONSUMER_REGISTRATION_CONFLICT");
		return;
	}
	await transaction.insert(outboxItems).values({
		id: intent.operationId,
		scopeType: "agent",
		scopeId: intent.platformAgentId,
		operation: connectionConsumerRegistrationOperationV1,
		payload: {
			schemaVersion: 1,
			operationId: intent.operationId,
			platformAgentId: intent.platformAgentId,
			requestDigest: intent.requestDigest,
		},
		traceId: input.traceId,
		requestId: input.requestId,
		availableAt: input.occurredAt,
		createdAt: input.occurredAt,
		updatedAt: input.occurredAt,
	});
}

type RegistrationRow = {
	request: unknown;
	status: string;
	current_owner_id: string | null;
	current_status: string | null;
	owner_current: boolean;
};

const registrationReadDialect = new PgDialect();

/** Same Platform transaction as the installation authority; never reads Connection's database. */
export async function readRegisteredConnectionConsumerBindingsV1(
	transaction: {
		execute(query: SQL): PromiseLike<readonly Record<string, unknown>[]>;
	},
	policy: ConnectionConsumerRegistrationPolicyV1,
	agentId?: string,
): Promise<Readonly<Record<string, ConnectionConsumerRegisteredBindingV1>>> {
	await transaction.execute(
		sql`lock table platform.platform_user_disables in share mode`,
	);
	const rows = await transaction.execute(sql`
		select r.agent_id, r.request, r.receipt, r.consumer_id, r.consumer_revision,
			r.association_revision, a.applicant_id as current_owner_id,
			a.status as current_status
		from platform.connection_consumer_registrations r
		join platform.agent_applications a on a.agent_id = r.agent_id
		join platform.agent_owners own on own.agent_id = r.agent_id
			and own.owner_id = r.request->>'platformOwnerId'
		where r.source_namespace = ${policy.sourceNamespace} and r.status = 'registered'
			and ${agentId === undefined ? sql`true` : sql`r.agent_id = ${agentId}`}
			and not exists(select 1 from platform.platform_user_disables disabled
				where disabled.user_id = own.owner_id)
		order by r.agent_id for share of r, a, own
	`);
	const result: Record<string, ConnectionConsumerRegisteredBindingV1> = {};
	for (const row of rows) {
		const binding = captureConnectionConsumerRegisteredBindingV1({
			intent: row.request,
			receipt: row.receipt,
			associationRevision: Number(row.association_revision),
		});
		if (
			row.agent_id !== binding.intent.platformAgentId ||
			row.consumer_id !== binding.receipt.consumerId ||
			row.consumer_revision !== binding.receipt.consumerRevision ||
			!isConnectionConsumerRegistrationCurrentV1({
				intent: binding.intent,
				policy,
				ownerId:
					typeof row.current_owner_id === "string"
						? row.current_owner_id
						: null,
				ownerCurrent: true,
				agentStatus:
					typeof row.current_status === "string" ? row.current_status : null,
			})
		)
			continue;
		Object.defineProperty(result, binding.intent.platformAgentId, {
			value: binding,
			enumerable: true,
		});
	}
	return Object.freeze(result);
}

/** Reuses the outbox lease and fence; the table has no independent claim or scheduler. */
export class PostgresConnectionConsumerRegistrationStoreV1 {
	readonly #client;
	readonly #policy;
	constructor(input: {
		readonly databaseUrl: string;
		readonly policy: ConnectionConsumerRegistrationPolicyV1;
	}) {
		this.#policy = captureConnectionConsumerRegistrationPolicyV1(input.policy);
		this.#client = postgres(input.databaseUrl, { max: 2 });
	}

	async registered(): Promise<
		Readonly<Record<string, ConnectionConsumerRegisteredBindingV1>>
	> {
		return this.#client.begin(async (transaction) => {
			// Compile the same query without letting Drizzle change this writer's JSON serializers.
			const query = {
				execute: (statement: SQL) => {
					const compiled = registrationReadDialect.sqlToQuery(statement);
					const parameters = compiled.params.map((value) => {
						if (typeof value !== "string")
							throw new Error("CONNECTION_CONSUMER_REGISTRATION_INVALID");
						return value;
					});
					return transaction.unsafe(compiled.sql, parameters);
				},
			};
			await query.execute(sql`set local lock_timeout = '5s'`);
			await query.execute(sql`set local statement_timeout = '15s'`);
			return readRegisteredConnectionConsumerBindingsV1(query, this.#policy);
		});
	}

	async pending(limit = 20): Promise<readonly string[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new Error("CONNECTION_CONSUMER_REGISTRATION_INVALID");
		const rows = await this.#client<{ id: string }[]>`
			select o.id from platform.outbox_items o
			join platform.connection_consumer_registrations r on r.operation_id = o.id
			where o.operation = ${connectionConsumerRegistrationOperationV1}
				and r.source_namespace = ${this.#policy.sourceNamespace}
				and ((o.status in ('pending','retry_scheduled') and o.available_at <= clock_timestamp())
					or (o.status = 'processing' and o.lease_expires_at <= clock_timestamp()))
			order by o.available_at, o.id limit ${limit}
		`;
		return rows.map((row) => row.id);
	}

	async #locked(
		transaction: postgres.TransactionSql,
		claim: ClaimedOutboxItem,
	): Promise<RegistrationRow | undefined> {
		const [outbox] = await transaction<{ payload: unknown }[]>`
			select payload from platform.outbox_items
			where id = ${claim.itemId} and operation = ${connectionConsumerRegistrationOperationV1}
				and scope_type = 'agent' and scope_id = ${claim.scopeId}
				and status = 'processing' and lease_owner = ${claim.leaseOwner}
				and delivery_fence = ${claim.deliveryFence.toString()}
				and lease_expires_at > clock_timestamp() for update
		`;
		if (!outbox) return undefined;
		const [row] = await transaction<RegistrationRow[]>`
			select r.request, r.status, a.applicant_id as current_owner_id,
				a.status as current_status,
				exists(select 1 from platform.agent_owners own where own.agent_id = r.agent_id
					and own.owner_id = r.request->>'platformOwnerId')
					and not exists(select 1 from platform.platform_user_disables disabled
						where disabled.user_id = r.request->>'platformOwnerId') as owner_current
			from platform.connection_consumer_registrations r
			join platform.agent_applications a on a.agent_id = r.agent_id
			where r.operation_id = ${claim.itemId} and r.agent_id = ${claim.scopeId}
			for update of r, a
		`;
		if (!row) return undefined;
		const intent = parseConnectionConsumerRegistrationIntentV1(row.request);
		const payload = outbox.payload as Record<string, unknown> | null;
		if (
			!payload ||
			Object.keys(payload).length !== 4 ||
			payload.schemaVersion !== 1 ||
			payload.operationId !== intent.operationId ||
			payload.platformAgentId !== intent.platformAgentId ||
			payload.requestDigest !== intent.requestDigest
		)
			throw new Error("CONNECTION_CONSUMER_REGISTRATION_INVALID");
		return row;
	}

	#eligible(
		row: RegistrationRow,
		intent: ConnectionConsumerRegistrationIntentV1,
	) {
		return isConnectionConsumerRegistrationCurrentV1({
			intent,
			policy: this.#policy,
			ownerId: row.current_owner_id,
			ownerCurrent: row.owner_current,
			agentStatus: row.current_status,
		});
	}

	async beginAttempt(claim: ClaimedOutboxItem, adapterAvailable: boolean) {
		return this.#client.begin(async (transaction) => {
			const row = await this.#locked(transaction, claim);
			if (!row) return undefined;
			const intent = parseConnectionConsumerRegistrationIntentV1(row.request);
			if (row.status === "registered" || row.status === "failed")
				return { outcome: row.status as "registered" | "failed" };
			if (!adapterAvailable || !this.#eligible(row, intent)) {
				const status = row.status === "pending" ? "pending" : "unknown";
				await transaction`
					update platform.connection_consumer_registrations set status = ${status},
						failure_code = ${adapterAvailable ? "CONNECTION_REGISTRATION_AUTHORITY_CHANGED" : "CONNECTION_REGISTRATION_ADAPTER_UNAVAILABLE"},
						updated_at = clock_timestamp() where operation_id = ${claim.itemId}
				`;
				return { outcome: status } as const;
			}
			const mode: "register" | "reconcile" =
				row.status === "pending" ? "register" : "reconcile";
			await transaction`
				update platform.connection_consumer_registrations
				set status = ${mode === "register" ? "sending" : "unknown"},
					sending_at = coalesce(sending_at, clock_timestamp()), failure_code = null,
					updated_at = clock_timestamp() where operation_id = ${claim.itemId}
			`;
			return { outcome: "deliver" as const, mode, intent };
		});
	}

	/** Only the current sender can establish that its planned register call was never started. */
	async deferBeforeSend(
		claim: ClaimedOutboxItem,
		mode: "register" | "reconcile",
	) {
		return this.#client.begin(async (transaction) => {
			const row = await this.#locked(transaction, claim);
			if (!row || row.status === "registered" || row.status === "failed")
				return false;
			await transaction`
				update platform.connection_consumer_registrations
				set status = ${mode === "register" ? "pending" : "unknown"},
					sending_at = case when ${mode} = 'register' then null else sending_at end,
					failure_code = 'CONNECTION_REGISTRATION_NOT_SENT', updated_at = clock_timestamp()
				where operation_id = ${claim.itemId}
			`;
			return true;
		});
	}

	/** Guard the original authority and lease immediately before adapter I/O. */
	async current(claim: ClaimedOutboxItem): Promise<boolean> {
		return this.#client.begin(async (transaction) => {
			const row = await this.#locked(transaction, claim);
			return (
				!!row &&
				this.#eligible(
					row,
					parseConnectionConsumerRegistrationIntentV1(row.request),
				)
			);
		});
	}

	async complete(
		claim: ClaimedOutboxItem,
		result: ConnectionConsumerRegistrationDeliveryV1,
	): Promise<boolean> {
		return this.#client.begin(async (transaction) => {
			const row = await this.#locked(transaction, claim);
			if (!row || row.status === "registered" || row.status === "failed")
				return false;
			const intent = parseConnectionConsumerRegistrationIntentV1(row.request);
			const delivery = parseConnectionConsumerRegistrationDeliveryV1(
				result,
				intent,
			);
			if (!this.#eligible(row, intent)) {
				await transaction`
					update platform.connection_consumer_registrations set status = 'unknown',
						failure_code = 'CONNECTION_REGISTRATION_AUTHORITY_CHANGED', updated_at = clock_timestamp()
					where operation_id = ${claim.itemId}
				`;
				return false;
			}
			if (delivery.outcome === "registered") {
				await transaction`
					update platform.connection_consumer_registrations set status = 'registered',
						consumer_id = ${delivery.receipt.consumerId}, receipt = ${transaction.json({ ...delivery.receipt })},
						consumer_revision = ${delivery.receipt.consumerRevision}, association_revision = 1,
						registered_at = clock_timestamp(), updated_at = clock_timestamp(), failure_code = null
					where operation_id = ${claim.itemId}
				`;
			} else {
				await transaction`
					update platform.connection_consumer_registrations set status = ${delivery.outcome},
						failure_code = ${delivery.failureCode}, updated_at = clock_timestamp()
					where operation_id = ${claim.itemId}
				`;
			}
			return true;
		});
	}

	close() {
		return this.#client.end();
	}
}
