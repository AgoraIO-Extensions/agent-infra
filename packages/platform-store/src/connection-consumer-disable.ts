import {
	type ConnectionConsumerDisableDeliveryV1,
	type ConnectionConsumerDisableIntentV1,
	type ConnectionConsumerRegistrationPolicyV1,
	captureConnectionConsumerRegistrationPolicyV1,
	connectionConsumerDisableOperationV1,
	parseConnectionConsumerDisableDeliveryV1,
	parseConnectionConsumerDisableIntentV1,
	planConnectionConsumerDisableIdentityV1,
	planConnectionConsumerDisableV1,
} from "@agent-infra/platform-core";
import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import type { ClaimedOutboxItem } from "./outbox.js";
import {
	connectionConsumerDisables,
	connectionConsumerRegistrations,
	outboxItems,
} from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

/**
 * Runs inside the accepted `disable_agent` transaction after the Agent row update. Every
 * registration status writer locks the same Agent row, so the status read here cannot change
 * before this transaction commits. Only this Agent's own persisted registration is selected.
 */
export async function insertConnectionConsumerDisableV1(
	transaction: Transaction,
	input: {
		readonly agentId: string;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	},
): Promise<void> {
	const [registration] = await transaction
		.select({
			operationId: connectionConsumerRegistrations.operationId,
			sourceNamespace: connectionConsumerRegistrations.sourceNamespace,
			status: connectionConsumerRegistrations.status,
		})
		.from(connectionConsumerRegistrations)
		.where(eq(connectionConsumerRegistrations.agentId, input.agentId));
	// Unconfigured deployments and confirmed non-effective registrations have nothing to disable.
	if (!registration || registration.status === "failed") return;
	const identity = planConnectionConsumerDisableIdentityV1({
		registrationOperationId: registration.operationId,
		sourceNamespace: registration.sourceNamespace,
		platformAgentId: input.agentId,
	});
	const [inserted] = await transaction
		.insert(connectionConsumerDisables)
		.values({
			operationId: identity.operationId,
			registrationOperationId: identity.registrationOperationId,
			agentId: input.agentId,
			sourceNamespace: identity.sourceNamespace,
			idempotencyKey: identity.idempotencyKey,
			createdAt: input.occurredAt,
			updatedAt: input.occurredAt,
		})
		.onConflictDoNothing()
		.returning({ operationId: connectionConsumerDisables.operationId });
	if (!inserted) {
		const [existing] = await transaction
			.select({
				operationId: connectionConsumerDisables.operationId,
				registrationOperationId:
					connectionConsumerDisables.registrationOperationId,
			})
			.from(connectionConsumerDisables)
			.where(eq(connectionConsumerDisables.agentId, input.agentId));
		if (
			existing?.operationId !== identity.operationId ||
			existing.registrationOperationId !== identity.registrationOperationId
		)
			throw new Error("CONNECTION_CONSUMER_DISABLE_CONFLICT");
		return;
	}
	await transaction.insert(outboxItems).values({
		id: identity.operationId,
		scopeType: "agent",
		scopeId: input.agentId,
		operation: connectionConsumerDisableOperationV1,
		payload: {
			schemaVersion: 1,
			operationId: identity.operationId,
			platformAgentId: input.agentId,
			registrationOperationId: identity.registrationOperationId,
		},
		traceId: input.traceId,
		requestId: input.requestId,
		availableAt: input.occurredAt,
		createdAt: input.occurredAt,
		updatedAt: input.occurredAt,
	});
}

type DisableRow = {
	status: string;
	request: unknown;
	source_namespace: string;
	registration_operation_id: string;
	agent_status: string | null;
	registration_status: string;
	registration_request: unknown;
	registration_receipt: unknown;
};

export type ConnectionConsumerDisableAttemptV1 =
	| {
			readonly outcome:
				| "waiting"
				| "pending"
				| "unknown"
				| "disabled"
				| "failed"
				| "not_required";
	  }
	| {
			readonly outcome: "deliver";
			readonly mode: "disable" | "reconcile";
			readonly intent: ConnectionConsumerDisableIntentV1;
	  };

/** Reuses the outbox lease and fence; the table has no independent claim or scheduler. */
export class PostgresConnectionConsumerDisableStoreV1 {
	readonly #client;
	readonly #policy;
	constructor(input: {
		readonly databaseUrl: string;
		readonly policy: ConnectionConsumerRegistrationPolicyV1;
	}) {
		this.#policy = captureConnectionConsumerRegistrationPolicyV1(input.policy);
		this.#client = postgres(input.databaseUrl, { max: 2 });
	}

	async pending(limit = 20): Promise<readonly string[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new Error("CONNECTION_CONSUMER_DISABLE_INVALID");
		const rows = await this.#client<{ id: string }[]>`
			select o.id from platform.outbox_items o
			join platform.connection_consumer_disables d on d.operation_id = o.id
			where o.operation = ${connectionConsumerDisableOperationV1}
				and d.source_namespace = ${this.#policy.sourceNamespace}
				and ((o.status in ('pending','retry_scheduled') and o.available_at <= clock_timestamp())
					or (o.status = 'processing' and o.lease_expires_at <= clock_timestamp()))
			order by o.available_at, o.id limit ${limit}
		`;
		return rows.map((row) => row.id);
	}

	async #locked(
		transaction: postgres.TransactionSql,
		claim: ClaimedOutboxItem,
	): Promise<DisableRow | undefined> {
		const [outbox] = await transaction<{ payload: unknown }[]>`
			select payload from platform.outbox_items
			where id = ${claim.itemId} and operation = ${connectionConsumerDisableOperationV1}
				and scope_type = 'agent' and scope_id = ${claim.scopeId}
				and status = 'processing' and lease_owner = ${claim.leaseOwner}
				and delivery_fence = ${claim.deliveryFence.toString()}
				and lease_expires_at > clock_timestamp() for update
		`;
		if (!outbox) return undefined;
		const [row] = await transaction<DisableRow[]>`
			select d.status, d.request, d.source_namespace, d.registration_operation_id,
				a.status as agent_status, r.status as registration_status,
				r.request as registration_request, r.receipt as registration_receipt
			from platform.connection_consumer_disables d
			join platform.connection_consumer_registrations r
				on r.operation_id = d.registration_operation_id and r.agent_id = d.agent_id
			left join platform.agent_applications a on a.agent_id = d.agent_id
			where d.operation_id = ${claim.itemId} and d.agent_id = ${claim.scopeId}
			for update of d
		`;
		if (!row) return undefined;
		const payload = outbox.payload as Record<string, unknown> | null;
		if (
			!payload ||
			Object.keys(payload).length !== 4 ||
			payload.schemaVersion !== 1 ||
			payload.operationId !== claim.itemId ||
			payload.platformAgentId !== claim.scopeId ||
			payload.registrationOperationId !== row.registration_operation_id
		)
			throw new Error("CONNECTION_CONSUMER_DISABLE_INVALID");
		return row;
	}

	#intent(row: DisableRow) {
		const intent = parseConnectionConsumerDisableIntentV1(row.request);
		if (intent.registrationOperationId !== row.registration_operation_id)
			throw new Error("CONNECTION_CONSUMER_DISABLE_INVALID");
		return intent;
	}

	async #mark(
		transaction: postgres.TransactionSql,
		claim: ClaimedOutboxItem,
		status: "waiting" | "pending" | "unknown" | "not_required",
		failureCode: string | null,
	) {
		await transaction`
			update platform.connection_consumer_disables set status = ${status},
				failure_code = ${failureCode}, updated_at = clock_timestamp()
			where operation_id = ${claim.itemId}
		`;
	}

	async beginAttempt(
		claim: ClaimedOutboxItem,
		adapterAvailable: boolean,
	): Promise<ConnectionConsumerDisableAttemptV1 | undefined> {
		return this.#client.begin(async (transaction) => {
			const row = await this.#locked(transaction, claim);
			if (!row) return undefined;
			if (
				row.status === "disabled" ||
				row.status === "failed" ||
				row.status === "not_required"
			)
				return { outcome: row.status };
			if (row.agent_status !== "disabled")
				throw new Error("CONNECTION_CONSUMER_DISABLE_INVALID");
			if (row.status === "waiting" || row.status === "pending") {
				if (row.registration_status === "failed") {
					await this.#mark(transaction, claim, "not_required", null);
					return { outcome: "not_required" };
				}
				if (row.registration_status !== "registered") {
					await this.#mark(
						transaction,
						claim,
						"waiting",
						"CONNECTION_DISABLE_ASSOCIATION_UNCONFIRMED",
					);
					return { outcome: "waiting" };
				}
				if (!adapterAvailable) {
					await this.#mark(
						transaction,
						claim,
						"pending",
						"CONNECTION_DISABLE_ADAPTER_UNAVAILABLE",
					);
					return { outcome: "pending" };
				}
				let intent: ConnectionConsumerDisableIntentV1;
				try {
					// Never sent: regenerate against the current approved policy before each send.
					intent = planConnectionConsumerDisableV1({
						policy: this.#policy,
						registration: {
							intent: row.registration_request,
							receipt: row.registration_receipt,
						},
					});
				} catch {
					await this.#mark(
						transaction,
						claim,
						"pending",
						"CONNECTION_DISABLE_AUTHORITY_CHANGED",
					);
					return { outcome: "pending" };
				}
				if (intent.operationId !== claim.itemId)
					throw new Error("CONNECTION_CONSUMER_DISABLE_INVALID");
				await transaction`
					update platform.connection_consumer_disables set status = 'sending',
						request = ${transaction.json({ ...intent })}, request_digest = ${intent.requestDigest},
						sending_at = clock_timestamp(), failure_code = null, updated_at = clock_timestamp()
					where operation_id = ${claim.itemId}
				`;
				return { outcome: "deliver", mode: "disable", intent };
			}
			// `sending` after a crash or lease loss is uncertain; only the original command is read back.
			const intent = this.#intent(row);
			if (
				!adapterAvailable ||
				intent.sourceNamespace !== this.#policy.sourceNamespace
			) {
				await this.#mark(
					transaction,
					claim,
					"unknown",
					adapterAvailable
						? "CONNECTION_DISABLE_AUTHORITY_CHANGED"
						: "CONNECTION_DISABLE_ADAPTER_UNAVAILABLE",
				);
				return { outcome: "unknown" };
			}
			await this.#mark(transaction, claim, "unknown", null);
			return { outcome: "deliver", mode: "reconcile", intent };
		});
	}

	/** Guard the lease, policy source and state immediately before adapter I/O. */
	async current(
		claim: ClaimedOutboxItem,
		mode: "disable" | "reconcile",
	): Promise<boolean> {
		return this.#client.begin(async (transaction) => {
			const row = await this.#locked(transaction, claim);
			return (
				!!row &&
				row.agent_status === "disabled" &&
				row.status === (mode === "disable" ? "sending" : "unknown") &&
				this.#intent(row).sourceNamespace === this.#policy.sourceNamespace
			);
		});
	}

	/** Only the current sender can establish that its planned disable call was never started. */
	async deferBeforeSend(
		claim: ClaimedOutboxItem,
		mode: "disable" | "reconcile",
	): Promise<boolean> {
		return this.#client.begin(async (transaction) => {
			const row = await this.#locked(transaction, claim);
			if (!row || !["sending", "unknown"].includes(row.status)) return false;
			if (mode === "disable" && row.status === "sending")
				await transaction`
					update platform.connection_consumer_disables set status = 'pending',
						request = null, request_digest = null, sending_at = null,
						failure_code = 'CONNECTION_DISABLE_NOT_SENT', updated_at = clock_timestamp()
					where operation_id = ${claim.itemId}
				`;
			else
				await this.#mark(
					transaction,
					claim,
					"unknown",
					"CONNECTION_DISABLE_NOT_SENT",
				);
			return true;
		});
	}

	async complete(
		claim: ClaimedOutboxItem,
		result: ConnectionConsumerDisableDeliveryV1,
	): Promise<boolean> {
		return this.#client.begin(async (transaction) => {
			const row = await this.#locked(transaction, claim);
			if (!row || !["sending", "unknown"].includes(row.status)) return false;
			const intent = this.#intent(row);
			const delivery = parseConnectionConsumerDisableDeliveryV1(result, intent);
			if (delivery.outcome === "disabled") {
				await transaction`
					update platform.connection_consumer_disables set status = 'disabled',
						receipt = ${transaction.json({ ...delivery.receipt })},
						result_revision = ${delivery.receipt.resultRevision},
						disabled_at = clock_timestamp(), failure_code = null, updated_at = clock_timestamp()
					where operation_id = ${claim.itemId}
				`;
			} else {
				await transaction`
					update platform.connection_consumer_disables set status = ${delivery.outcome},
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
