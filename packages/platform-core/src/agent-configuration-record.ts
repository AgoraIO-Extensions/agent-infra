import {
	canonicalActions,
	canonicalChannelBindings,
	parseAdmittedSource,
	parseEnvironment,
} from "./agent-configuration-input.js";
import {
	AgentConfigurationError,
	type AgentConfigurationModelOptionV1,
	type AgentConfigurationModelV1,
	type AgentConfigurationRecordV2,
} from "./agent-configuration-types.js";
import {
	compareText,
	denseArray,
	environmentNamePattern,
	exactObject,
	idMaxBytes,
	invalidCommand,
	isText,
	maxModelOptions,
	maxReasoningLevels,
	maxSecretReplacements,
} from "./agent-configuration-values.js";
import { snapshotAgentManagementDataObject } from "./agent-management-input.js";

export function parseStoredModel(input: unknown): AgentConfigurationModelV1 {
	const values = exactObject(input, [
		"catalogRevision",
		"options",
		"defaultOptionId",
		"defaultReasoningLevel",
	]);
	if (
		!isText(values.catalogRevision, idMaxBytes) ||
		!isText(values.defaultOptionId, idMaxBytes) ||
		!isText(values.defaultReasoningLevel, idMaxBytes)
	) {
		invalidCommand();
	}
	const inputs = denseArray(values.options, maxModelOptions);
	if (inputs.length === 0) invalidCommand();
	const options: AgentConfigurationModelOptionV1[] = [];
	const seen = new Set<string>();
	for (const inputOption of inputs) {
		const option = exactObject(inputOption, [
			"optionId",
			"endpointId",
			"modelId",
			"reasoningLevels",
			"credential",
		]);
		if (
			!isText(option.optionId, idMaxBytes) ||
			!isText(option.endpointId, idMaxBytes) ||
			!isText(option.modelId, idMaxBytes) ||
			seen.has(option.optionId)
		) {
			invalidCommand();
		}
		const reasoningLevels = denseArray(
			option.reasoningLevels,
			maxReasoningLevels,
		).map((level) => {
			if (!isText(level, idMaxBytes)) invalidCommand();
			return level;
		});
		const credential = exactObject(option.credential, [
			"secretId",
			"version",
			"isSet",
		]);
		if (
			reasoningLevels.length === 0 ||
			new Set(reasoningLevels).size !== reasoningLevels.length ||
			!isText(credential.secretId, idMaxBytes) ||
			typeof credential.version !== "number" ||
			!Number.isSafeInteger(credential.version) ||
			credential.version < 1 ||
			credential.isSet !== true
		) {
			invalidCommand();
		}
		seen.add(option.optionId);
		options.push({
			optionId: option.optionId,
			endpointId: option.endpointId,
			modelId: option.modelId,
			reasoningLevels: reasoningLevels.toSorted(),
			credential: {
				secretId: credential.secretId,
				version: credential.version,
				isSet: true,
			},
		});
	}
	const defaultOption = options.find(
		({ optionId }) => optionId === values.defaultOptionId,
	);
	if (!defaultOption?.reasoningLevels.includes(values.defaultReasoningLevel)) {
		invalidCommand();
	}
	return {
		catalogRevision: values.catalogRevision,
		options: options.toSorted((left, right) =>
			compareText(left.optionId, right.optionId),
		),
		defaultOptionId: values.defaultOptionId,
		defaultReasoningLevel: values.defaultReasoningLevel,
	};
}

export function parseStoredSecrets(
	input: unknown,
): AgentConfigurationRecordV2["secrets"] {
	const names = new Set<string>();
	return denseArray(input, maxSecretReplacements)
		.map((metadataInput) => {
			const metadata = exactObject(metadataInput, [
				"name",
				"secretId",
				"version",
				"isSet",
			]);
			if (
				typeof metadata.name !== "string" ||
				!environmentNamePattern.test(metadata.name) ||
				metadata.name.startsWith("AGENT_INFRA_") ||
				names.has(metadata.name) ||
				!isText(metadata.secretId, idMaxBytes) ||
				typeof metadata.version !== "number" ||
				!Number.isSafeInteger(metadata.version) ||
				metadata.version < 1 ||
				metadata.isSet !== true
			) {
				invalidCommand();
			}
			names.add(metadata.name);
			return {
				name: metadata.name,
				secretId: metadata.secretId,
				version: metadata.version,
				isSet: true as const,
			};
		})
		.toSorted((left, right) => compareText(left.name, right.name));
}

export function decodeAgentConfigurationRecordV2(
	input: unknown,
): AgentConfigurationRecordV2 {
	const header = snapshotAgentManagementDataObject(input);
	const legacy = header.schemaVersion === 1;
	const values = exactObject(input, [
		"schemaVersion",
		"agentId",
		"revision",
		"source",
		"modelConfiguration",
		...(legacy ? ["actions", "actionSetRevision"] : []),
		"environment",
		"secrets",
		"channels",
		"channelRevision",
	]);
	if (
		(values.schemaVersion !== 1 && values.schemaVersion !== 2) ||
		!isText(values.agentId, idMaxBytes) ||
		typeof values.revision !== "number" ||
		!Number.isSafeInteger(values.revision) ||
		values.revision < 0 ||
		(legacy && !isText(values.actionSetRevision, idMaxBytes)) ||
		!isText(values.channelRevision, idMaxBytes)
	) {
		invalidCommand();
	}
	const source = parseAdmittedSource(values.source);
	const modelConfiguration =
		values.modelConfiguration === null
			? null
			: parseStoredModel(values.modelConfiguration);
	if (legacy) {
		const historicalActions = canonicalActions(values.actions);
		if (!source.connectionEnabled && historicalActions.length > 0)
			invalidCommand();
	}
	const environment = parseEnvironment(values.environment);
	const secrets = parseStoredSecrets(values.secrets);
	const channels = canonicalChannelBindings(values.channels);
	requireAdmittedConfigurationPolicy({
		source,
		modelConfiguration,
		environment,
		secrets,
		channels,
	});
	return {
		schemaVersion: 2,
		agentId: values.agentId,
		revision: values.revision,
		source,
		modelConfiguration,
		environment,
		secrets,
		channels,
		channelRevision: values.channelRevision,
	};
}

export function requireAdmittedConfigurationPolicy(
	configuration: Pick<
		AgentConfigurationRecordV2,
		"source" | "modelConfiguration" | "environment" | "secrets" | "channels"
	>,
): void {
	const { source, modelConfiguration, environment, secrets, channels } =
		configuration;
	if (
		(source.kind === "standard" &&
			(modelConfiguration === null ||
				environment.some(
					({ name }) =>
						!source.allowedEnvironmentKeys.includes(name) ||
						source.platformManagedKeys.includes(name),
				) ||
				secrets.some(
					({ name }) =>
						!source.allowedSecretKeys.includes(name) ||
						source.platformManagedKeys.includes(name),
				))) ||
		(source.kind === "custom" && modelConfiguration !== null) ||
		(source.kind === "custom" &&
			source.interactionMode === "self-managed" &&
			channels.length > 0)
	) {
		throw new AgentConfigurationError("not_admitted");
	}
}
