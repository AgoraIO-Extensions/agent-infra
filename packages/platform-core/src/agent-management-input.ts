import { Buffer } from "node:buffer";
import { types } from "node:util";

import type {
	AgentManagementActorContextV1,
	AgentManagementStateV1,
} from "./agent-management.js";

export class AgentManagementError extends Error {
	readonly code: "invalid_input" | "unavailable";

	constructor(code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid Agent management input"
				: "Agent management is temporarily unavailable",
		);
		this.name = "AgentManagementError";
		this.code = code;
	}
}

export function invalidAgentManagementInput(): never {
	throw new AgentManagementError("invalid_input");
}

export function snapshotAgentManagementDataObject(
	input: unknown,
): Record<string, unknown> {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			types.isProxy(input)
		) {
			invalidAgentManagementInput();
		}
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const values: Record<string, unknown> = {};
		for (const key of Reflect.ownKeys(descriptors)) {
			if (typeof key !== "string") invalidAgentManagementInput();
			const descriptor = descriptors[key];
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				invalidAgentManagementInput();
			}
			values[key] = descriptor.value;
		}
		return values;
	} catch (error) {
		if (error instanceof AgentManagementError) throw error;
		invalidAgentManagementInput();
	}
}

export function requireAgentManagementExactKeys(
	values: Record<string, unknown>,
	expectedKeys: readonly string[],
): void {
	const keys = Object.keys(values);
	const expected = new Set(expectedKeys);
	if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
		invalidAgentManagementInput();
	}
}

export function isAgentManagementText(
	value: unknown,
	maxBytes = 1024,
): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

export function isAgentManagementNonNegativeInteger(
	value: unknown,
): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function snapshotAgentManagementDenseArray(
	input: unknown,
	maxItems = 4096,
): readonly unknown[] {
	try {
		if (
			!Array.isArray(input) ||
			types.isProxy(input) ||
			Object.getPrototypeOf(input) !== Array.prototype ||
			input.length > maxItems ||
			Reflect.ownKeys(input).length !== input.length + 1
		) {
			invalidAgentManagementInput();
		}
		const values: unknown[] = [];
		for (let index = 0; index < input.length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value")
			) {
				invalidAgentManagementInput();
			}
			values.push(descriptor.value);
		}
		return values;
	} catch (error) {
		if (error instanceof AgentManagementError) throw error;
		invalidAgentManagementInput();
	}
}

export function parseAgentManagementStringArray(
	input: unknown,
	unique: boolean,
): readonly string[] {
	const values = snapshotAgentManagementDenseArray(input).map((value) => {
		if (!isAgentManagementText(value)) invalidAgentManagementInput();
		return value;
	});
	if (unique && new Set(values).size !== values.length) {
		invalidAgentManagementInput();
	}
	return values;
}

export function parseAgentManagementActorContext(
	input: unknown,
): AgentManagementActorContextV1 {
	const values = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(values, [
		"schemaVersion",
		"userId",
		"accountStatus",
		"organizationIds",
		"isAdministrator",
	]);
	if (
		values.schemaVersion !== 1 ||
		!isAgentManagementText(values.userId) ||
		(values.accountStatus !== "active" &&
			values.accountStatus !== "disabled") ||
		typeof values.isAdministrator !== "boolean"
	) {
		invalidAgentManagementInput();
	}
	return {
		schemaVersion: 1,
		userId: values.userId,
		accountStatus: values.accountStatus,
		organizationIds: parseAgentManagementStringArray(
			values.organizationIds,
			true,
		),
		isAdministrator: values.isAdministrator,
	};
}

type AgentAccessTargetV1 = AgentManagementStateV1["availability"][number];

export function agentAccessTargetKey(target: AgentAccessTargetV1): string {
	return target.kind === "user"
		? `user:${target.userId}`
		: `organization:${target.organizationId}`;
}

export function parseAgentAccessTargets(
	input: unknown,
): readonly AgentAccessTargetV1[] {
	return snapshotAgentManagementDenseArray(input).map((targetInput) => {
		const target = snapshotAgentManagementDataObject(targetInput);
		if (target.kind === "user") {
			requireAgentManagementExactKeys(target, ["kind", "userId"]);
			if (!isAgentManagementText(target.userId)) invalidAgentManagementInput();
			return { kind: "user", userId: target.userId };
		}
		if (target.kind === "organization") {
			requireAgentManagementExactKeys(target, ["kind", "organizationId"]);
			if (!isAgentManagementText(target.organizationId)) {
				invalidAgentManagementInput();
			}
			return { kind: "organization", organizationId: target.organizationId };
		}
		return invalidAgentManagementInput();
	});
}
