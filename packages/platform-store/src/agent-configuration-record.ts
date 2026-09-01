import { Buffer } from "node:buffer";

import type {
	AgentConfigurationActionV1,
	AgentConfigurationChangedFieldV1,
	AgentConfigurationRecordV1,
	AgentConfigurationResultV1,
	AgentConfigurationSourceV1,
} from "@agent-infra/platform-core";

const idMaxBytes = 1024;
const valueMaxBytes = 65_536;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const changedFields = new Set<AgentConfigurationChangedFieldV1>([
	"source",
	"environment",
	"modelConfiguration",
	"secrets",
	"actions",
	"channels",
	"owners",
	"availability",
]);

function invalid(): never {
	throw new Error("Invalid persisted Agent configuration");
}

function object(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
	const value = { ...(input as Record<string, unknown>) };
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	) {
		invalid();
	}
	return value;
}

function array(input: unknown, maximum: number): unknown[] {
	if (!Array.isArray(input) || input.length > maximum) invalid();
	return [...input];
}

function text(input: unknown, maximum = idMaxBytes): string {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input.includes("\0") ||
		!String.prototype.isWellFormed.call(input) ||
		Buffer.byteLength(input, "utf8") > maximum
	) {
		invalid();
	}
	return input;
}

function positiveInteger(input: unknown): number {
	if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) {
		invalid();
	}
	return input;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function policyKeys(input: unknown): string[] {
	const values = array(input, 128).map((entry) => {
		if (
			typeof entry !== "string" ||
			!environmentNamePattern.test(entry) ||
			entry.startsWith("AGENT_INFRA_")
		) {
			invalid();
		}
		return entry;
	});
	if (new Set(values).size !== values.length) invalid();
	return values.toSorted(compare);
}

function source(input: unknown): AgentConfigurationSourceV1 {
	if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
	const kind = (input as Record<string, unknown>).kind;
	if (kind === "standard") {
		const value = object(input, [
			"kind",
			"templateId",
			"imageDigest",
			"admissionRevision",
			"allowedEnvironmentKeys",
			"allowedSecretKeys",
			"platformManagedKeys",
			"connectionEnabled",
		]);
		const imageDigest = text(value.imageDigest, 128);
		if (
			!imageDigestPattern.test(imageDigest) ||
			typeof value.connectionEnabled !== "boolean"
		) {
			invalid();
		}
		return {
			kind: "standard",
			templateId: text(value.templateId),
			imageDigest,
			admissionRevision: text(value.admissionRevision),
			allowedEnvironmentKeys: policyKeys(value.allowedEnvironmentKeys),
			allowedSecretKeys: policyKeys(value.allowedSecretKeys),
			platformManagedKeys: policyKeys(value.platformManagedKeys),
			connectionEnabled: value.connectionEnabled,
		};
	}

	const common = [
		"kind",
		"imageDigest",
		"admissionRevision",
		"interactionMode",
		"connectionEnabled",
	];
	const interactionMode = (input as Record<string, unknown>).interactionMode;
	const keys =
		interactionMode === "self-managed"
			? [...common, "identityResponsibility"]
			: common;
	const value = object(input, keys);
	const imageDigest = text(value.imageDigest, 128);
	if (
		value.kind !== "custom" ||
		!imageDigestPattern.test(imageDigest) ||
		(interactionMode !== "self-managed" &&
			interactionMode !== "platform-adapter") ||
		typeof value.connectionEnabled !== "boolean"
	) {
		invalid();
	}
	const base = {
		kind: "custom" as const,
		imageDigest,
		admissionRevision: text(value.admissionRevision),
		connectionEnabled: value.connectionEnabled,
	};
	if (interactionMode === "platform-adapter") {
		return { ...base, interactionMode };
	}
	if (
		value.identityResponsibility !== "self-managed" &&
		value.identityResponsibility !== "platform-managed"
	) {
		invalid();
	}
	return {
		...base,
		interactionMode,
		identityResponsibility: value.identityResponsibility,
	};
}

function modelConfiguration(
	input: unknown,
): AgentConfigurationRecordV1["modelConfiguration"] {
	if (input === null) return null;
	const value = object(input, [
		"catalogRevision",
		"options",
		"defaultOptionId",
		"defaultReasoningLevel",
	]);
	const optionIds = new Set<string>();
	const options = array(value.options, 32).map((entry) => {
		const option = object(entry, [
			"optionId",
			"endpointId",
			"modelId",
			"reasoningLevels",
			"credential",
		]);
		const optionId = text(option.optionId);
		if (optionIds.has(optionId)) invalid();
		optionIds.add(optionId);
		const reasoningLevels = array(option.reasoningLevels, 16).map((level) =>
			text(level),
		);
		if (
			reasoningLevels.length === 0 ||
			new Set(reasoningLevels).size !== reasoningLevels.length
		) {
			invalid();
		}
		const credential = object(option.credential, [
			"secretId",
			"version",
			"isSet",
		]);
		if (credential.isSet !== true) invalid();
		return {
			optionId,
			endpointId: text(option.endpointId),
			modelId: text(option.modelId),
			reasoningLevels: reasoningLevels.toSorted(compare),
			credential: {
				secretId: text(credential.secretId),
				version: positiveInteger(credential.version),
				isSet: true as const,
			},
		};
	});
	if (options.length === 0) invalid();
	const defaultOptionId = text(value.defaultOptionId);
	const defaultReasoningLevel = text(value.defaultReasoningLevel);
	if (
		!options
			.find((option) => option.optionId === defaultOptionId)
			?.reasoningLevels.includes(defaultReasoningLevel)
	) {
		invalid();
	}
	return {
		catalogRevision: text(value.catalogRevision),
		options: options.toSorted((left, right) =>
			compare(left.optionId, right.optionId),
		),
		defaultOptionId,
		defaultReasoningLevel,
	};
}

function actions(input: unknown): AgentConfigurationActionV1[] {
	const seen = new Set<string>();
	return array(input, 256)
		.map((entry) => {
			const value = object(entry, ["providerId", "actionId", "actionVersion"]);
			const action = {
				providerId: text(value.providerId),
				actionId: text(value.actionId),
				actionVersion: text(value.actionVersion),
			};
			const key = `${action.providerId}\0${action.actionId}\0${action.actionVersion}`;
			if (seen.has(key)) invalid();
			seen.add(key);
			return action;
		})
		.toSorted((left, right) =>
			compare(
				`${left.providerId}\0${left.actionId}\0${left.actionVersion}`,
				`${right.providerId}\0${right.actionId}\0${right.actionVersion}`,
			),
		);
}

function environment(
	input: unknown,
): AgentConfigurationRecordV1["environment"] {
	const names = new Set<string>();
	return array(input, 128)
		.map((entry) => {
			const value = object(entry, ["name", "value"]);
			if (
				typeof value.name !== "string" ||
				!environmentNamePattern.test(value.name) ||
				value.name.startsWith("AGENT_INFRA_") ||
				names.has(value.name) ||
				typeof value.value !== "string" ||
				value.value.includes("\0") ||
				!String.prototype.isWellFormed.call(value.value) ||
				Buffer.byteLength(value.value, "utf8") > valueMaxBytes
			) {
				invalid();
			}
			names.add(value.name);
			return { name: value.name, value: value.value };
		})
		.toSorted((left, right) => compare(left.name, right.name));
}

function secrets(input: unknown): AgentConfigurationRecordV1["secrets"] {
	const names = new Set<string>();
	return array(input, 128)
		.map((entry) => {
			const value = object(entry, ["name", "secretId", "version", "isSet"]);
			if (
				typeof value.name !== "string" ||
				!environmentNamePattern.test(value.name) ||
				value.name.startsWith("AGENT_INFRA_") ||
				names.has(value.name) ||
				value.isSet !== true
			) {
				invalid();
			}
			names.add(value.name);
			return {
				name: value.name,
				secretId: text(value.secretId),
				version: positiveInteger(value.version),
				isSet: true as const,
			};
		})
		.toSorted((left, right) => compare(left.name, right.name));
}

function channels(input: unknown): AgentConfigurationRecordV1["channels"] {
	const kinds = new Set<string>();
	return array(input, 2)
		.map((entry) => {
			const value = object(entry, ["kind", "bindingReference"]);
			if (
				(value.kind !== "wecom_bot" && value.kind !== "wecom_app") ||
				kinds.has(value.kind)
			) {
				invalid();
			}
			const kind = value.kind as "wecom_bot" | "wecom_app";
			kinds.add(kind);
			return { kind, bindingReference: text(value.bindingReference) };
		})
		.toSorted((left, right) => compare(left.kind, right.kind));
}

export function decodeAgentConfigurationRecord(
	input: unknown,
): AgentConfigurationRecordV1 {
	const value = object(input, [
		"schemaVersion",
		"agentId",
		"revision",
		"source",
		"modelConfiguration",
		"actions",
		"actionSetRevision",
		"environment",
		"secrets",
		"channels",
		"channelRevision",
	]);
	if (value.schemaVersion !== 1) invalid();
	const parsedSource = source(value.source);
	const parsedModel = modelConfiguration(value.modelConfiguration);
	const parsedActions = actions(value.actions);
	const parsedEnvironment = environment(value.environment);
	const parsedSecrets = secrets(value.secrets);
	const parsedChannels = channels(value.channels);
	if (
		(parsedSource.kind === "standard" &&
			(parsedModel === null ||
				parsedEnvironment.some(
					({ name }) =>
						!parsedSource.allowedEnvironmentKeys.includes(name) ||
						parsedSource.platformManagedKeys.includes(name),
				) ||
				parsedSecrets.some(
					({ name }) =>
						!parsedSource.allowedSecretKeys.includes(name) ||
						parsedSource.platformManagedKeys.includes(name),
				))) ||
		(parsedSource.kind === "custom" && parsedModel !== null) ||
		(!parsedSource.connectionEnabled && parsedActions.length > 0) ||
		(parsedSource.kind === "custom" &&
			parsedSource.interactionMode === "self-managed" &&
			parsedChannels.length > 0)
	) {
		invalid();
	}
	return {
		schemaVersion: 1,
		agentId: text(value.agentId),
		revision: positiveInteger(value.revision),
		source: parsedSource,
		modelConfiguration: parsedModel,
		actions: parsedActions,
		actionSetRevision: text(value.actionSetRevision),
		environment: parsedEnvironment,
		secrets: parsedSecrets,
		channels: parsedChannels,
		channelRevision: text(value.channelRevision),
	};
}

export function decodeAgentConfigurationResult(
	input: unknown,
): AgentConfigurationResultV1 {
	const value = object(input, [
		"schemaVersion",
		"agentId",
		"revision",
		"changedFields",
	]);
	if (value.schemaVersion !== 1) invalid();
	const fields = array(value.changedFields, changedFields.size).map((field) => {
		if (!changedFields.has(field as AgentConfigurationChangedFieldV1))
			invalid();
		return field as AgentConfigurationChangedFieldV1;
	});
	if (
		fields.length === 0 ||
		new Set(fields).size !== fields.length ||
		JSON.stringify(fields) !== JSON.stringify(fields.toSorted(compare))
	) {
		invalid();
	}
	return {
		schemaVersion: 1,
		agentId: text(value.agentId),
		revision: positiveInteger(value.revision),
		changedFields: fields,
	};
}
