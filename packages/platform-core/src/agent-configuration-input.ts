import { Buffer } from "node:buffer";
import type {
	AgentConfigurationAccessTargetV1,
	AgentConfigurationActionV1,
	AgentConfigurationActorContextV1,
	AgentConfigurationChannelChangeV1,
	AgentConfigurationChannelKindV1,
	AgentConfigurationModelInputV1,
	AgentConfigurationModelOptionInputV1,
	AgentConfigurationRecordV2,
	AgentConfigurationSecretReplacementInputV1,
	AgentConfigurationSourceSelectionV1,
	AgentConfigurationSourceV1,
	InitialAgentConfigurationCommandV2,
	LegacyUpdateAgentConfigurationCommandV1,
	ReleaseStandardTemplateCommandV1,
	StandardTemplateReleaseTargetV1,
	UpdateAgentConfigurationCommandV2,
	UpgradeCustomAgentImageCommandV1,
} from "./agent-configuration-types.js";
import {
	compareText,
	denseArray,
	environmentNamePattern,
	exactObject,
	idMaxBytes,
	imageDigestPattern,
	invalidCommand,
	isText,
	maxAccessTargets,
	maxActions,
	maxChannelChanges,
	maxEnvironmentEntries,
	maxModelOptions,
	maxReasoningLevels,
	maxSecretReplacements,
	valueMaxBytes,
} from "./agent-configuration-values.js";

function parseModelConfiguration(
	input: unknown,
): AgentConfigurationModelInputV1 {
	const values = exactObject(input, [
		"options",
		"defaultOptionId",
		"defaultReasoningLevel",
	]);
	const inputs = denseArray(values.options, maxModelOptions);
	if (
		inputs.length === 0 ||
		!isText(values.defaultOptionId, idMaxBytes) ||
		!isText(values.defaultReasoningLevel, idMaxBytes)
	) {
		invalidCommand();
	}
	const options: AgentConfigurationModelOptionInputV1[] = [];
	const optionIds = new Set<string>();
	for (const inputOption of inputs) {
		const option = exactObject(inputOption, [
			"optionId",
			"endpointId",
			"modelId",
			"reasoningLevels",
			"replaceCredential",
		]);
		if (
			!isText(option.optionId, idMaxBytes) ||
			!isText(option.endpointId, idMaxBytes) ||
			!isText(option.modelId, idMaxBytes) ||
			typeof option.replaceCredential !== "boolean" ||
			optionIds.has(option.optionId)
		) {
			invalidCommand();
		}
		const reasoningInputs = denseArray(
			option.reasoningLevels,
			maxReasoningLevels,
		);
		const reasoningLevels = reasoningInputs.map((level) => {
			if (!isText(level, idMaxBytes)) invalidCommand();
			return level;
		});
		if (
			reasoningLevels.length === 0 ||
			new Set(reasoningLevels).size !== reasoningLevels.length
		) {
			invalidCommand();
		}
		optionIds.add(option.optionId);
		options.push({
			optionId: option.optionId,
			endpointId: option.endpointId,
			modelId: option.modelId,
			reasoningLevels: reasoningLevels.toSorted(),
			replaceCredential: option.replaceCredential,
		});
	}
	const defaultOption = options.find(
		({ optionId }) => optionId === values.defaultOptionId,
	);
	if (!defaultOption?.reasoningLevels.includes(values.defaultReasoningLevel)) {
		invalidCommand();
	}
	return {
		options: options.toSorted((left, right) =>
			compareText(left.optionId, right.optionId),
		),
		defaultOptionId: values.defaultOptionId,
		defaultReasoningLevel: values.defaultReasoningLevel,
	};
}

function parseSourceSelection(
	input: unknown,
): AgentConfigurationSourceSelectionV1 {
	const base = exactObject(
		input,
		["kind"],
		[
			"templateId",
			"imageReference",
			"interactionMode",
			"identityResponsibility",
		],
	);
	if (base.kind === "standard") {
		if (
			!isText(base.templateId, idMaxBytes) ||
			Object.keys(base).length !== 2
		) {
			invalidCommand();
		}
		return { kind: "standard", templateId: base.templateId };
	}
	if (
		base.kind !== "custom" ||
		!isText(base.imageReference, 4096) ||
		(base.interactionMode !== "self-managed" &&
			base.interactionMode !== "platform-adapter")
	) {
		invalidCommand();
	}
	if (base.interactionMode === "self-managed") {
		if (
			(base.identityResponsibility !== "self-managed" &&
				base.identityResponsibility !== "platform-managed") ||
			Object.keys(base).length !== 4
		) {
			invalidCommand();
		}
		return {
			kind: "custom",
			imageReference: base.imageReference,
			interactionMode: "self-managed",
			identityResponsibility: base.identityResponsibility,
		};
	}
	if (Object.keys(base).length !== 3) invalidCommand();
	return {
		kind: "custom",
		imageReference: base.imageReference,
		interactionMode: "platform-adapter",
	};
}

function parsePolicyKeys(input: unknown): string[] {
	const keys = denseArray(input, maxEnvironmentEntries).map((key) => {
		if (
			typeof key !== "string" ||
			!environmentNamePattern.test(key) ||
			key.startsWith("AGENT_INFRA_")
		) {
			invalidCommand();
		}
		return key;
	});
	if (new Set(keys).size !== keys.length) invalidCommand();
	return keys.toSorted();
}

export function parseAdmittedSource(
	input: unknown,
): AgentConfigurationSourceV1 {
	const base = exactObject(
		input,
		["kind", "imageDigest", "admissionRevision", "connectionEnabled"],
		[
			"templateId",
			"allowedEnvironmentKeys",
			"allowedSecretKeys",
			"platformManagedKeys",
			"interactionMode",
			"identityResponsibility",
		],
	);
	if (
		!isText(base.imageDigest, 128) ||
		!imageDigestPattern.test(base.imageDigest) ||
		!isText(base.admissionRevision, idMaxBytes) ||
		typeof base.connectionEnabled !== "boolean"
	) {
		invalidCommand();
	}
	if (base.kind === "standard") {
		if (
			!isText(base.templateId, idMaxBytes) ||
			Object.keys(base).length !== 8
		) {
			invalidCommand();
		}
		return {
			kind: "standard",
			templateId: base.templateId,
			imageDigest: base.imageDigest,
			admissionRevision: base.admissionRevision,
			allowedEnvironmentKeys: parsePolicyKeys(base.allowedEnvironmentKeys),
			allowedSecretKeys: parsePolicyKeys(base.allowedSecretKeys),
			platformManagedKeys: parsePolicyKeys(base.platformManagedKeys),
			connectionEnabled: base.connectionEnabled,
		};
	}
	if (
		base.kind !== "custom" ||
		(base.interactionMode !== "self-managed" &&
			base.interactionMode !== "platform-adapter")
	) {
		invalidCommand();
	}
	if (base.interactionMode === "self-managed") {
		if (
			(base.identityResponsibility !== "self-managed" &&
				base.identityResponsibility !== "platform-managed") ||
			Object.keys(base).length !== 6
		) {
			invalidCommand();
		}
		return {
			kind: "custom",
			imageDigest: base.imageDigest,
			admissionRevision: base.admissionRevision,
			interactionMode: "self-managed",
			identityResponsibility: base.identityResponsibility,
			connectionEnabled: base.connectionEnabled,
		};
	}
	if (Object.keys(base).length !== 5) invalidCommand();
	return {
		kind: "custom",
		imageDigest: base.imageDigest,
		admissionRevision: base.admissionRevision,
		interactionMode: "platform-adapter",
		connectionEnabled: base.connectionEnabled,
	};
}

export function parseEnvironment(
	input: unknown,
): { name: string; value: string }[] {
	const entries = denseArray(input, maxEnvironmentEntries);
	const names = new Set<string>();
	const parsed = entries.map((entry) => {
		const values = exactObject(entry, ["name", "value"]);
		if (
			typeof values.name !== "string" ||
			!environmentNamePattern.test(values.name) ||
			values.name.startsWith("AGENT_INFRA_") ||
			typeof values.value !== "string" ||
			values.value.includes("\0") ||
			!String.prototype.isWellFormed.call(values.value) ||
			Buffer.byteLength(values.value, "utf8") > valueMaxBytes ||
			names.has(values.name)
		) {
			invalidCommand();
		}
		names.add(values.name);
		return { name: values.name, value: values.value };
	});
	return parsed.toSorted((left, right) => compareText(left.name, right.name));
}

function parseSecretReplacements(
	input: unknown,
): AgentConfigurationSecretReplacementInputV1[] {
	const entries = denseArray(input, maxSecretReplacements);
	const names = new Set<string>();
	return entries
		.map((entry) => {
			const values = exactObject(entry, ["name", "replace"]);
			if (
				typeof values.name !== "string" ||
				!environmentNamePattern.test(values.name) ||
				values.name.startsWith("AGENT_INFRA_") ||
				values.replace !== true ||
				names.has(values.name)
			) {
				invalidCommand();
			}
			names.add(values.name);
			return { name: values.name, replace: true as const };
		})
		.toSorted((left, right) => compareText(left.name, right.name));
}

export function canonicalActions(input: unknown): AgentConfigurationActionV1[] {
	const entries = denseArray(input, maxActions);
	const seen = new Set<string>();
	return entries
		.map((entry) => {
			const values = exactObject(entry, [
				"providerId",
				"actionId",
				"actionVersion",
			]);
			if (
				!isText(values.providerId, idMaxBytes) ||
				!isText(values.actionId, idMaxBytes) ||
				!isText(values.actionVersion, idMaxBytes)
			) {
				invalidCommand();
			}
			const key = `${values.providerId}\0${values.actionId}\0${values.actionVersion}`;
			if (seen.has(key)) invalidCommand();
			seen.add(key);
			return {
				providerId: values.providerId,
				actionId: values.actionId,
				actionVersion: values.actionVersion,
			};
		})
		.toSorted((left, right) =>
			compareText(
				`${left.providerId}\0${left.actionId}\0${left.actionVersion}`,
				`${right.providerId}\0${right.actionId}\0${right.actionVersion}`,
			),
		);
}

function parseChannelChanges(
	input: unknown,
): AgentConfigurationChannelChangeV1[] {
	const entries = denseArray(input, maxChannelChanges);
	const kinds = new Set<AgentConfigurationChannelKindV1>();
	return entries
		.map((entry) => {
			const base = exactObject(
				entry,
				["kind", "enabled"],
				["bindingReference"],
			);
			if (
				(base.kind !== "wecom_bot" && base.kind !== "wecom_app") ||
				(base.enabled !== true && base.enabled !== false) ||
				kinds.has(base.kind)
			) {
				invalidCommand();
			}
			const kind = base.kind as AgentConfigurationChannelKindV1;
			kinds.add(kind);
			if (base.enabled === true) {
				if (!isText(base.bindingReference, idMaxBytes)) invalidCommand();
				return {
					kind,
					enabled: true as const,
					bindingReference: base.bindingReference,
				};
			}
			if (Object.hasOwn(base, "bindingReference")) invalidCommand();
			return { kind, enabled: false as const };
		})
		.toSorted((left, right) => compareText(left.kind, right.kind));
}

export function canonicalChannelBindings(
	input: unknown,
): AgentConfigurationRecordV2["channels"] {
	const entries = denseArray(input, maxChannelChanges);
	const kinds = new Set<AgentConfigurationChannelKindV1>();
	return entries
		.map((entry) => {
			const values = exactObject(entry, ["kind", "bindingReference"]);
			if (
				(values.kind !== "wecom_bot" && values.kind !== "wecom_app") ||
				!isText(values.bindingReference, idMaxBytes) ||
				kinds.has(values.kind)
			) {
				invalidCommand();
			}
			const kind = values.kind as AgentConfigurationChannelKindV1;
			kinds.add(kind);
			return {
				kind,
				bindingReference: values.bindingReference,
			};
		})
		.toSorted((left, right) => compareText(left.kind, right.kind));
}

export function parseOwnerIds(input: unknown): string[] {
	return denseArray(input, maxAccessTargets)
		.map((ownerId) => {
			if (!isText(ownerId, idMaxBytes)) invalidCommand();
			return ownerId;
		})
		.toSorted();
}

export function accessTargetKey(
	target: AgentConfigurationAccessTargetV1,
): string {
	return target.kind === "user"
		? `user:${target.userId}`
		: target.kind === "organization"
			? `organization:${target.organizationId}`
			: `application:${target.applicationId}`;
}

export function parseAvailability(
	input: unknown,
): AgentConfigurationAccessTargetV1[] {
	return denseArray(input, maxAccessTargets)
		.map((targetInput) => {
			const target = exactObject(
				targetInput,
				["kind"],
				["userId", "organizationId", "applicationId"],
			);
			if (target.kind === "user") {
				if (
					!isText(target.userId, idMaxBytes) ||
					Object.keys(target).length !== 2
				) {
					invalidCommand();
				}
				return { kind: "user" as const, userId: target.userId };
			}
			if (target.kind === "organization") {
				if (
					!isText(target.organizationId, idMaxBytes) ||
					Object.keys(target).length !== 2
				) {
					invalidCommand();
				}
				return {
					kind: "organization" as const,
					organizationId: target.organizationId,
				};
			}
			if (
				target.kind !== "application" ||
				!isText(target.applicationId, idMaxBytes) ||
				Object.keys(target).length !== 2
			) {
				invalidCommand();
			}
			return {
				kind: "application" as const,
				applicationId: target.applicationId,
			};
		})
		.toSorted((left, right) =>
			compareText(accessTargetKey(left), accessTargetKey(right)),
		);
}

export function parseAgentConfigurationChangesV1(
	input: unknown,
): UpdateAgentConfigurationCommandV2["changes"] {
	const changes = exactObject(
		input,
		[],
		[
			"coOwnerIds",
			"availability",
			"source",
			"modelConfiguration",
			"environment",
			"secrets",
			"channels",
		],
	);
	return {
		...(Object.hasOwn(changes, "coOwnerIds")
			? { coOwnerIds: parseOwnerIds(changes.coOwnerIds) }
			: {}),
		...(Object.hasOwn(changes, "availability")
			? { availability: parseAvailability(changes.availability) }
			: {}),
		...(Object.hasOwn(changes, "source")
			? { source: parseSourceSelection(changes.source) }
			: {}),
		...(Object.hasOwn(changes, "modelConfiguration")
			? {
					modelConfiguration: parseModelConfiguration(
						changes.modelConfiguration,
					),
				}
			: {}),
		...(Object.hasOwn(changes, "environment")
			? { environment: parseEnvironment(changes.environment) }
			: {}),
		...(Object.hasOwn(changes, "secrets")
			? { secrets: parseSecretReplacements(changes.secrets) }
			: {}),
		...(Object.hasOwn(changes, "channels")
			? { channels: parseChannelChanges(changes.channels) }
			: {}),
	};
}

/** Historical validation only; never use the result for a new mutation. */
export function parseLegacyAgentConfigurationChangesV1(
	input: unknown,
): LegacyUpdateAgentConfigurationCommandV1["changes"] {
	const values = exactObject(
		input,
		[],
		[
			"coOwnerIds",
			"availability",
			"source",
			"modelConfiguration",
			"environment",
			"secrets",
			"actions",
			"channels",
		],
	);
	const { actions, ...currentFields } = values;
	return {
		...parseAgentConfigurationChangesV1(currentFields),
		...(Object.hasOwn(values, "actions")
			? { actions: canonicalActions(actions) }
			: {}),
	};
}

export function parseLegacyUpdateCommand(
	input: unknown,
): LegacyUpdateAgentConfigurationCommandV1 {
	const values = exactObject(input, [
		"schemaVersion",
		"agentId",
		"idempotencyKey",
		"requestId",
		"traceId",
		"changes",
	]);
	if (values.schemaVersion !== 1) invalidCommand();
	const changes = parseLegacyAgentConfigurationChangesV1(values.changes);
	const { actions: _historicalActions, ...currentChanges } = changes;
	const current = parseCommand({
		...values,
		schemaVersion: 2,
		changes: currentChanges,
	});
	return { ...current, schemaVersion: 1, changes };
}

export function validateLegacyInitialActionsV1(input: unknown): void {
	canonicalActions(input);
}

export function parseCommand(
	command: unknown,
): UpdateAgentConfigurationCommandV2 {
	const values = exactObject(command, [
		"schemaVersion",
		"agentId",
		"idempotencyKey",
		"requestId",
		"traceId",
		"changes",
	]);
	if (
		values.schemaVersion !== 2 ||
		!isText(values.agentId, idMaxBytes) ||
		!isText(values.idempotencyKey, 128) ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(values.idempotencyKey) ||
		!isText(values.requestId, idMaxBytes) ||
		!isText(values.traceId, idMaxBytes)
	) {
		invalidCommand();
	}
	return {
		schemaVersion: 2,
		agentId: values.agentId,
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
		changes: parseAgentConfigurationChangesV1(values.changes),
	};
}

export function parseUpgradeCustomImageCommand(
	command: unknown,
): UpgradeCustomAgentImageCommandV1 {
	const values = exactObject(command, [
		"schemaVersion",
		"agentId",
		"imageReference",
		"idempotencyKey",
		"requestId",
		"traceId",
	]);
	if (
		values.schemaVersion !== 1 ||
		!isText(values.agentId, idMaxBytes) ||
		!isText(values.imageReference, 4096) ||
		!isText(values.idempotencyKey, 128) ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(values.idempotencyKey) ||
		!isText(values.requestId, idMaxBytes) ||
		!isText(values.traceId, idMaxBytes)
	) {
		invalidCommand();
	}
	return {
		schemaVersion: 1,
		agentId: values.agentId,
		imageReference: values.imageReference,
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
	};
}

export function parseStandardTemplateReleaseTargetV1(
	input: unknown,
): StandardTemplateReleaseTargetV1 {
	const value = exactObject(input, [
		"schemaVersion",
		"releaseId",
		"agentId",
		"templateId",
		"expectedConfigurationRevision",
		"expectedImageDigest",
		"targetImageDigest",
	]);
	if (
		value.schemaVersion !== 1 ||
		!isText(value.releaseId, 128) ||
		!/^[A-Za-z0-9._~-]+$/.test(value.releaseId) ||
		!isText(value.agentId, idMaxBytes) ||
		!isText(value.templateId, idMaxBytes) ||
		typeof value.expectedConfigurationRevision !== "number" ||
		!Number.isSafeInteger(value.expectedConfigurationRevision) ||
		value.expectedConfigurationRevision < 1 ||
		typeof value.expectedImageDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(value.expectedImageDigest) ||
		typeof value.targetImageDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(value.targetImageDigest) ||
		value.expectedImageDigest === value.targetImageDigest
	)
		invalidCommand();
	return {
		schemaVersion: 1,
		releaseId: value.releaseId,
		agentId: value.agentId,
		templateId: value.templateId,
		expectedConfigurationRevision: value.expectedConfigurationRevision,
		expectedImageDigest: value.expectedImageDigest,
		targetImageDigest: value.targetImageDigest,
	};
}

export function parseReleaseStandardTemplateCommand(
	input: unknown,
): ReleaseStandardTemplateCommandV1 {
	const value = exactObject(input, [
		"schemaVersion",
		"target",
		"idempotencyKey",
		"requestId",
		"traceId",
	]);
	if (
		value.schemaVersion !== 1 ||
		!isText(value.idempotencyKey, 128) ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(value.idempotencyKey) ||
		!isText(value.requestId, idMaxBytes) ||
		!isText(value.traceId, idMaxBytes)
	)
		invalidCommand();
	return {
		schemaVersion: 1,
		target: parseStandardTemplateReleaseTargetV1(value.target),
		idempotencyKey: value.idempotencyKey,
		requestId: value.requestId,
		traceId: value.traceId,
	};
}

export function parseInitialCommand(
	command: unknown,
): InitialAgentConfigurationCommandV2 {
	const values = exactObject(
		command,
		[
			"schemaVersion",
			"agentId",
			"requestId",
			"traceId",
			"coOwnerIds",
			"availability",
			"source",
			"environment",
			"secrets",
			"channels",
		],
		["modelConfiguration"],
	);
	if (
		values.schemaVersion !== 2 ||
		!isText(values.agentId, idMaxBytes) ||
		!isText(values.requestId, idMaxBytes) ||
		!isText(values.traceId, idMaxBytes)
	) {
		invalidCommand();
	}
	const coOwnerIds = parseOwnerIds(values.coOwnerIds);
	const availability = parseAvailability(values.availability);
	if (
		new Set(coOwnerIds).size !== coOwnerIds.length ||
		new Set(availability.map(accessTargetKey)).size !== availability.length
	) {
		invalidCommand();
	}
	return {
		schemaVersion: 2,
		agentId: values.agentId,
		requestId: values.requestId,
		traceId: values.traceId,
		coOwnerIds,
		availability,
		source: parseSourceSelection(values.source),
		...(Object.hasOwn(values, "modelConfiguration")
			? {
					modelConfiguration: parseModelConfiguration(
						values.modelConfiguration,
					),
				}
			: {}),
		environment: parseEnvironment(values.environment),
		secrets: parseSecretReplacements(values.secrets),
		channels: parseChannelChanges(values.channels),
	};
}

export function parseActorContext(
	actorContext: unknown,
): AgentConfigurationActorContextV1 {
	const values = exactObject(actorContext, [
		"schemaVersion",
		"actorId",
		"rawRequestDigest",
	]);
	if (
		values.schemaVersion !== 1 ||
		!isText(values.actorId, idMaxBytes) ||
		typeof values.rawRequestDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(values.rawRequestDigest)
	) {
		invalidCommand();
	}
	return {
		schemaVersion: 1,
		actorId: values.actorId,
		rawRequestDigest: values.rawRequestDigest,
	};
}
