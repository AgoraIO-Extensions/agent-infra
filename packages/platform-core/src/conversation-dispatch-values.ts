import { Buffer } from "node:buffer";
import { types } from "node:util";
import { ConversationDispatchError } from "./conversation-dispatch-types.js";

export function invalidInput(): never {
	throw new ConversationDispatchError("invalid_input");
}

export function unavailable(): never {
	throw new ConversationDispatchError("unavailable");
}

export function exactObject(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			types.isProxy(value)
		) {
			unavailable();
		}
		const allowed = new Set([...required, ...optional]);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (
			Reflect.ownKeys(descriptors).some(
				(key) => typeof key !== "string" || !allowed.has(key),
			) ||
			required.some((key) => !Object.hasOwn(descriptors, key))
		) {
			unavailable();
		}
		const result: Record<string, unknown> = {};
		for (const key of [...required, ...optional]) {
			const descriptor = descriptors[key];
			if (descriptor === undefined) continue;
			if (
				descriptor.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				unavailable();
			}
			result[key] = descriptor.value;
		}
		return result;
	} catch (error) {
		if (error instanceof ConversationDispatchError) throw error;
		return unavailable();
	}
}

export function text(value: unknown, maximum = 1024): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		!String.prototype.isWellFormed.call(value) ||
		Buffer.byteLength(value, "utf8") > maximum
	) {
		return unavailable();
	}
	return value;
}

export function positiveInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		return unavailable();
	}
	return value;
}

export function nonNegativeInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		return unavailable();
	}
	return value;
}

export function nullableText(value: unknown): string | null {
	return value === null ? null : text(value);
}
