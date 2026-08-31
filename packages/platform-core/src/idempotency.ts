import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types } from "node:util";

const maxCanonicalBytes = 64 * 1024;
const maxCanonicalArrayItems = 16_384;
const maxJsonDepth = 32;
const maxResultReferences = 8;
const idempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const requestDigestPattern = /^[a-f0-9]{64}$/;
const reservationIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type PlatformIdempotencyOperationV1 =
	"platform.agent-application.submit.v1";

export type PlatformIdempotencyResourceTypeV1 = "agent_application" | "agent";

export interface PlatformIdempotencyBoundScopeV1 {
	readonly schemaVersion: 1;
	readonly operation: PlatformIdempotencyOperationV1;
	readonly resourceType: PlatformIdempotencyResourceTypeV1;
	readonly resourceId: string;
	readonly actorId: string;
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

export interface PlatformIdempotencyReserveInputV1 {
	readonly key: string;
	readonly requestDigest: string;
}

export interface PlatformIdempotencyCompleteInputV1 {
	readonly reservationId: string;
	readonly result: PlatformIdempotencyDomainResultV1;
}

export interface PlatformIdempotencyObservedCompletionInputV1 {
	readonly key: string;
	readonly requestDigest: string;
	readonly observedResult: PlatformIdempotencyDomainResultV1;
}

export type PlatformIdempotencyReserveDecisionV1 =
	| { readonly state: "reserved"; readonly reservationId: string }
	| { readonly state: "in_progress" }
	| {
			readonly state: "completed";
			readonly result: PlatformIdempotencyDomainResultV1;
	  }
	| { readonly state: "conflict" };

export type PlatformIdempotencyCompletionDecisionV1 =
	| {
			readonly state: "completed";
			readonly result: PlatformIdempotencyDomainResultV1;
	  }
	| { readonly state: "in_progress" }
	| { readonly state: "conflict" };

export interface PlatformIdempotencyPortV1 {
	reserve(
		input: PlatformIdempotencyReserveInputV1,
	): Promise<PlatformIdempotencyReserveDecisionV1>;
	complete(
		input: PlatformIdempotencyCompleteInputV1,
	): Promise<PlatformIdempotencyCompletionDecisionV1>;
	reconcileObservedCompletion(
		input: PlatformIdempotencyObservedCompletionInputV1,
	): Promise<PlatformIdempotencyCompletionDecisionV1>;
}

export type PlatformIdempotencyRequestJson =
	| null
	| boolean
	| number
	| string
	| readonly PlatformIdempotencyRequestJson[]
	| { readonly [key: string]: PlatformIdempotencyRequestJson };

export class PlatformIdempotencyError extends Error {
	readonly code: "invalid_input" | "unavailable";

	constructor(code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid idempotency input"
				: "Idempotency persistence unavailable",
		);
		this.name = "PlatformIdempotencyError";
		this.code = code;
	}
}

function invalidInput(): never {
	throw new PlatformIdempotencyError("invalid_input");
}

function snapshotExactDataValues(
	value: unknown,
	expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
	try {
		if (typeof value !== "object" || value === null) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const ownKeys = Reflect.ownKeys(descriptors);
		const expected = new Set(expectedKeys);
		if (
			ownKeys.length !== expected.size ||
			ownKeys.some((key) => typeof key !== "string" || !expected.has(key))
		) {
			return undefined;
		}
		const snapshot: Record<string, unknown> = {};
		for (const key of expectedKeys) {
			const descriptor = descriptors[key];
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				return undefined;
			}
			snapshot[key] = descriptor.value;
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

function snapshotDenseArray(
	value: unknown,
	maxItems: number,
): unknown[] | undefined {
	try {
		if (
			types.isProxy(value) ||
			!Array.isArray(value) ||
			Object.getPrototypeOf(value) !== Array.prototype
		) {
			return undefined;
		}
		const descriptors = Object.getOwnPropertyDescriptors(
			value,
		) as unknown as Record<PropertyKey, PropertyDescriptor>;
		const ownKeys = Reflect.ownKeys(descriptors);
		const lengthDescriptor = descriptors.length;
		if (lengthDescriptor?.enumerable !== false) return undefined;
		if (
			!Object.hasOwn(lengthDescriptor, "value") ||
			Object.hasOwn(lengthDescriptor, "get") ||
			Object.hasOwn(lengthDescriptor, "set")
		) {
			return undefined;
		}
		const length = lengthDescriptor.value;
		if (
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > maxItems ||
			ownKeys.length !== length + 1
		) {
			return undefined;
		}
		const snapshot: unknown[] = [];
		for (let index = 0; index < length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				return undefined;
			}
			snapshot[index] = descriptor.value;
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

function isCapturedText(value: unknown, maxBytes: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

function isResourceType(
	value: unknown,
): value is PlatformIdempotencyResourceTypeV1 {
	return value === "agent_application" || value === "agent";
}

function parseScope(input: unknown): PlatformIdempotencyBoundScopeV1 {
	const values = snapshotExactDataValues(input, [
		"schemaVersion",
		"operation",
		"resourceType",
		"resourceId",
		"actorId",
	]);
	if (
		values?.schemaVersion !== 1 ||
		values.operation !== "platform.agent-application.submit.v1" ||
		!isResourceType(values.resourceType) ||
		!isCapturedText(values.resourceId, 1024) ||
		!isCapturedText(values.actorId, 1024)
	) {
		invalidInput();
	}
	return {
		schemaVersion: 1,
		operation: values.operation,
		resourceType: values.resourceType,
		resourceId: values.resourceId,
		actorId: values.actorId,
	};
}

function parseResult(input: unknown): PlatformIdempotencyDomainResultV1 {
	const values = snapshotExactDataValues(input, [
		"schemaVersion",
		"outcome",
		"references",
	]);
	if (
		values?.schemaVersion !== 1 ||
		(values.outcome !== "accepted" && values.outcome !== "completed") ||
		!Array.isArray(values.references)
	) {
		invalidInput();
	}
	const referenceValues = snapshotDenseArray(
		values.references,
		maxResultReferences,
	);
	if (!referenceValues || referenceValues.length < 1) invalidInput();
	const references: {
		resourceType: PlatformIdempotencyResourceTypeV1;
		resourceId: string;
		revision: number | null;
	}[] = [];
	for (let index = 0; index < referenceValues.length; index += 1) {
		const inputReference = referenceValues[index];
		const reference = snapshotExactDataValues(inputReference, [
			"resourceType",
			"resourceId",
			"revision",
		]);
		if (
			!reference ||
			!isResourceType(reference.resourceType) ||
			!isCapturedText(reference.resourceId, 1024) ||
			(reference.revision !== null &&
				(typeof reference.revision !== "number" ||
					!Number.isSafeInteger(reference.revision) ||
					reference.revision < 0))
		) {
			invalidInput();
		}
		references.push({
			resourceType: reference.resourceType,
			resourceId: reference.resourceId,
			revision: reference.revision as number | null,
		});
	}
	return {
		schemaVersion: 1,
		outcome: values.outcome,
		references,
	};
}

function parseKeyAndDigest(
	values: Record<string, unknown>,
): PlatformIdempotencyReserveInputV1 {
	if (
		typeof values.key !== "string" ||
		!idempotencyKeyPattern.test(values.key) ||
		typeof values.requestDigest !== "string" ||
		!requestDigestPattern.test(values.requestDigest)
	) {
		invalidInput();
	}
	return { key: values.key, requestDigest: values.requestDigest };
}

function parseReserveInput(input: unknown): PlatformIdempotencyReserveInputV1 {
	const values = snapshotExactDataValues(input, ["key", "requestDigest"]);
	if (!values) invalidInput();
	return parseKeyAndDigest(values);
}

function parseCompleteInput(
	input: unknown,
): PlatformIdempotencyCompleteInputV1 {
	const values = snapshotExactDataValues(input, ["reservationId", "result"]);
	if (
		!values ||
		typeof values.reservationId !== "string" ||
		!reservationIdPattern.test(values.reservationId)
	) {
		invalidInput();
	}
	return {
		reservationId: values.reservationId,
		result: parseResult(values.result),
	};
}

function parseObservedCompletionInput(
	input: unknown,
): PlatformIdempotencyObservedCompletionInputV1 {
	const values = snapshotExactDataValues(input, [
		"key",
		"requestDigest",
		"observedResult",
	]);
	if (!values) invalidInput();
	return {
		...parseKeyAndDigest(values),
		observedResult: parseResult(values.observedResult),
	};
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
		const snapshot = snapshotDenseArray(value, maxCanonicalArrayItems);
		if (!snapshot) invalidInput();
		const serialized: string[] = [];
		for (let index = 0; index < snapshot.length; index += 1) {
			serialized[index] = canonicalJson(snapshot[index], depth + 1);
		}
		return `[${Array.prototype.join.call(serialized, ",")}]`;
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

function canonicalRequestDigest(
	request: Readonly<Record<string, PlatformIdempotencyRequestJson>>,
): string {
	try {
		if (
			request === null ||
			Array.isArray(request) ||
			typeof request !== "object"
		) {
			invalidInput();
		}
		const canonical = canonicalJson(request);
		if (Buffer.byteLength(canonical, "utf8") > maxCanonicalBytes)
			invalidInput();
		return createHash("sha256").update(canonical, "utf8").digest("hex");
	} catch (error) {
		if (error instanceof PlatformIdempotencyError) throw error;
		invalidInput();
	}
}

export const platformIdempotencyV1 = Object.freeze({
	canonicalRequestDigest,
	parseCompleteInput,
	parseObservedCompletionInput,
	parseReserveInput,
	parseResult,
	parseScope,
});
