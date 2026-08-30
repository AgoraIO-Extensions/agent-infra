import postgres from "postgres";

import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";
import { matchesPostgresErrorCode } from "./postgres-error.ts";

export class OutboxStoreError extends Error {
	readonly code = "OUTBOX_STORE_ERROR";
	readonly retryable: boolean;

	constructor(retryable: boolean) {
		super("Outbox store operation failed");
		this.name = "OutboxStoreError";
		this.retryable = retryable;
	}
}

export interface ClaimOutboxItemInput {
	itemId: string;
	leaseOwner: string;
	leaseDurationMs: number;
}

export interface ClaimedOutboxItem {
	itemId: string;
	scopeType: string;
	scopeId: string;
	operation: string;
	payload: Readonly<Record<string, unknown>>;
	traceId: string;
	attemptCount: number;
	deliveryFence: bigint;
	leaseOwner: string;
	leaseExpiresAt: Date;
	updatedAt: Date;
}

export interface RenewOutboxLeaseInput extends ClaimOutboxItemInput {
	deliveryFence: bigint;
}

interface OwnedOutboxLeaseInput {
	itemId: string;
	leaseOwner: string;
	deliveryFence: bigint;
}

export interface ScheduleOutboxRetryInput extends OwnedOutboxLeaseInput {
	retryDelayMs: number;
	errorCode: string;
}

export interface CompleteOutboxItemInput extends OwnedOutboxLeaseInput {}

export interface SucceededOutboxItem {
	itemId: string;
	status: "succeeded";
	attemptCount: number;
	deliveryFence: bigint;
	updatedAt: Date;
}

export interface FailOutboxItemInput extends CompleteOutboxItemInput {
	errorCode: string;
}

export interface FailedOutboxItem {
	itemId: string;
	status: "failed";
	attemptCount: number;
	deliveryFence: bigint;
	updatedAt: Date;
}

export interface ScheduledOutboxRetry {
	itemId: string;
	status: "retry_scheduled";
	attemptCount: number;
	deliveryFence: bigint;
	availableAt: Date;
	updatedAt: Date;
}

export interface PostgresOutboxStoreOptions {
	databaseUrl: string;
}

interface ClaimedOutboxRow {
	id: string;
	scope_type: string;
	scope_id: string;
	operation: string;
	payload: Record<string, unknown>;
	trace_id: string;
	attempt_count: number;
	delivery_fence: string;
	lease_owner: string;
	lease_expires_at: Date;
	updated_at: Date;
}

interface TransitionedOutboxRow {
	id: string;
	attempt_count: number;
	delivery_fence: string;
	trace_id: string;
	updated_at: Date;
}

interface RetryOutboxRow extends TransitionedOutboxRow {
	available_at: Date;
}

type TerminalOutboxStatus = "succeeded" | "failed";

const symbolicErrorCode = /^[A-Z][A-Z0-9_]{0,63}$/;
const maximumDurationMs = 86_400_000;
const claimInputKeys = ["itemId", "leaseOwner", "leaseDurationMs"];
const renewInputKeys = [...claimInputKeys, "deliveryFence"];
const ownedLeaseInputKeys = ["itemId", "leaseOwner", "deliveryFence"];
const retryInputKeys = [...ownedLeaseInputKeys, "retryDelayMs", "errorCode"];
const failureInputKeys = [...ownedLeaseInputKeys, "errorCode"];
const retryableDatabaseCodes = new Set([
	"CONNECT_TIMEOUT",
	"CONNECTION_CLOSED",
	"CONNECTION_DESTROYED",
	"CONNECTION_ENDED",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTDOWN",
	"EHOSTUNREACH",
	"ENETDOWN",
	"ENETUNREACH",
	"EPIPE",
	"ETIMEDOUT",
	"55P03",
	"57P01",
	"57P02",
	"57P03",
]);

function requireInput(value: unknown): void {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("input must be an object");
	}
}

function requireExactKeys(
	value: object,
	allowedKeys: readonly string[],
	name: string,
): void {
	if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
		throw new TypeError(`${name} input contains unsupported fields`);
	}
}

function requireNonEmpty(
	value: unknown,
	name: string,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
}

function requirePositiveFence(value: unknown): asserts value is bigint {
	if (typeof value !== "bigint" || value < 1n) {
		throw new TypeError("deliveryFence must be a positive bigint");
	}
}

function requireDuration(
	value: unknown,
	name: "leaseDurationMs" | "retryDelayMs",
	minimum: number,
): asserts value is number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < minimum ||
		value > maximumDurationMs
	) {
		throw new TypeError(
			`${name} must be an integer between ${minimum} and ${maximumDurationMs}`,
		);
	}
}

function requireSymbolicErrorCode(value: unknown): asserts value is string {
	if (typeof value !== "string" || !symbolicErrorCode.test(value)) {
		throw new TypeError("errorCode must be a symbolic code");
	}
}

function requireOwnedLease(input: OwnedOutboxLeaseInput): void {
	requireInput(input);
	requireNonEmpty(input.itemId, "itemId");
	requireNonEmpty(input.leaseOwner, "leaseOwner");
	requirePositiveFence(input.deliveryFence);
}

function isRetryableDatabaseError(error: unknown): boolean {
	return matchesPostgresErrorCode(
		error,
		(code) =>
			retryableDatabaseCodes.has(code) ||
			code.startsWith("08") ||
			code.startsWith("40") ||
			code.startsWith("53"),
	);
}

async function databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw new OutboxStoreError(isRetryableDatabaseError(error));
	}
}

function claimedOutboxItem(row: ClaimedOutboxRow): ClaimedOutboxItem {
	return {
		itemId: row.id,
		scopeType: row.scope_type,
		scopeId: row.scope_id,
		operation: row.operation,
		payload: row.payload,
		traceId: row.trace_id,
		attemptCount: row.attempt_count,
		deliveryFence: BigInt(row.delivery_fence),
		leaseOwner: row.lease_owner,
		leaseExpiresAt: row.lease_expires_at,
		updatedAt: row.updated_at,
	};
}

async function lockOutboxItem(
	transaction: postgres.TransactionSql,
	itemId: string,
): Promise<boolean> {
	const rows = await transaction<{ id: string }[]>`
		select id from platform.outbox_items where id = ${itemId} for update
	`;
	return rows.length === 1;
}

function ownedLiveLease(
	transaction: postgres.TransactionSql,
	input: OwnedOutboxLeaseInput,
) {
	return transaction`
		id = ${input.itemId}
		and status = 'processing'
		and lease_owner = ${input.leaseOwner}
		and delivery_fence = ${input.deliveryFence.toString()}
		and lease_expires_at > decision_time.decision_at
	`;
}

export async function transitionTerminalAfterLock<
	TStatus extends TerminalOutboxStatus,
>(
	transaction: postgres.TransactionSql,
	input: CompleteOutboxItemInput,
	status: TStatus,
	errorCode?: string,
): Promise<{
	itemId: string;
	status: TStatus;
	attemptCount: number;
	deliveryFence: bigint;
	updatedAt: Date;
} | null> {
	const eventType = `outbox.${status}`;
	const rows = await transaction<TransitionedOutboxRow[]>`
		with decision_time as materialized (
			select clock_timestamp() as decision_at
		), transitioned as (
			update platform.outbox_items
			set status = ${status},
				lease_owner = null,
				lease_expires_at = null,
				updated_at = decision_time.decision_at
			from decision_time
			where ${ownedLiveLease(transaction, input)}
			returning id, attempt_count, delivery_fence, trace_id, updated_at
		), attempt_event as (
			insert into platform.persisted_events
				(event_id, stream_id, sequence, stream_cursor, event_type,
				 payload, trace_id, occurred_at)
			select concat('outbox:', transitioned.id, ':', transitioned.delivery_fence),
				concat('outbox:', transitioned.id),
				transitioned.delivery_fence, transitioned.delivery_fence, ${eventType},
				jsonb_strip_nulls(jsonb_build_object(
					'attemptCount', transitioned.attempt_count,
					'deliveryFence', transitioned.delivery_fence::text,
					'errorCode', ${errorCode ?? null}::text
				)),
				transitioned.trace_id, transitioned.updated_at
			from transitioned
			returning event_id
		)
		select transitioned.id, transitioned.attempt_count,
			transitioned.delivery_fence::text as delivery_fence,
			transitioned.trace_id, transitioned.updated_at
		from transitioned
		join attempt_event on true
	`;
	const row = rows[0];
	if (!row) return null;
	return {
		itemId: row.id,
		status,
		attemptCount: row.attempt_count,
		deliveryFence: BigInt(row.delivery_fence),
		updatedAt: row.updated_at,
	};
}

async function markTerminal<TStatus extends TerminalOutboxStatus>(
	client: ReturnType<typeof postgres>,
	input: CompleteOutboxItemInput,
	status: TStatus,
	errorCode?: string,
) {
	requireOwnedLease(input);
	return databaseOperation(() =>
		client.begin(async (transaction) => {
			if (!(await lockOutboxItem(transaction, input.itemId))) return null;
			return transitionTerminalAfterLock(transaction, input, status, errorCode);
		}),
	);
}

export function createPostgresOutboxStore(options: PostgresOutboxStoreOptions) {
	requireInput(options);
	const databaseUrl = platformDatabaseUrlFromEnvironment({
		PLATFORM_DATABASE_URL: options.databaseUrl,
	});
	const client = postgres(databaseUrl, { max: 1 });
	return {
		async claim(
			input: ClaimOutboxItemInput,
		): Promise<ClaimedOutboxItem | null> {
			requireInput(input);
			requireExactKeys(input, claimInputKeys, "claim");
			requireNonEmpty(input.itemId, "itemId");
			requireNonEmpty(input.leaseOwner, "leaseOwner");
			requireDuration(input.leaseDurationMs, "leaseDurationMs", 1);

			return databaseOperation(() =>
				client.begin(async (transaction) => {
					if (!(await lockOutboxItem(transaction, input.itemId))) return null;
					const rows = await transaction<ClaimedOutboxRow[]>`
							with decision_time as materialized (
								select clock_timestamp() as decision_at
							)
							update platform.outbox_items
						set status = 'processing',
							attempt_count = attempt_count + 1,
							lease_owner = ${input.leaseOwner},
							lease_expires_at = decision_time.decision_at +
								(${input.leaseDurationMs}::bigint * interval '1 millisecond'),
							delivery_fence = delivery_fence + 1,
							updated_at = decision_time.decision_at
						from decision_time
						where id = ${input.itemId}
							and (
								(status in ('pending', 'retry_scheduled')
									and available_at <= decision_time.decision_at)
								or (status = 'processing'
									and lease_expires_at <= decision_time.decision_at)
							)
					returning id, scope_type, scope_id, operation, payload, trace_id,
						attempt_count, delivery_fence::text, lease_owner, lease_expires_at,
						updated_at
						`;
					return rows[0] ? claimedOutboxItem(rows[0]) : null;
				}),
			);
		},
		async renew(
			input: RenewOutboxLeaseInput,
		): Promise<ClaimedOutboxItem | null> {
			requireInput(input);
			requireExactKeys(input, renewInputKeys, "renew");
			requireOwnedLease(input);
			requireDuration(input.leaseDurationMs, "leaseDurationMs", 1);

			return databaseOperation(() =>
				client.begin(async (transaction) => {
					if (!(await lockOutboxItem(transaction, input.itemId))) return null;
					const rows = await transaction<ClaimedOutboxRow[]>`
							with decision_time as materialized (
								select clock_timestamp() as decision_at
							)
							update platform.outbox_items
						set lease_expires_at = greatest(
								lease_expires_at,
								decision_time.decision_at +
									(${input.leaseDurationMs}::bigint * interval '1 millisecond')
							),
							updated_at = decision_time.decision_at
						from decision_time
						where ${ownedLiveLease(transaction, input)}
					returning id, scope_type, scope_id, operation, payload, trace_id,
						attempt_count, delivery_fence::text, lease_owner, lease_expires_at,
						updated_at
						`;
					return rows[0] ? claimedOutboxItem(rows[0]) : null;
				}),
			);
		},
		async scheduleRetry(
			input: ScheduleOutboxRetryInput,
		): Promise<ScheduledOutboxRetry | null> {
			requireInput(input);
			requireExactKeys(input, retryInputKeys, "scheduleRetry");
			requireOwnedLease(input);
			requireDuration(input.retryDelayMs, "retryDelayMs", 0);
			requireSymbolicErrorCode(input.errorCode);

			return databaseOperation(() =>
				client.begin(async (transaction) => {
					if (!(await lockOutboxItem(transaction, input.itemId))) return null;
					const rows = await transaction<RetryOutboxRow[]>`
							with decision_time as materialized (
								select clock_timestamp() as decision_at
							), transitioned as (
							update platform.outbox_items
							set status = 'retry_scheduled',
								available_at = decision_time.decision_at +
									(${input.retryDelayMs}::bigint * interval '1 millisecond'),
								lease_owner = null,
								lease_expires_at = null,
								updated_at = decision_time.decision_at
							from decision_time
							where ${ownedLiveLease(transaction, input)}
						returning id, attempt_count, delivery_fence, available_at,
							trace_id, updated_at
						), attempt_event as (
							insert into platform.persisted_events
								(event_id, stream_id, sequence, stream_cursor, event_type,
								 payload, trace_id, occurred_at)
							select concat(
									'outbox:', transitioned.id, ':', transitioned.delivery_fence
								),
								concat('outbox:', transitioned.id),
								transitioned.delivery_fence, transitioned.delivery_fence,
								'outbox.retry_scheduled',
								jsonb_build_object(
									'attemptCount', transitioned.attempt_count,
									'deliveryFence', transitioned.delivery_fence::text,
									'errorCode', ${input.errorCode}::text
								),
								transitioned.trace_id, transitioned.updated_at
							from transitioned
							returning event_id
						)
						select transitioned.id, transitioned.attempt_count,
							transitioned.delivery_fence::text as delivery_fence,
							transitioned.available_at, transitioned.trace_id,
							transitioned.updated_at
						from transitioned
						join attempt_event on true
					`;
					const row = rows[0];
					if (!row) return null;

					return {
						itemId: row.id,
						status: "retry_scheduled" as const,
						attemptCount: row.attempt_count,
						deliveryFence: BigInt(row.delivery_fence),
						availableAt: row.available_at,
						updatedAt: row.updated_at,
					};
				}),
			);
		},
		async markSucceeded(
			input: CompleteOutboxItemInput,
		): Promise<SucceededOutboxItem | null> {
			requireInput(input);
			requireExactKeys(input, ownedLeaseInputKeys, "markSucceeded");
			return markTerminal(client, input, "succeeded");
		},
		async markFailed(
			input: FailOutboxItemInput,
		): Promise<FailedOutboxItem | null> {
			requireInput(input);
			requireExactKeys(input, failureInputKeys, "markFailed");
			requireSymbolicErrorCode(input.errorCode);
			return markTerminal(client, input, "failed", input.errorCode);
		},
		async close(): Promise<void> {
			await databaseOperation(() => client.end());
		},
	};
}
