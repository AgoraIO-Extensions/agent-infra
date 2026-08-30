import postgres from "postgres";

import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";

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
	now: Date;
	leaseExpiresAt: Date;
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
}

export interface RenewOutboxLeaseInput extends ClaimOutboxItemInput {
	deliveryFence: bigint;
}

interface OwnedOutboxLeaseInput {
	itemId: string;
	leaseOwner: string;
	deliveryFence: bigint;
	now: Date;
}

export interface ScheduleOutboxRetryInput extends OwnedOutboxLeaseInput {
	availableAt: Date;
	errorCode: string;
}

export interface CompleteOutboxItemInput extends OwnedOutboxLeaseInput {}

export interface SucceededOutboxItem {
	itemId: string;
	status: "succeeded";
	attemptCount: number;
	deliveryFence: bigint;
}

export interface FailOutboxItemInput extends CompleteOutboxItemInput {
	errorCode: string;
}

export interface FailedOutboxItem {
	itemId: string;
	status: "failed";
	attemptCount: number;
	deliveryFence: bigint;
}

export interface ScheduledOutboxRetry {
	itemId: string;
	status: "retry_scheduled";
	attemptCount: number;
	deliveryFence: bigint;
	availableAt: Date;
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
}

interface TransitionedOutboxRow {
	id: string;
	attempt_count: number;
	delivery_fence: string;
	trace_id: string;
}

interface RetryOutboxRow extends TransitionedOutboxRow {
	available_at: Date;
}

type TerminalOutboxStatus = "succeeded" | "failed";

const symbolicErrorCode = /^[A-Z][A-Z0-9_]{0,63}$/;
const claimInputKeys = ["itemId", "leaseOwner", "now", "leaseExpiresAt"];
const renewInputKeys = [...claimInputKeys, "deliveryFence"];
const ownedLeaseInputKeys = ["itemId", "leaseOwner", "deliveryFence", "now"];
const retryInputKeys = [...ownedLeaseInputKeys, "availableAt", "errorCode"];
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

function requireValidDate(value: unknown, name: string): asserts value is Date {
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
		throw new TypeError(`${name} must be a valid Date`);
	}
}

function requirePositiveFence(value: unknown): asserts value is bigint {
	if (typeof value !== "bigint" || value < 1n) {
		throw new TypeError("deliveryFence must be a positive bigint");
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
	requireValidDate(input.now, "now");
}

function isRetryableDatabaseError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	const code = error.code;
	if (typeof code !== "string") return false;
	return (
		retryableDatabaseCodes.has(code) ||
		code.startsWith("08") ||
		code.startsWith("40") ||
		code.startsWith("53")
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
	};
}

function ownedLiveLease(
	client: ReturnType<typeof postgres>,
	input: OwnedOutboxLeaseInput,
) {
	return client`
		id = ${input.itemId}
		and status = 'processing'
		and lease_owner = ${input.leaseOwner}
		and delivery_fence = ${input.deliveryFence.toString()}
		and lease_expires_at > ${input.now}
	`;
}

async function recordOutboxAttempt(
	transaction: postgres.TransactionSql,
	row: TransitionedOutboxRow,
	eventType: "outbox.retry_scheduled" | "outbox.succeeded" | "outbox.failed",
	occurredAt: Date,
	errorCode?: string,
): Promise<void> {
	await transaction`
		insert into platform.persisted_events
			(event_id, stream_id, sequence, stream_cursor, event_type,
			 payload, trace_id, occurred_at)
		values
			(${`outbox:${row.id}:${row.delivery_fence}`},
			 ${`outbox:${row.id}`}, ${row.delivery_fence}, ${row.delivery_fence},
			 ${eventType},
			 ${transaction.json({
					attemptCount: row.attempt_count,
					deliveryFence: row.delivery_fence,
					...(errorCode ? { errorCode } : {}),
				})},
			 ${row.trace_id}, ${occurredAt})
	`;
}

async function markTerminal<TStatus extends TerminalOutboxStatus>(
	client: ReturnType<typeof postgres>,
	input: CompleteOutboxItemInput,
	status: TStatus,
	errorCode?: string,
): Promise<{
	itemId: string;
	status: TStatus;
	attemptCount: number;
	deliveryFence: bigint;
} | null> {
	requireOwnedLease(input);
	return databaseOperation(() =>
		client.begin(async (transaction) => {
			const rows = await transaction<TransitionedOutboxRow[]>`
			update platform.outbox_items
			set status = ${status},
				lease_owner = null,
				lease_expires_at = null,
				updated_at = ${input.now}
			where ${ownedLiveLease(client, input)}
			returning id, attempt_count, delivery_fence::text, trace_id
		`;
			const row = rows[0];
			if (!row) return null;

			await recordOutboxAttempt(
				transaction,
				row,
				`outbox.${status}`,
				input.now,
				errorCode,
			);
			return {
				itemId: row.id,
				status,
				attemptCount: row.attempt_count,
				deliveryFence: BigInt(row.delivery_fence),
			};
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
			requireValidDate(input.now, "now");
			requireValidDate(input.leaseExpiresAt, "leaseExpiresAt");
			if (input.leaseExpiresAt <= input.now) {
				throw new TypeError("leaseExpiresAt must be after now");
			}

			return databaseOperation(async () => {
				const rows = await client<ClaimedOutboxRow[]>`
					update platform.outbox_items
				set status = 'processing',
					attempt_count = attempt_count + 1,
					lease_owner = ${input.leaseOwner},
					lease_expires_at = ${input.leaseExpiresAt},
					delivery_fence = delivery_fence + 1,
					updated_at = ${input.now}
				where id = ${input.itemId}
					and (
						(status in ('pending', 'retry_scheduled') and available_at <= ${input.now})
						or (status = 'processing' and lease_expires_at <= ${input.now})
					)
				returning id, scope_type, scope_id, operation, payload, trace_id,
					attempt_count, delivery_fence::text, lease_owner, lease_expires_at
				`;
				return rows[0] ? claimedOutboxItem(rows[0]) : null;
			});
		},
		async renew(
			input: RenewOutboxLeaseInput,
		): Promise<ClaimedOutboxItem | null> {
			requireInput(input);
			requireExactKeys(input, renewInputKeys, "renew");
			requireOwnedLease(input);
			requireValidDate(input.leaseExpiresAt, "leaseExpiresAt");
			if (input.leaseExpiresAt <= input.now) {
				throw new TypeError("leaseExpiresAt must be after now");
			}

			return databaseOperation(async () => {
				const rows = await client<ClaimedOutboxRow[]>`
					update platform.outbox_items
				set lease_expires_at = ${input.leaseExpiresAt},
					updated_at = ${input.now}
				where ${ownedLiveLease(client, input)}
					and lease_expires_at < ${input.leaseExpiresAt}
				returning id, scope_type, scope_id, operation, payload, trace_id,
					attempt_count, delivery_fence::text, lease_owner, lease_expires_at
				`;
				return rows[0] ? claimedOutboxItem(rows[0]) : null;
			});
		},
		async scheduleRetry(
			input: ScheduleOutboxRetryInput,
		): Promise<ScheduledOutboxRetry | null> {
			requireInput(input);
			requireExactKeys(input, retryInputKeys, "scheduleRetry");
			requireOwnedLease(input);
			requireValidDate(input.availableAt, "availableAt");
			requireSymbolicErrorCode(input.errorCode);
			if (input.availableAt < input.now) {
				throw new TypeError("availableAt must not be before now");
			}

			return databaseOperation(() =>
				client.begin(async (transaction) => {
					const rows = await transaction<RetryOutboxRow[]>`
					update platform.outbox_items
					set status = 'retry_scheduled',
						available_at = ${input.availableAt},
						lease_owner = null,
						lease_expires_at = null,
						updated_at = ${input.now}
					where ${ownedLiveLease(client, input)}
					returning id, attempt_count, delivery_fence::text, available_at, trace_id
				`;
					const row = rows[0];
					if (!row) return null;

					await recordOutboxAttempt(
						transaction,
						row,
						"outbox.retry_scheduled",
						input.now,
						input.errorCode,
					);

					return {
						itemId: row.id,
						status: "retry_scheduled" as const,
						attemptCount: row.attempt_count,
						deliveryFence: BigInt(row.delivery_fence),
						availableAt: row.available_at,
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
