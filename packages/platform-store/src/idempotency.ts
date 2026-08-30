import { createHash, randomUUID } from "node:crypto";

import postgres from "postgres";

const maxCanonicalBytes = 64 * 1024;
const maxJsonDepth = 32;
const maxResultReferences = 8;
const idempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const requestDigestPattern = /^[a-f0-9]{64}$/;
const reservationIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const platformOperationPattern = /^platform\.[a-z][a-z0-9-]{0,54}$/;
const platformResourceTypes = new Set<PlatformIdempotencyResourceTypeV1>([
	"agent_application",
	"agent",
	"configuration",
	"conversation",
	"message",
	"execution",
	"stop_request",
]);

export type PlatformIdempotencyRequestJson =
	| null
	| boolean
	| number
	| string
	| readonly PlatformIdempotencyRequestJson[]
	| { readonly [key: string]: PlatformIdempotencyRequestJson };

export type PlatformIdempotencyResourceTypeV1 =
	| "agent_application"
	| "agent"
	| "configuration"
	| "conversation"
	| "message"
	| "execution"
	| "stop_request";

export interface PlatformIdempotencyBoundScope {
	readonly resourceType: PlatformIdempotencyResourceTypeV1;
	readonly resourceId: string;
	readonly actorId: string;
	readonly operation: `platform.${string}`;
}

export interface PlatformIdempotencyDomainResultV1 {
	readonly schemaVersion: 1;
	readonly outcome: "accepted" | "completed";
	readonly references: readonly {
		readonly resourceType: PlatformIdempotencyResourceTypeV1;
		readonly resourceId: string;
		readonly revision: number | null;
	}[];
}

export class PlatformIdempotencyError extends Error {
	readonly code: "invalid_input" | "unavailable";

	constructor(code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid idempotency input"
				: "Idempotency store unavailable",
		);
		this.name = "PlatformIdempotencyError";
		this.code = code;
	}
}

interface IdempotencyRow {
	id: string;
	request_digest: string;
	status: "reserved" | "completed";
	result: unknown;
}

type ErrorCode = PlatformIdempotencyError["code"];
type PostgresJson = Parameters<ReturnType<typeof postgres>["json"]>[0];

function isPlatformResourceType(
	value: unknown,
): value is PlatformIdempotencyResourceTypeV1 {
	return (
		typeof value === "string" &&
		platformResourceTypes.has(value as PlatformIdempotencyResourceTypeV1)
	);
}

function fail(code: ErrorCode): never {
	throw new PlatformIdempotencyError(code);
}

function validateText(
	value: unknown,
	maxLength: number,
	code: ErrorCode = "invalid_input",
): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		value.includes("\0")
	) {
		fail(code);
	}
}

function exactObject(
	value: unknown,
	keys: readonly string[],
	code: ErrorCode,
): Readonly<Record<string, unknown>> {
	if (value === null || Array.isArray(value) || typeof value !== "object") {
		fail(code);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) fail(code);
	if (Object.getOwnPropertySymbols(value).length > 0) fail(code);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const actualKeys = Object.keys(descriptors).sort();
	const expectedKeys = [...keys].sort();
	if (
		actualKeys.length !== expectedKeys.length ||
		actualKeys.some((key, index) => key !== expectedKeys[index])
	) {
		fail(code);
	}
	for (const key of actualKeys) {
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
			fail(code);
		}
	}
	return value as Readonly<Record<string, unknown>>;
}

function canonicalJson(value: unknown, depth = 0): string {
	if (depth > maxJsonDepth) fail("invalid_input");
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail("invalid_input");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (Reflect.ownKeys(value).length !== value.length + 1)
			fail("invalid_input");
		return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
	}
	if (typeof value !== "object") fail("invalid_input");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		fail("invalid_input");
	if (Object.getOwnPropertySymbols(value).length > 0) fail("invalid_input");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Object.keys(descriptors).sort();
	return `{${keys
		.map((key) => {
			const descriptor = descriptors[key];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				fail("invalid_input");
			}
			return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1)}`;
		})
		.join(",")}}`;
}

export function canonicalPlatformIdempotencyRequestDigest(
	request: Readonly<Record<string, PlatformIdempotencyRequestJson>>,
): string {
	try {
		if (
			request === null ||
			Array.isArray(request) ||
			typeof request !== "object"
		) {
			fail("invalid_input");
		}
		const canonical = canonicalJson(request);
		if (Buffer.byteLength(canonical, "utf8") > maxCanonicalBytes) {
			fail("invalid_input");
		}
		return createHash("sha256").update(canonical, "utf8").digest("hex");
	} catch (error) {
		if (error instanceof PlatformIdempotencyError) throw error;
		fail("invalid_input");
	}
}

function validateBoundScope(input: unknown): PlatformIdempotencyBoundScope {
	try {
		const scope = exactObject(
			input,
			["resourceType", "resourceId", "actorId", "operation"],
			"invalid_input",
		);
		if (!isPlatformResourceType(scope.resourceType)) {
			fail("invalid_input");
		}
		validateText(scope.resourceId, 512);
		validateText(scope.actorId, 512);
		if (
			typeof scope.operation !== "string" ||
			!platformOperationPattern.test(scope.operation)
		) {
			fail("invalid_input");
		}
		return {
			resourceType: scope.resourceType,
			resourceId: scope.resourceId,
			actorId: scope.actorId,
			operation: scope.operation as `platform.${string}`,
		};
	} catch (error) {
		if (error instanceof PlatformIdempotencyError) throw error;
		fail("invalid_input");
	}
}

function mapDomainResult(
	input: unknown,
	code: ErrorCode = "invalid_input",
): PlatformIdempotencyDomainResultV1 {
	try {
		const result = exactObject(
			input,
			["schemaVersion", "outcome", "references"],
			code,
		);
		if (
			result.schemaVersion !== 1 ||
			(result.outcome !== "accepted" && result.outcome !== "completed") ||
			!Array.isArray(result.references) ||
			result.references.length < 1 ||
			result.references.length > maxResultReferences ||
			Reflect.ownKeys(result.references).length !== result.references.length + 1
		) {
			fail(code);
		}
		const references = result.references.map((inputReference) => {
			const reference = exactObject(
				inputReference,
				["resourceType", "resourceId", "revision"],
				code,
			);
			if (!isPlatformResourceType(reference.resourceType)) fail(code);
			validateText(reference.resourceId, 512, code);
			const revision = reference.revision;
			if (
				revision !== null &&
				(typeof revision !== "number" ||
					!Number.isSafeInteger(revision) ||
					revision < 0)
			) {
				fail(code);
			}
			return {
				resourceType: reference.resourceType,
				resourceId: reference.resourceId,
				revision,
			};
		});
		return {
			schemaVersion: 1,
			outcome: result.outcome,
			references,
		};
	} catch (error) {
		if (error instanceof PlatformIdempotencyError) throw error;
		fail(code);
	}
}

async function withoutSqlDetails<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof PlatformIdempotencyError) throw error;
		throw new PlatformIdempotencyError("unavailable");
	}
}

export function openPostgresPlatformIdempotencyStore(options: {
	readonly databaseUrl: string;
	readonly scope: PlatformIdempotencyBoundScope;
}) {
	const scope = validateBoundScope(options.scope);
	let client: ReturnType<typeof postgres>;
	try {
		client = postgres(options.databaseUrl);
	} catch {
		throw new PlatformIdempotencyError("unavailable");
	}

	return {
		async reserve(input: {
			readonly key: string;
			readonly requestDigest: string;
		}) {
			const reserveInput = exactObject(
				input,
				["key", "requestDigest"],
				"invalid_input",
			);
			if (
				typeof reserveInput.key !== "string" ||
				!idempotencyKeyPattern.test(reserveInput.key) ||
				typeof reserveInput.requestDigest !== "string" ||
				!requestDigestPattern.test(reserveInput.requestDigest)
			) {
				fail("invalid_input");
			}
			const key = reserveInput.key;
			const requestDigest = reserveInput.requestDigest;
			const id = randomUUID();

			return withoutSqlDetails(async () => {
				const inserted = await client<Pick<IdempotencyRow, "id">[]>`
					insert into platform.idempotency_records
						(id, scope_type, scope_id, actor_id, command_type,
						 idempotency_key, request_digest)
					values
						(${id}, ${scope.resourceType}, ${scope.resourceId}, ${scope.actorId},
						 ${scope.operation}, ${key}, ${requestDigest})
					on conflict (scope_type, scope_id, actor_id, command_type, idempotency_key)
					do nothing
					returning id
				`;
				if (inserted.length === 1) {
					return { state: "reserved" as const, reservationId: id };
				}

				const [record] = await client<IdempotencyRow[]>`
					select id, request_digest, status, result
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
				if (record.status === "reserved") {
					// Reassignment cannot distinguish a crashed owner from a slow live owner.
					return { state: "in_progress" as const };
				}
				return {
					state: "completed" as const,
					result: mapDomainResult(record.result, "unavailable"),
				};
			});
		},

		async complete(input: {
			readonly reservationId: string;
			readonly result: PlatformIdempotencyDomainResultV1;
		}) {
			const completion = exactObject(
				input,
				["reservationId", "result"],
				"invalid_input",
			);
			const reservationId = completion.reservationId;
			if (
				typeof reservationId !== "string" ||
				!reservationIdPattern.test(reservationId)
			) {
				fail("invalid_input");
			}
			const result = mapDomainResult(completion.result);

			return withoutSqlDetails(async () => {
				const completed = await client<Pick<IdempotencyRow, "result">[]>`
					update platform.idempotency_records
					set status = 'completed', result = ${client.json(result as unknown as PostgresJson)}, updated_at = now()
					where id = ${reservationId}
						and scope_type = ${scope.resourceType}
						and scope_id = ${scope.resourceId}
						and actor_id = ${scope.actorId}
						and command_type = ${scope.operation}
						and status = 'reserved'
					returning result
				`;
				if (completed[0]) {
					return { state: "completed" as const, result };
				}

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
				if (record?.status !== "completed") {
					return { state: "conflict" as const };
				}
				return {
					state: "completed" as const,
					result: mapDomainResult(record.result, "unavailable"),
				};
			});
		},

		close() {
			return withoutSqlDetails(() => client.end());
		},
	};
}
