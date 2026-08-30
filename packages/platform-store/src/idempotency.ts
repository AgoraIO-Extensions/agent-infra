import { createHash, randomUUID } from "node:crypto";

import postgres from "postgres";

const maxCanonicalBytes = 64 * 1024;
const maxJsonDepth = 32;
const idempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const forbiddenResultKeys = new Set([
	"accesstoken",
	"apikey",
	"authorization",
	"clientsecret",
	"cookie",
	"credential",
	"credentials",
	"password",
	"privatekey",
	"providerpayload",
	"providerresponse",
	"rawproviderresult",
	"refreshtoken",
	"secret",
	"secretvalue",
	"token",
]);

export type PlatformIdempotencyJson =
	| null
	| boolean
	| number
	| string
	| readonly PlatformIdempotencyJson[]
	| { readonly [key: string]: PlatformIdempotencyJson };

export interface PlatformIdempotencyScope {
	readonly resourceType: string;
	readonly resourceId: string;
	readonly actorId: string;
	readonly operation: string;
}

export interface PlatformIdempotencyReservation {
	readonly id: string;
	readonly scope: PlatformIdempotencyScope;
	readonly key: string;
	readonly requestDigest: string;
}

export type PlatformIdempotencyReserveResult =
	| {
			readonly state: "reserved";
			readonly reservation: PlatformIdempotencyReservation;
	  }
	| { readonly state: "in_progress" }
	| {
			readonly state: "completed";
			readonly result: Readonly<Record<string, PlatformIdempotencyJson>>;
	  }
	| { readonly state: "conflict" };

export type PlatformIdempotencyCompleteResult =
	| {
			readonly state: "completed";
			readonly result: Readonly<Record<string, PlatformIdempotencyJson>>;
	  }
	| { readonly state: "conflict" };

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

export interface PlatformIdempotencyStore {
	reserve(input: {
		readonly scope: PlatformIdempotencyScope;
		readonly key: string;
		readonly request: Readonly<Record<string, PlatformIdempotencyJson>>;
	}): Promise<PlatformIdempotencyReserveResult>;
	complete(input: {
		readonly reservation: PlatformIdempotencyReservation;
		readonly result: Readonly<Record<string, PlatformIdempotencyJson>>;
	}): Promise<PlatformIdempotencyCompleteResult>;
	close(): Promise<void>;
}

interface IdempotencyRow {
	id: string;
	request_digest: string;
	status: "reserved" | "completed";
	result: unknown;
	updated_at: Date;
}

function invalidInput(): never {
	throw new PlatformIdempotencyError("invalid_input");
}

function validateText(value: string, maxLength: number): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		value.includes("\0")
	) {
		invalidInput();
	}
}

function validateScope(scope: PlatformIdempotencyScope): void {
	if (!scope || typeof scope !== "object") invalidInput();
	validateText(scope.resourceType, 64);
	validateText(scope.resourceId, 512);
	validateText(scope.actorId, 512);
	validateText(scope.operation, 64);
}

function readClock(clock: () => Date): Date {
	let now: Date;
	try {
		now = clock();
	} catch {
		invalidInput();
	}
	if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalidInput();
	return new Date(now.getTime());
}

function canonicalJson(value: unknown, depth = 0): string {
	if (depth > maxJsonDepth) invalidInput();
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalidInput();
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (Object.keys(value).length !== value.length) invalidInput();
		return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
	}
	if (typeof value !== "object") invalidInput();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) invalidInput();
	if (Object.getOwnPropertySymbols(value).length > 0) invalidInput();
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Object.keys(descriptors).sort();
	return `{${keys
		.map((key) => {
			const descriptor = descriptors[key];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				invalidInput();
			}
			return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1)}`;
		})
		.join(",")}}`;
}

function canonicalObject(
	value: unknown,
	code: "invalid_input" | "unavailable" = "invalid_input",
): {
	canonical: string;
	value: Readonly<Record<string, PlatformIdempotencyJson>>;
} {
	try {
		if (value === null || Array.isArray(value) || typeof value !== "object") {
			invalidInput();
		}
		const canonical = canonicalJson(value);
		if (Buffer.byteLength(canonical, "utf8") > maxCanonicalBytes)
			invalidInput();
		return {
			canonical,
			value: JSON.parse(canonical) as Readonly<
				Record<string, PlatformIdempotencyJson>
			>,
		};
	} catch (error) {
		if (code === "invalid_input" && error instanceof PlatformIdempotencyError) {
			throw error;
		}
		throw new PlatformIdempotencyError(code);
	}
}

function canonicalResult(
	value: unknown,
	code: "invalid_input" | "unavailable" = "invalid_input",
): Readonly<Record<string, PlatformIdempotencyJson>> {
	const result = canonicalObject(value, code).value;
	const pending: PlatformIdempotencyJson[] = [result];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}
		for (const [key, nested] of Object.entries(current)) {
			const normalizedKey = key.replaceAll(/[-_.]/g, "").toLowerCase();
			if (forbiddenResultKeys.has(normalizedKey)) {
				throw new PlatformIdempotencyError(code);
			}
			pending.push(nested);
		}
	}
	return result;
}

async function withoutSqlDetails<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof PlatformIdempotencyError) throw error;
		throw new PlatformIdempotencyError("unavailable");
	}
}

export function openPlatformIdempotencyStore(options: {
	readonly databaseUrl: string;
	readonly reservationTimeoutMs: number;
	readonly clock?: () => Date;
}): PlatformIdempotencyStore {
	if (
		!Number.isInteger(options.reservationTimeoutMs) ||
		options.reservationTimeoutMs < 1_000 ||
		options.reservationTimeoutMs > 24 * 60 * 60 * 1_000
	) {
		invalidInput();
	}
	let client: ReturnType<typeof postgres>;
	try {
		client = postgres(options.databaseUrl);
	} catch {
		throw new PlatformIdempotencyError("unavailable");
	}
	const clock = options.clock ?? (() => new Date());

	return {
		async reserve({ scope, key, request }) {
			validateScope(scope);
			if (!idempotencyKeyPattern.test(key)) invalidInput();
			const { canonical } = canonicalObject(request);
			const requestDigest = createHash("sha256")
				.update(canonical, "utf8")
				.digest("hex");
			const id = randomUUID();
			const now = readClock(clock);

			return withoutSqlDetails(async () => {
				const inserted = await client<Pick<IdempotencyRow, "id">[]>`
					insert into platform.idempotency_records
						(id, scope_type, scope_id, actor_id, command_type,
						 idempotency_key, request_digest, created_at, updated_at)
					values
						(${id}, ${scope.resourceType}, ${scope.resourceId}, ${scope.actorId},
						 ${scope.operation}, ${key}, ${requestDigest}, ${now}, ${now})
					on conflict (scope_type, scope_id, actor_id, command_type, idempotency_key)
					do nothing
					returning id
				`;
				if (inserted.length === 1) {
					return {
						state: "reserved" as const,
						reservation: { id, scope: { ...scope }, key, requestDigest },
					};
				}

				const [record] = await client<IdempotencyRow[]>`
					select id, request_digest, status, result, updated_at
					from platform.idempotency_records
					where scope_type = ${scope.resourceType}
						and scope_id = ${scope.resourceId}
						and actor_id = ${scope.actorId}
						and command_type = ${scope.operation}
						and idempotency_key = ${key}
				`;
				if (!record) throw new PlatformIdempotencyError("unavailable");
				if (record.request_digest !== requestDigest)
					return { state: "conflict" };
				if (record.status === "reserved") {
					const reclaimedId = randomUUID();
					const staleBefore = new Date(
						now.getTime() - options.reservationTimeoutMs,
					);
					const reclaimed = await client<Pick<IdempotencyRow, "id">[]>`
						update platform.idempotency_records
						set id = ${reclaimedId}, updated_at = ${now}
						where id = ${record.id}
							and scope_type = ${scope.resourceType}
							and scope_id = ${scope.resourceId}
							and actor_id = ${scope.actorId}
							and command_type = ${scope.operation}
							and idempotency_key = ${key}
							and request_digest = ${requestDigest}
							and status = 'reserved'
							and updated_at <= ${staleBefore}
						returning id
					`;
					if (reclaimed.length === 1) {
						return {
							state: "reserved" as const,
							reservation: {
								id: reclaimedId,
								scope: { ...scope },
								key,
								requestDigest,
							},
						};
					}
					return { state: "in_progress" };
				}
				return {
					state: "completed",
					result: canonicalResult(record.result, "unavailable"),
				};
			});
		},

		async complete({ reservation, result }) {
			validateScope(reservation.scope);
			validateText(reservation.id, 512);
			if (!idempotencyKeyPattern.test(reservation.key)) invalidInput();
			if (!/^[a-f0-9]{64}$/.test(reservation.requestDigest)) invalidInput();
			const sanitizedResult = canonicalResult(result);
			const now = readClock(clock);

			return withoutSqlDetails(async () => {
				const completed = await client<Pick<IdempotencyRow, "result">[]>`
					update platform.idempotency_records
					set status = 'completed', result = ${client.json(sanitizedResult)}, updated_at = ${now}
					where id = ${reservation.id}
						and scope_type = ${reservation.scope.resourceType}
						and scope_id = ${reservation.scope.resourceId}
						and actor_id = ${reservation.scope.actorId}
						and command_type = ${reservation.scope.operation}
						and idempotency_key = ${reservation.key}
						and request_digest = ${reservation.requestDigest}
						and status = 'reserved'
					returning result
				`;
				if (completed[0]) {
					return { state: "completed", result: sanitizedResult };
				}

				const [record] = await client<IdempotencyRow[]>`
					select id, request_digest, status, result, updated_at
					from platform.idempotency_records
					where id = ${reservation.id}
						and scope_type = ${reservation.scope.resourceType}
						and scope_id = ${reservation.scope.resourceId}
						and actor_id = ${reservation.scope.actorId}
						and command_type = ${reservation.scope.operation}
						and idempotency_key = ${reservation.key}
						and request_digest = ${reservation.requestDigest}
				`;
				if (record?.status !== "completed") return { state: "conflict" };
				return {
					state: "completed",
					result: canonicalResult(record.result, "unavailable"),
				};
			});
		},

		close() {
			return withoutSqlDetails(() => client.end());
		},
	};
}
