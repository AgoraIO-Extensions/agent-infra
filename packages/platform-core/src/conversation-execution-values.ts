import { Buffer } from "node:buffer";
import { types } from "node:util";
import { ConversationExecutionError } from "./conversation-execution-types.js";
import { platformIdempotencyV1 } from "./idempotency.js";

export const idempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,128}$/;

export function invalidInput(): never {
	throw new ConversationExecutionError("invalid_input");
}

export function unavailable(): never {
	throw new ConversationExecutionError("unavailable");
}

export function snapshotObject(
	input: unknown,
	keys: readonly string[],
	optionalKeys: readonly string[] = [],
): Record<string, unknown> {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			types.isProxy(input)
		) {
			invalidInput();
		}
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const actualKeys = [
			...keys,
			...optionalKeys.filter((key) => Object.hasOwn(descriptors, key)),
		];
		if (
			Reflect.ownKeys(descriptors).length !== actualKeys.length ||
			actualKeys.some((key) => !Object.hasOwn(descriptors, key))
		) {
			invalidInput();
		}
		const values: Record<string, unknown> = {};
		for (const key of actualKeys) {
			const descriptor = descriptors[key];
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				invalidInput();
			}
			values[key] = descriptor.value;
		}
		return values;
	} catch (error) {
		if (error instanceof ConversationExecutionError) throw error;
		invalidInput();
	}
}

export function isText(value: unknown, maximum = 65_536): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maximum
	);
}

export function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function safeNow(now: () => Date): Date {
	try {
		const milliseconds = Date.prototype.getTime.call(now());
		if (!Number.isFinite(milliseconds)) throw new Error();
		return new Date(milliseconds);
	} catch {
		return unavailable();
	}
}

export function snapshotDate(value: unknown): Date {
	try {
		const milliseconds = Date.prototype.getTime.call(value);
		if (!Number.isFinite(milliseconds)) throw new Error();
		return new Date(milliseconds);
	} catch {
		return unavailable();
	}
}

export function nextOpaqueId(newId: () => string): string {
	try {
		const value = newId();
		if (!isText(value)) unavailable();
		return value;
	} catch {
		return unavailable();
	}
}

export function nextCounter(value: number): number {
	if (!isNonNegativeSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
		unavailable();
	}
	return value + 1;
}

export function digest(input: unknown): string {
	try {
		return platformIdempotencyV1.canonicalRequestDigest(input as never);
	} catch {
		return unavailable();
	}
}

export function trySnapshotObject(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> | undefined {
	try {
		return snapshotObject(input, keys);
	} catch {
		return undefined;
	}
}

export function transactionObject(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	return trySnapshotObject(input, keys) ?? unavailable();
}
