import {
	type PlatformIdempotencyBoundScopeV1,
	type PlatformIdempotencyDomainResultV1,
	PlatformIdempotencyError,
	type PlatformIdempotencyPortV1,
	platformIdempotencyV1,
} from "./idempotency.js";

interface FakeIdempotencyRecord {
	readonly reservationId: string;
	readonly requestDigest: string;
	readonly scopeKey: string;
	status: "reserved" | "completed";
	result?: PlatformIdempotencyDomainResultV1;
}

function cloneResult(
	result: PlatformIdempotencyDomainResultV1,
): PlatformIdempotencyDomainResultV1 {
	return platformIdempotencyV1.parseResult(structuredClone(result));
}

function boundScopeKey(scope: PlatformIdempotencyBoundScopeV1): string {
	return JSON.stringify([
		scope.operation,
		scope.resourceType,
		scope.resourceId,
		scope.actorId,
	]);
}

function recordKey(
	scope: PlatformIdempotencyBoundScopeV1,
	key: string,
): string {
	return JSON.stringify([boundScopeKey(scope), key]);
}

function completedResult(
	record: FakeIdempotencyRecord,
): PlatformIdempotencyDomainResultV1 {
	if (record.status !== "completed" || !record.result) {
		throw new PlatformIdempotencyError("unavailable");
	}
	return cloneResult(record.result);
}

export class FakePlatformIdempotencyDatabaseV1 {
	readonly #records = new Map<string, FakeIdempotencyRecord>();
	readonly #reservations = new Map<string, FakeIdempotencyRecord>();
	#nextReservation = 1;

	open(scopeInput: PlatformIdempotencyBoundScopeV1): PlatformIdempotencyPortV1 {
		const scope = platformIdempotencyV1.parseScope(scopeInput);
		return {
			reserve: async (input) => {
				const { key, requestDigest } =
					platformIdempotencyV1.parseReserveInput(input);
				const keyForRecord = recordKey(scope, key);
				const record = this.#records.get(keyForRecord);
				if (!record) {
					const reservationId = this.#reservationId();
					const created = {
						reservationId,
						requestDigest,
						scopeKey: boundScopeKey(scope),
						status: "reserved",
					} as const;
					this.#records.set(keyForRecord, created);
					this.#reservations.set(reservationId, created);
					return { state: "reserved", reservationId };
				}
				if (record.requestDigest !== requestDigest)
					return { state: "conflict" };
				if (record.status === "reserved") return { state: "in_progress" };
				return { state: "completed", result: completedResult(record) };
			},
			complete: async (input) => {
				const { reservationId, result } =
					platformIdempotencyV1.parseCompleteInput(input);
				const record = this.#reservations.get(reservationId);
				if (!record || record.scopeKey !== boundScopeKey(scope)) {
					return { state: "conflict" };
				}
				if (record.status === "completed") {
					return { state: "completed", result: completedResult(record) };
				}
				record.status = "completed";
				record.result = cloneResult(result);
				return { state: "completed", result: cloneResult(record.result) };
			},
			reconcileObservedCompletion: async (input) => {
				const { key, requestDigest, observedResult } =
					platformIdempotencyV1.parseObservedCompletionInput(input);
				const record = this.#records.get(recordKey(scope, key));
				if (!record || record.requestDigest !== requestDigest) {
					return { state: "conflict" };
				}
				if (record.status === "completed") {
					return { state: "completed", result: completedResult(record) };
				}
				record.status = "completed";
				record.result = cloneResult(observedResult);
				return { state: "completed", result: cloneResult(record.result) };
			},
		};
	}

	#reservationId(): string {
		const suffix = String(this.#nextReservation).padStart(12, "0");
		this.#nextReservation += 1;
		return `00000000-0000-4000-8000-${suffix}`;
	}
}
