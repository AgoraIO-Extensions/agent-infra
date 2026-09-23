import { AgentConfigurationError } from "./agent-configuration-types.js";
import {
	isAgentManagementText as managementText,
	snapshotAgentManagementDataObject,
	snapshotAgentManagementDenseArray,
} from "./agent-management-input.js";

export const idMaxBytes = 1024;

export const valueMaxBytes = 65_536;

export const maxModelOptions = 32;

export const maxReasoningLevels = 16;

export const maxEnvironmentEntries = 128;

export const maxSecretReplacements = 128;

export const maxActions = 256;

export const maxChannelChanges = 2;

export const maxAccessTargets = 256;

export const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;

export function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function invalidCommand(): never {
	throw new AgentConfigurationError("invalid_command");
}

export function isText(value: unknown, maxBytes: number): value is string {
	return managementText(value, maxBytes);
}

export function exactObject(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	try {
		const values = snapshotAgentManagementDataObject(value);
		const keys = Object.keys(values);
		const allowed = new Set([...required, ...optional]);
		if (
			keys.some((key) => !allowed.has(key)) ||
			required.some((key) => !Object.hasOwn(values, key))
		) {
			invalidCommand();
		}
		return values;
	} catch {
		invalidCommand();
	}
}

export function denseArray(value: unknown, maxLength: number): unknown[] {
	try {
		return [...snapshotAgentManagementDenseArray(value, maxLength)];
	} catch {
		invalidCommand();
	}
}

export function persistenceValue<T>(parse: () => T): T {
	try {
		return parse();
	} catch {
		throw new AgentConfigurationError("persistence_failed");
	}
}

export function dependencyValue<T>(parse: () => T): T {
	try {
		return parse();
	} catch {
		throw new AgentConfigurationError("dependency_unavailable");
	}
}

export function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
