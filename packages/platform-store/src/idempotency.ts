import { randomUUID } from "node:crypto";

import {
	type PlatformIdempotencyBoundScopeV1,
	PlatformIdempotencyError,
	type PlatformIdempotencyPortV1,
	platformIdempotencyV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";

export interface PostgresPlatformIdempotencyOptionsV1 {
	readonly databaseUrl: string;
	readonly scope: PlatformIdempotencyBoundScopeV1;
}

interface IdempotencyRow {
	request_digest: string;
	status: "reserved" | "completed";
	result: unknown;
}

type PostgresJson = Parameters<ReturnType<typeof postgres>["json"]>[0];

function storedResult(input: unknown) {
	try {
		return platformIdempotencyV1.parseResult(input);
	} catch {
		throw new PlatformIdempotencyError("unavailable");
	}
}

async function databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof PlatformIdempotencyError) throw error;
		throw new PlatformIdempotencyError("unavailable");
	}
}

export function openPostgresPlatformIdempotencyStore(
	options: PostgresPlatformIdempotencyOptionsV1,
) {
	const scope = platformIdempotencyV1.parseScope(options.scope);
	let client: ReturnType<typeof postgres>;
	try {
		client = postgres(options.databaseUrl);
	} catch {
		throw new PlatformIdempotencyError("unavailable");
	}

	const adapter = {
		async reserve(input: Parameters<PlatformIdempotencyPortV1["reserve"]>[0]) {
			const { key, requestDigest } =
				platformIdempotencyV1.parseReserveInput(input);
			const reservationId = randomUUID();
			return databaseOperation(async () => {
				const inserted = await client<{ reservation_id: string }[]>`
					insert into platform.idempotency_records
						(id, scope_type, scope_id, actor_id, command_type,
						 idempotency_key, request_digest)
					values
						(${reservationId}, ${scope.resourceType}, ${scope.resourceId},
						 ${scope.actorId}, ${scope.operation}, ${key}, ${requestDigest})
					on conflict (scope_type, scope_id, actor_id, command_type, idempotency_key)
					do nothing
					returning id as reservation_id
				`;
				if (inserted[0]) return { state: "reserved" as const, reservationId };

				const [record] = await client<IdempotencyRow[]>`
					select request_digest, status, result
					from platform.idempotency_records
					where scope_type = ${scope.resourceType}
						and scope_id = ${scope.resourceId}
						and actor_id = ${scope.actorId}
						and command_type = ${scope.operation}
						and idempotency_key = ${key}
				`;
				if (!record) throw new PlatformIdempotencyError("unavailable");
				if (record.request_digest !== requestDigest) {
					return { state: "conflict" as const };
				}
				if (record.status === "reserved")
					return { state: "in_progress" as const };
				return {
					state: "completed" as const,
					result: storedResult(record.result),
				};
			});
		},

		async complete(
			input: Parameters<PlatformIdempotencyPortV1["complete"]>[0],
		) {
			const { reservationId, result } =
				platformIdempotencyV1.parseCompleteInput(input);
			return databaseOperation(async () => {
				const completed = await client<{ result: unknown }[]>`
					update platform.idempotency_records
					set status = 'completed',
						result = ${client.json(result as unknown as PostgresJson)},
						updated_at = now()
					where id = ${reservationId}
						and scope_type = ${scope.resourceType}
						and scope_id = ${scope.resourceId}
						and actor_id = ${scope.actorId}
						and command_type = ${scope.operation}
						and status = 'reserved'
					returning result
				`;
				if (completed[0]) return { state: "completed" as const, result };

				const [record] = await client<
					Pick<IdempotencyRow, "status" | "result">[]
				>`
					select status, result
					from platform.idempotency_records
					where id = ${reservationId}
						and scope_type = ${scope.resourceType}
						and scope_id = ${scope.resourceId}
						and actor_id = ${scope.actorId}
						and command_type = ${scope.operation}
				`;
				if (record?.status !== "completed")
					return { state: "conflict" as const };
				return {
					state: "completed" as const,
					result: storedResult(record.result),
				};
			});
		},

		async reconcileObservedCompletion(
			input: Parameters<
				PlatformIdempotencyPortV1["reconcileObservedCompletion"]
			>[0],
		) {
			const { key, requestDigest, observedResult } =
				platformIdempotencyV1.parseObservedCompletionInput(input);
			return databaseOperation(async () => {
				const completed = await client<{ result: unknown }[]>`
					update platform.idempotency_records
					set status = 'completed',
						result = ${client.json(observedResult as unknown as PostgresJson)},
						updated_at = now()
					where scope_type = ${scope.resourceType}
						and scope_id = ${scope.resourceId}
						and actor_id = ${scope.actorId}
						and command_type = ${scope.operation}
						and idempotency_key = ${key}
						and request_digest = ${requestDigest}
						and status = 'reserved'
					returning result
				`;
				if (completed[0]) {
					return { state: "completed" as const, result: observedResult };
				}

				const [record] = await client<IdempotencyRow[]>`
					select request_digest, status, result
					from platform.idempotency_records
					where scope_type = ${scope.resourceType}
						and scope_id = ${scope.resourceId}
						and actor_id = ${scope.actorId}
						and command_type = ${scope.operation}
						and idempotency_key = ${key}
				`;
				if (!record || record.request_digest !== requestDigest) {
					return { state: "conflict" as const };
				}
				if (record.status === "reserved")
					return { state: "in_progress" as const };
				return {
					state: "completed" as const,
					result: storedResult(record.result),
				};
			});
		},

		close() {
			return databaseOperation(() => client.end());
		},
	} satisfies PlatformIdempotencyPortV1 & { close(): Promise<void> };

	return adapter;
}
