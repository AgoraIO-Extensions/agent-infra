import { Buffer } from "node:buffer";
import type {
	AgentManagementActorContextV1,
	AgentManagementStateV1,
} from "./agent-management.js";
import { decideAgentAccessUpdatePolicy } from "./agent-management-access-policy.js";
import {
	isAgentManagementText as managementText,
	parseAgentManagementActorContext,
	parseAgentManagementPortState,
	parseAgentManagementStringArray,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
	snapshotAgentManagementDenseArray,
} from "./agent-management-input.js";
import { platformIdempotencyV1 } from "./idempotency.js";

export type AgentConfigurationSourceV1 =
	| {
			readonly kind: "standard";
			readonly templateId: string;
			readonly imageDigest: string;
			readonly admissionRevision: string;
			readonly allowedEnvironmentKeys: readonly string[];
			readonly allowedSecretKeys: readonly string[];
			readonly platformManagedKeys: readonly string[];
			readonly connectionEnabled: boolean;
	  }
	| {
			readonly kind: "custom";
			readonly imageDigest: string;
			readonly admissionRevision: string;
			readonly interactionMode: "self-managed" | "platform-adapter";
			readonly identityResponsibility?: "self-managed" | "platform-managed";
			readonly connectionEnabled: boolean;
	  };

export interface AgentConfigurationSecretMetadataV1 {
	readonly secretId: string;
	readonly version: number;
	readonly isSet: true;
}

export interface AgentConfigurationModelOptionV1 {
	readonly optionId: string;
	readonly endpointId: string;
	readonly modelId: string;
	readonly reasoningLevels: readonly string[];
	readonly credential: AgentConfigurationSecretMetadataV1;
}

export interface AgentConfigurationModelV1 {
	readonly catalogRevision: string;
	readonly options: readonly AgentConfigurationModelOptionV1[];
	readonly defaultOptionId: string;
	readonly defaultReasoningLevel: string;
}

export interface AgentConfigurationRecordV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly revision: number;
	readonly source: AgentConfigurationSourceV1;
	readonly modelConfiguration: AgentConfigurationModelV1 | null;
	readonly actions: readonly AgentConfigurationActionV1[];
	readonly actionSetRevision: string;
	readonly environment: readonly {
		readonly name: string;
		readonly value: string;
	}[];
	readonly secrets: readonly {
		readonly name: string;
		readonly secretId: string;
		readonly version: number;
		readonly isSet: true;
	}[];
	readonly channels: readonly {
		readonly kind: "wecom_bot" | "wecom_app";
		readonly bindingReference: string;
	}[];
	readonly channelRevision: string;
}

export interface AgentConfigurationActionV1 {
	readonly providerId: string;
	readonly actionId: string;
	readonly actionVersion: string;
}

export type AgentConfigurationChannelKindV1 = "wecom_bot" | "wecom_app";

export type AgentConfigurationChannelChangeV1 =
	| {
			readonly kind: AgentConfigurationChannelKindV1;
			readonly enabled: true;
			readonly bindingReference: string;
	  }
	| {
			readonly kind: AgentConfigurationChannelKindV1;
			readonly enabled: false;
	  };

export interface AgentConfigurationModelOptionInputV1 {
	readonly optionId: string;
	readonly endpointId: string;
	readonly modelId: string;
	readonly reasoningLevels: readonly string[];
	readonly replaceCredential: boolean;
}

export type AgentConfigurationSourceSelectionV1 =
	| { readonly kind: "standard"; readonly templateId: string }
	| {
			readonly kind: "custom";
			readonly imageReference: string;
			readonly interactionMode: "self-managed";
			readonly identityResponsibility: "self-managed" | "platform-managed";
	  }
	| {
			readonly kind: "custom";
			readonly imageReference: string;
			readonly interactionMode: "platform-adapter";
	  };

export interface AgentConfigurationModelInputV1 {
	readonly options: readonly AgentConfigurationModelOptionInputV1[];
	readonly defaultOptionId: string;
	readonly defaultReasoningLevel: string;
}

export interface AgentConfigurationSecretReplacementInputV1 {
	readonly name: string;
	readonly replace: true;
}

export type AgentConfigurationAccessTargetV1 =
	| { readonly kind: "user"; readonly userId: string }
	| { readonly kind: "organization"; readonly organizationId: string };

export interface AgentConfigurationAuthorityContextV1 {
	readonly schemaVersion: 1;
	readonly users: readonly {
		readonly userId: string;
		readonly accountStatus: "active" | "disabled" | "revoked";
	}[];
	readonly organizationIds: readonly string[];
}

export interface AgentConfigurationAccessAuthorityV1 {
	readonly state: AgentManagementStateV1;
	readonly actorContext: AgentManagementActorContextV1;
	readonly authorityContext: AgentConfigurationAuthorityContextV1;
}

export interface InitialAgentConfigurationCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly requestId: string;
	readonly traceId: string;
	readonly coOwnerIds: readonly string[];
	readonly availability: readonly AgentConfigurationAccessTargetV1[];
	readonly source: AgentConfigurationSourceSelectionV1;
	readonly modelConfiguration?: AgentConfigurationModelInputV1;
	readonly environment: readonly {
		readonly name: string;
		readonly value: string;
	}[];
	readonly secrets: readonly AgentConfigurationSecretReplacementInputV1[];
	readonly actions: readonly AgentConfigurationActionV1[];
	readonly channels: readonly AgentConfigurationChannelChangeV1[];
}

export interface AdmittedInitialAgentConfigurationV1 {
	readonly schemaVersion: 1;
	readonly authorizationRevision: string;
	readonly configuration: AgentConfigurationRecordV1;
	readonly ownerIds: readonly string[];
	readonly availability: readonly AgentConfigurationAccessTargetV1[];
}

export interface InitialAgentConfigurationAdmissionHandleV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly actorId: string;
	complete(): Promise<AdmittedInitialAgentConfigurationV1>;
}

export interface UpdateAgentConfigurationCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
	readonly changes: {
		readonly ownerIds?: readonly string[];
		readonly availability?: readonly AgentConfigurationAccessTargetV1[];
		readonly source?: AgentConfigurationSourceSelectionV1;
		readonly modelConfiguration?: AgentConfigurationModelInputV1;
		readonly environment?: readonly {
			readonly name: string;
			readonly value: string;
		}[];
		readonly secrets?: readonly AgentConfigurationSecretReplacementInputV1[];
		readonly actions?: readonly AgentConfigurationActionV1[];
		readonly channels?: readonly AgentConfigurationChannelChangeV1[];
	};
}

export interface UpgradeCustomAgentImageCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly imageReference: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface AgentConfigurationActorContextV1 {
	readonly schemaVersion: 1;
	readonly actorId: string;
	readonly rawRequestDigest: string;
}

export type AgentConfigurationChangedFieldV1 =
	| "source"
	| "environment"
	| "modelConfiguration"
	| "secrets"
	| "actions"
	| "channels"
	| "owners"
	| "availability";

export interface AgentConfigurationAccessPlanV1 {
	readonly schemaVersion: 1;
	readonly fragmentType: "agent_access";
	readonly agentId: string;
	readonly expectedRevision: number;
	readonly ownerIds: readonly string[];
	readonly availability: readonly AgentConfigurationAccessTargetV1[];
}

export interface AgentConfigurationResultV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly revision: number;
	readonly changedFields: readonly AgentConfigurationChangedFieldV1[];
}

export interface AgentConfigurationWritePlanV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly baseRevision: number;
	readonly nextRevision: number;
	readonly expectedAuthorizationRevision: string;
	readonly nextAuthorizationRevision: string;
	readonly configuration: AgentConfigurationRecordV1;
	readonly accessUpdate: AgentConfigurationAccessPlanV1 | null;
	readonly result: AgentConfigurationResultV1;
	readonly idempotency: {
		readonly key: string;
		readonly requestDigest: string;
	};
	readonly outboxIntent: {
		readonly operation: "agent.configuration.revised.v1";
		readonly payload: {
			readonly schemaVersion: 1;
			readonly agentId: string;
			readonly baseRevision: number;
			readonly configurationRevision: number;
			readonly changedFields: readonly AgentConfigurationChangedFieldV1[];
		};
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly auditEvent: {
		readonly action: "agent.configuration.revised" | "agent.access.updated";
		readonly actorId: string;
		readonly agentId: string;
		readonly subjectType: "agent";
		readonly subjectId: string;
		readonly changedFields: readonly AgentConfigurationChangedFieldV1[];
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
}

export interface AgentConfigurationTransactionPortV1 {
	read(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly actorId: string;
		readonly idempotencyKey: string;
		readonly requestDigest: string;
	}): Promise<
		| {
				readonly outcome: "ready";
				readonly record: {
					readonly schemaVersion: 1;
					readonly configuration: AgentConfigurationRecordV1;
					readonly authorizationRevision: string;
				};
		  }
		| { readonly outcome: "missing" }
		| {
				readonly outcome: "replayed";
				readonly result: AgentConfigurationResultV1;
		  }
		| { readonly outcome: "idempotency_conflict" }
	>;
	commit(plan: AgentConfigurationWritePlanV1): Promise<
		| {
				readonly outcome: "committed";
				readonly result: AgentConfigurationResultV1;
		  }
		| {
				readonly outcome: "replayed";
				readonly result: AgentConfigurationResultV1;
		  }
		| { readonly outcome: "stale" }
		| { readonly outcome: "idempotency_conflict" }
	>;
}

export interface AgentConfigurationAuthorizationAdmissionPortV1 {
	authorize(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly actorId: string;
		readonly requestId: string;
		readonly traceId: string;
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly actorId: string;
				readonly authorizationRevision: string;
				readonly accessAuthority?: AgentConfigurationAccessAuthorityV1;
				readonly authorityContext?: AgentConfigurationAuthorityContextV1;
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly actorId: string;
		  }
	>;
}

export interface AgentConfigurationImageAdmissionPortV1 {
	admitImage(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly requestId: string;
		readonly traceId: string;
		readonly requested: AgentConfigurationSourceSelectionV1;
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly requestId: string;
				readonly source: AgentConfigurationSourceV1;
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly requestId: string;
		  }
	>;
}

export interface AgentConfigurationModelAdmissionPortV1 {
	admitModels(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly requestId: string;
		readonly traceId: string;
		readonly requested: AgentConfigurationModelInputV1;
		readonly current: AgentConfigurationModelV1 | null;
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly requestId: string;
				readonly configuration: AgentConfigurationModelV1;
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly requestId: string;
		  }
	>;
}

export interface AgentConfigurationSecretAdmissionPortV1 {
	admitSecrets(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly requestId: string;
		readonly traceId: string;
		readonly requested: readonly AgentConfigurationSecretReplacementInputV1[];
		readonly current: AgentConfigurationRecordV1["secrets"];
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly requestId: string;
				readonly secrets: AgentConfigurationRecordV1["secrets"];
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly requestId: string;
		  }
	>;
}

export interface AgentConfigurationActionAdmissionPortV1 {
	admitActions(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly requestId: string;
		readonly traceId: string;
		readonly requested: readonly AgentConfigurationActionV1[];
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly requestId: string;
				readonly actionSetRevision: string;
				readonly actions: readonly AgentConfigurationActionV1[];
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly requestId: string;
		  }
	>;
}

export interface AgentConfigurationChannelAdmissionPortV1 {
	admitChannels(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly requestId: string;
		readonly traceId: string;
		readonly requested: readonly AgentConfigurationChannelChangeV1[];
		readonly current: AgentConfigurationRecordV1["channels"];
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly requestId: string;
				readonly channelRevision: string;
				readonly channels: AgentConfigurationRecordV1["channels"];
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly requestId: string;
		  }
	>;
}

export interface AgentConfigurationUseCaseV1 {
	update(
		command: UpdateAgentConfigurationCommandV1,
		actorContext: AgentConfigurationActorContextV1,
	): Promise<AgentConfigurationResultV1>;
	upgradeCustomImage(
		command: UpgradeCustomAgentImageCommandV1,
		actorContext: AgentConfigurationActorContextV1,
	): Promise<AgentConfigurationResultV1>;
}

export type AgentConfigurationErrorCode =
	| "invalid_command"
	| "not_authorized"
	| "not_admitted"
	| "no_change"
	| "stale_revision"
	| "idempotency_conflict"
	| "dependency_unavailable"
	| "persistence_failed";

export class AgentConfigurationError extends Error {
	readonly code: AgentConfigurationErrorCode;

	constructor(code: AgentConfigurationErrorCode) {
		super(`Agent configuration ${code.replaceAll("_", " ")}`);
		this.name = "AgentConfigurationError";
		this.code = code;
	}
}

export interface AgentConfigurationUseCaseDependenciesV1 {
	readonly transaction: AgentConfigurationTransactionPortV1;
	readonly authorizationAdmission: AgentConfigurationAuthorizationAdmissionPortV1;
	readonly imageAdmission: AgentConfigurationImageAdmissionPortV1;
	readonly modelAdmission: AgentConfigurationModelAdmissionPortV1;
	readonly secretAdmission: AgentConfigurationSecretAdmissionPortV1;
	readonly actionAdmission: AgentConfigurationActionAdmissionPortV1;
	readonly channelAdmission: AgentConfigurationChannelAdmissionPortV1;
}

export type InitialAgentConfigurationAdmissionDependenciesV1 = Omit<
	AgentConfigurationUseCaseDependenciesV1,
	"transaction"
>;

export interface AgentConfigurationUseCaseOptionsV1 {
	readonly now?: () => Date;
}

const idMaxBytes = 1024;
const valueMaxBytes = 65_536;
const maxModelOptions = 32;
const maxReasoningLevels = 16;
const maxEnvironmentEntries = 128;
const maxSecretReplacements = 128;
const maxActions = 256;
const maxChannelChanges = 2;
const maxAccessTargets = 256;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function invalidCommand(): never {
	throw new AgentConfigurationError("invalid_command");
}

function isText(value: unknown, maxBytes: number): value is string {
	return managementText(value, maxBytes);
}

function exactObject(
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

function denseArray(value: unknown, maxLength: number): unknown[] {
	try {
		return [...snapshotAgentManagementDenseArray(value, maxLength)];
	} catch {
		invalidCommand();
	}
}

function persistenceValue<T>(parse: () => T): T {
	try {
		return parse();
	} catch {
		throw new AgentConfigurationError("persistence_failed");
	}
}

function dependencyValue<T>(parse: () => T): T {
	try {
		return parse();
	} catch {
		throw new AgentConfigurationError("dependency_unavailable");
	}
}

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

function parseAdmittedSource(input: unknown): AgentConfigurationSourceV1 {
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

function parseEnvironment(input: unknown): { name: string; value: string }[] {
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

function canonicalActions(input: unknown): AgentConfigurationActionV1[] {
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

function canonicalChannelBindings(
	input: unknown,
): AgentConfigurationRecordV1["channels"] {
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

function parseOwnerIds(input: unknown): string[] {
	return denseArray(input, maxAccessTargets)
		.map((ownerId) => {
			if (!isText(ownerId, idMaxBytes)) invalidCommand();
			return ownerId;
		})
		.toSorted();
}

function accessTargetKey(target: AgentConfigurationAccessTargetV1): string {
	return target.kind === "user"
		? `user:${target.userId}`
		: `organization:${target.organizationId}`;
}

function parseAvailability(input: unknown): AgentConfigurationAccessTargetV1[] {
	return denseArray(input, maxAccessTargets)
		.map((targetInput) => {
			const target = exactObject(
				targetInput,
				["kind"],
				["userId", "organizationId"],
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
			if (
				target.kind !== "organization" ||
				!isText(target.organizationId, idMaxBytes) ||
				Object.keys(target).length !== 2
			) {
				invalidCommand();
			}
			return {
				kind: "organization" as const,
				organizationId: target.organizationId,
			};
		})
		.toSorted((left, right) =>
			compareText(accessTargetKey(left), accessTargetKey(right)),
		);
}

export function parseAgentConfigurationChangesV1(
	input: unknown,
): UpdateAgentConfigurationCommandV1["changes"] {
	const changes = exactObject(
		input,
		[],
		[
			"ownerIds",
			"availability",
			"source",
			"modelConfiguration",
			"environment",
			"secrets",
			"actions",
			"channels",
		],
	);
	return {
		...(Object.hasOwn(changes, "ownerIds")
			? { ownerIds: parseOwnerIds(changes.ownerIds) }
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
		...(Object.hasOwn(changes, "actions")
			? { actions: canonicalActions(changes.actions) }
			: {}),
		...(Object.hasOwn(changes, "channels")
			? { channels: parseChannelChanges(changes.channels) }
			: {}),
	};
}

function parseCommand(command: unknown): UpdateAgentConfigurationCommandV1 {
	const values = exactObject(command, [
		"schemaVersion",
		"agentId",
		"idempotencyKey",
		"requestId",
		"traceId",
		"changes",
	]);
	if (
		values.schemaVersion !== 1 ||
		!isText(values.agentId, idMaxBytes) ||
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
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
		changes: parseAgentConfigurationChangesV1(values.changes),
	};
}

function parseUpgradeCustomImageCommand(
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

function parseInitialCommand(
	command: unknown,
): InitialAgentConfigurationCommandV1 {
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
			"actions",
			"channels",
		],
		["modelConfiguration"],
	);
	if (
		values.schemaVersion !== 1 ||
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
		schemaVersion: 1,
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
		actions: canonicalActions(values.actions),
		channels: parseChannelChanges(values.channels),
	};
}

function parseActorContext(
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

function parseStoredModel(input: unknown): AgentConfigurationModelV1 {
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

function parseStoredSecrets(
	input: unknown,
): AgentConfigurationRecordV1["secrets"] {
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

export function decodeAgentConfigurationRecordV1(
	input: unknown,
): AgentConfigurationRecordV1 {
	const values = exactObject(input, [
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
	if (
		values.schemaVersion !== 1 ||
		!isText(values.agentId, idMaxBytes) ||
		typeof values.revision !== "number" ||
		!Number.isSafeInteger(values.revision) ||
		values.revision < 0 ||
		!isText(values.actionSetRevision, idMaxBytes) ||
		!isText(values.channelRevision, idMaxBytes)
	) {
		invalidCommand();
	}
	const source = parseAdmittedSource(values.source);
	const modelConfiguration =
		values.modelConfiguration === null
			? null
			: parseStoredModel(values.modelConfiguration);
	const actions = canonicalActions(values.actions);
	const environment = parseEnvironment(values.environment);
	const secrets = parseStoredSecrets(values.secrets);
	const channels = canonicalChannelBindings(values.channels);
	requireAdmittedConfigurationPolicy({
		source,
		modelConfiguration,
		environment,
		secrets,
		actions,
		channels,
	});
	return {
		schemaVersion: 1,
		agentId: values.agentId,
		revision: values.revision,
		source,
		modelConfiguration,
		actions,
		actionSetRevision: values.actionSetRevision,
		environment,
		secrets,
		channels,
		channelRevision: values.channelRevision,
	};
}

function parseAuthorityContext(
	input: unknown,
): AgentConfigurationAuthorityContextV1 {
	const authority = exactObject(input, [
		"schemaVersion",
		"users",
		"organizationIds",
	]);
	if (authority.schemaVersion !== 1) invalidCommand();
	const users = denseArray(authority.users, maxAccessTargets).map(
		(userInput) => {
			const user = exactObject(userInput, ["userId", "accountStatus"]);
			if (
				!isText(user.userId, idMaxBytes) ||
				(user.accountStatus !== "active" &&
					user.accountStatus !== "disabled" &&
					user.accountStatus !== "revoked")
			) {
				invalidCommand();
			}
			return {
				userId: user.userId,
				accountStatus:
					user.accountStatus as AgentConfigurationAccessAuthorityV1["authorityContext"]["users"][number]["accountStatus"],
			};
		},
	);
	if (new Set(users.map(({ userId }) => userId)).size !== users.length) {
		invalidCommand();
	}
	return {
		schemaVersion: 1,
		users,
		organizationIds: [
			...parseAgentManagementStringArray(authority.organizationIds, true),
		],
	};
}

function parseAccessAuthority(
	input: unknown,
): AgentConfigurationAccessAuthorityV1 {
	const access = exactObject(input, [
		"state",
		"actorContext",
		"authorityContext",
	]);
	return {
		state: parseAgentManagementPortState(access.state as never),
		actorContext: parseAgentManagementActorContext(access.actorContext),
		authorityContext: parseAuthorityContext(access.authorityContext),
	};
}

function parseAuthorizationDecision(
	input: unknown,
): Awaited<
	ReturnType<AgentConfigurationAuthorizationAdmissionPortV1["authorize"]>
> {
	return dependencyValue(() => {
		const base = exactObject(
			input,
			["schemaVersion", "status", "agentId", "actorId"],
			["authorizationRevision", "accessAuthority", "authorityContext"],
		);
		if (
			base.schemaVersion !== 1 ||
			!isText(base.agentId, idMaxBytes) ||
			!isText(base.actorId, idMaxBytes)
		) {
			invalidCommand();
		}
		if (base.status === "rejected") {
			requireAgentManagementExactKeys(base, [
				"schemaVersion",
				"status",
				"agentId",
				"actorId",
			]);
			return {
				schemaVersion: 1,
				status: "rejected",
				agentId: base.agentId,
				actorId: base.actorId,
			};
		}
		if (
			base.status !== "admitted" ||
			!isText(base.authorizationRevision, idMaxBytes)
		) {
			invalidCommand();
		}
		return {
			schemaVersion: 1,
			status: "admitted",
			agentId: base.agentId,
			actorId: base.actorId,
			authorizationRevision: base.authorizationRevision,
			...(Object.hasOwn(base, "accessAuthority")
				? { accessAuthority: parseAccessAuthority(base.accessAuthority) }
				: {}),
			...(Object.hasOwn(base, "authorityContext")
				? { authorityContext: parseAuthorityContext(base.authorityContext) }
				: {}),
		};
	});
}

function snapshotAdmissionDecision(
	input: unknown,
	admittedKeys: readonly string[],
):
	| { status: "rejected"; agentId: string; requestId: string }
	| {
			status: "admitted";
			agentId: string;
			requestId: string;
			values: Record<string, unknown>;
	  } {
	return dependencyValue(() => {
		const common = ["schemaVersion", "status", "agentId", "requestId"];
		const values = exactObject(input, common, admittedKeys);
		if (
			values.schemaVersion !== 1 ||
			!isText(values.agentId, idMaxBytes) ||
			!isText(values.requestId, idMaxBytes)
		) {
			invalidCommand();
		}
		if (values.status === "rejected") {
			requireAgentManagementExactKeys(values, common);
			return {
				status: "rejected",
				agentId: values.agentId,
				requestId: values.requestId,
			};
		}
		if (values.status !== "admitted") invalidCommand();
		requireAgentManagementExactKeys(values, [...common, ...admittedKeys]);
		return {
			status: "admitted",
			agentId: values.agentId,
			requestId: values.requestId,
			values,
		};
	});
}

function parseImageDecision(
	input: unknown,
): Awaited<ReturnType<AgentConfigurationImageAdmissionPortV1["admitImage"]>> {
	const decision = snapshotAdmissionDecision(input, ["source"]);
	return decision.status === "rejected"
		? { schemaVersion: 1, ...decision }
		: dependencyValue(() => ({
				schemaVersion: 1,
				status: "admitted",
				agentId: decision.agentId,
				requestId: decision.requestId,
				source: parseAdmittedSource(decision.values.source),
			}));
}

function parseModelDecision(
	input: unknown,
): Awaited<ReturnType<AgentConfigurationModelAdmissionPortV1["admitModels"]>> {
	const decision = snapshotAdmissionDecision(input, ["configuration"]);
	return decision.status === "rejected"
		? { schemaVersion: 1, ...decision }
		: dependencyValue(() => ({
				schemaVersion: 1,
				status: "admitted",
				agentId: decision.agentId,
				requestId: decision.requestId,
				configuration: parseStoredModel(decision.values.configuration),
			}));
}

function parseSecretDecision(
	input: unknown,
): Awaited<
	ReturnType<AgentConfigurationSecretAdmissionPortV1["admitSecrets"]>
> {
	const decision = snapshotAdmissionDecision(input, ["secrets"]);
	return decision.status === "rejected"
		? { schemaVersion: 1, ...decision }
		: dependencyValue(() => ({
				schemaVersion: 1,
				status: "admitted",
				agentId: decision.agentId,
				requestId: decision.requestId,
				secrets: parseStoredSecrets(decision.values.secrets),
			}));
}

function parseActionDecision(
	input: unknown,
): Awaited<
	ReturnType<AgentConfigurationActionAdmissionPortV1["admitActions"]>
> {
	const decision = snapshotAdmissionDecision(input, [
		"actionSetRevision",
		"actions",
	]);
	return decision.status === "rejected"
		? { schemaVersion: 1, ...decision }
		: dependencyValue(() => {
				if (!isText(decision.values.actionSetRevision, idMaxBytes)) {
					invalidCommand();
				}
				return {
					schemaVersion: 1,
					status: "admitted",
					agentId: decision.agentId,
					requestId: decision.requestId,
					actionSetRevision: decision.values.actionSetRevision,
					actions: canonicalActions(decision.values.actions),
				};
			});
}

function parseChannelDecision(
	input: unknown,
): Awaited<
	ReturnType<AgentConfigurationChannelAdmissionPortV1["admitChannels"]>
> {
	const decision = snapshotAdmissionDecision(input, [
		"channelRevision",
		"channels",
	]);
	return decision.status === "rejected"
		? { schemaVersion: 1, ...decision }
		: dependencyValue(() => {
				if (!isText(decision.values.channelRevision, idMaxBytes)) {
					invalidCommand();
				}
				return {
					schemaVersion: 1,
					status: "admitted",
					agentId: decision.agentId,
					requestId: decision.requestId,
					channelRevision: decision.values.channelRevision,
					channels: canonicalChannelBindings(decision.values.channels),
				};
			});
}

function parseAdmittedModel(
	input: unknown,
	requested: AgentConfigurationModelInputV1,
	current: AgentConfigurationModelV1 | null,
): AgentConfigurationModelV1 {
	const model = parseStoredModel(input);
	if (
		model.options.length !== requested.options.length ||
		model.defaultOptionId !== requested.defaultOptionId ||
		model.defaultReasoningLevel !== requested.defaultReasoningLevel ||
		model.options.some((option) => {
			const expected = requested.options.find(
				({ optionId }) => optionId === option.optionId,
			);
			const currentOption = current?.options.find(
				({ optionId }) => optionId === option.optionId,
			);
			return (
				!expected ||
				expected.endpointId !== option.endpointId ||
				expected.modelId !== option.modelId ||
				!sameValue(expected.reasoningLevels, option.reasoningLevels) ||
				(!expected.replaceCredential &&
					(!currentOption ||
						!sameValue(currentOption.credential, option.credential)))
			);
		})
	) {
		invalidCommand();
	}
	return model;
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function requireAdmittedConfigurationPolicy(
	configuration: Pick<
		AgentConfigurationRecordV1,
		| "source"
		| "modelConfiguration"
		| "environment"
		| "secrets"
		| "actions"
		| "channels"
	>,
): void {
	const {
		source,
		modelConfiguration,
		environment,
		secrets,
		actions,
		channels,
	} = configuration;
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
		(!source.connectionEnabled && actions.length > 0) ||
		(source.kind === "custom" &&
			source.interactionMode === "self-managed" &&
			channels.length > 0)
	) {
		throw new AgentConfigurationError("not_admitted");
	}
}

function sameSourceConfiguration(
	left: AgentConfigurationSourceV1,
	right: AgentConfigurationSourceV1,
): boolean {
	return sameValue(
		{ ...left, admissionRevision: undefined },
		{ ...right, admissionRevision: undefined },
	);
}

function sameModelConfiguration(
	left: AgentConfigurationModelV1 | null,
	right: AgentConfigurationModelV1 | null,
): boolean {
	return sameValue(
		left && { ...left, catalogRevision: undefined },
		right && { ...right, catalogRevision: undefined },
	);
}

function requestDigest(
	command: UpdateAgentConfigurationCommandV1,
	actor: AgentConfigurationActorContextV1,
): string {
	try {
		return platformIdempotencyV1.canonicalRequestDigest({
			schemaVersion: 1,
			operation: "agent.configuration.update.v1",
			agentId: command.agentId,
			actorId: actor.actorId,
			rawRequestDigest: actor.rawRequestDigest,
			changes: command.changes as never,
		});
	} catch {
		invalidCommand();
	}
}

function customImageUpgradeRequestDigest(
	command: UpgradeCustomAgentImageCommandV1,
	actor: AgentConfigurationActorContextV1,
): string {
	try {
		return platformIdempotencyV1.canonicalRequestDigest({
			schemaVersion: 1,
			operation: "agent.configuration.custom-image.upgrade.v1",
			agentId: command.agentId,
			actorId: actor.actorId,
			rawRequestDigest: actor.rawRequestDigest,
			imageReference: command.imageReference,
		});
	} catch {
		invalidCommand();
	}
}

function parseResult(
	input: unknown,
	agentId: string,
): AgentConfigurationResultV1 {
	return persistenceValue(() => {
		const result = exactObject(input, [
			"schemaVersion",
			"agentId",
			"revision",
			"changedFields",
		]);
		const changedFields = denseArray(result.changedFields, 8);
		if (
			result.schemaVersion !== 1 ||
			result.agentId !== agentId ||
			typeof result.revision !== "number" ||
			!Number.isSafeInteger(result.revision) ||
			result.revision < 0 ||
			changedFields.length === 0 ||
			new Set(changedFields).size !== changedFields.length ||
			!sameValue(changedFields, [...changedFields].sort()) ||
			changedFields.some(
				(field) =>
					!(
						[
							"source",
							"environment",
							"modelConfiguration",
							"secrets",
							"actions",
							"channels",
							"owners",
							"availability",
						] as readonly unknown[]
					).includes(field),
			)
		) {
			invalidCommand();
		}
		return {
			schemaVersion: 1,
			agentId,
			revision: result.revision,
			changedFields: changedFields as AgentConfigurationChangedFieldV1[],
		};
	});
}

function configurationPlanObject(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	return persistenceValue(() => {
		const values = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(values, keys);
		return values;
	});
}

function configurationPlanDate(input: unknown): Date {
	return persistenceValue(() => {
		const milliseconds = Date.prototype.getTime.call(input);
		if (!Number.isFinite(milliseconds)) throw new Error();
		return new Date(milliseconds);
	});
}

function snapshotConfigurationAccessPlanV1(
	input: unknown,
	agentId: string,
): AgentConfigurationAccessPlanV1 | null {
	if (input === null) return null;
	return persistenceValue(() => {
		const values = configurationPlanObject(input, [
			"schemaVersion",
			"fragmentType",
			"agentId",
			"expectedRevision",
			"ownerIds",
			"availability",
		]);
		const ownerInputs = snapshotAgentManagementDenseArray(
			values.ownerIds,
			maxAccessTargets,
		);
		const ownerIds = parseOwnerIds(ownerInputs);
		const availabilityInputs = snapshotAgentManagementDenseArray(
			values.availability,
			maxAccessTargets,
		);
		const availability = parseAvailability(availabilityInputs);
		if (
			values.schemaVersion !== 1 ||
			values.fragmentType !== "agent_access" ||
			values.agentId !== agentId ||
			!Number.isSafeInteger(values.expectedRevision) ||
			(values.expectedRevision as number) < 0 ||
			ownerIds.length === 0 ||
			new Set(ownerIds).size !== ownerIds.length ||
			new Set(availability.map(accessTargetKey)).size !== availability.length ||
			!sameValue(ownerInputs, ownerIds) ||
			!sameValue(availabilityInputs, availability)
		) {
			throw new Error();
		}
		return {
			schemaVersion: 1,
			fragmentType: "agent_access",
			agentId,
			expectedRevision: values.expectedRevision as number,
			ownerIds,
			availability,
		};
	});
}

export function snapshotAgentConfigurationWritePlanV1(
	input: unknown,
): AgentConfigurationWritePlanV1 {
	return persistenceValue(() => {
		const values = configurationPlanObject(input, [
			"schemaVersion",
			"agentId",
			"baseRevision",
			"nextRevision",
			"expectedAuthorizationRevision",
			"nextAuthorizationRevision",
			"configuration",
			"accessUpdate",
			"result",
			"idempotency",
			"outboxIntent",
			"auditEvent",
		]);
		if (!isText(values.agentId, idMaxBytes)) throw new Error();
		const agentId = values.agentId;
		const configuration = decodeAgentConfigurationRecordV1(
			values.configuration,
		);
		requireAdmittedConfigurationPolicy(configuration);
		const result = parseResult(values.result, agentId);
		const accessUpdate = snapshotConfigurationAccessPlanV1(
			values.accessUpdate,
			agentId,
		);
		const idempotency = configurationPlanObject(values.idempotency, [
			"key",
			"requestDigest",
		]);
		const outbox = configurationPlanObject(values.outboxIntent, [
			"operation",
			"payload",
			"traceId",
			"requestId",
			"occurredAt",
		]);
		const payload = configurationPlanObject(outbox.payload, [
			"schemaVersion",
			"agentId",
			"baseRevision",
			"configurationRevision",
			"changedFields",
		]);
		const payloadChangedFields = snapshotAgentManagementDenseArray(
			payload.changedFields,
			8,
		);
		const audit = configurationPlanObject(values.auditEvent, [
			"action",
			"actorId",
			"agentId",
			"subjectType",
			"subjectId",
			"changedFields",
			"traceId",
			"requestId",
			"occurredAt",
		]);
		const auditChangedFields = snapshotAgentManagementDenseArray(
			audit.changedFields,
			8,
		);
		const outboxOccurredAt = configurationPlanDate(outbox.occurredAt);
		const auditOccurredAt = configurationPlanDate(audit.occurredAt);
		const accessFields = result.changedFields.filter(
			(field) => field === "owners" || field === "availability",
		);
		const accessOnly = accessFields.length === result.changedFields.length;
		const expectedAction = accessOnly
			? "agent.access.updated"
			: "agent.configuration.revised";
		if (
			values.schemaVersion !== 1 ||
			!Number.isSafeInteger(values.baseRevision) ||
			(values.baseRevision as number) < 1 ||
			values.baseRevision === Number.MAX_SAFE_INTEGER ||
			values.nextRevision !== (values.baseRevision as number) + 1 ||
			!isText(values.expectedAuthorizationRevision, idMaxBytes) ||
			!isText(values.nextAuthorizationRevision, idMaxBytes) ||
			configuration.agentId !== agentId ||
			configuration.revision !== values.nextRevision ||
			result.revision !== values.nextRevision ||
			!isText(idempotency.key, 128) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(idempotency.key) ||
			typeof idempotency.requestDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(idempotency.requestDigest) ||
			outbox.operation !== "agent.configuration.revised.v1" ||
			payload.schemaVersion !== 1 ||
			payload.agentId !== agentId ||
			payload.baseRevision !== values.baseRevision ||
			payload.configurationRevision !== values.nextRevision ||
			!sameValue(payloadChangedFields, result.changedFields) ||
			!isText(outbox.traceId, idMaxBytes) ||
			!isText(outbox.requestId, idMaxBytes) ||
			audit.action !== expectedAction ||
			!isText(audit.actorId, idMaxBytes) ||
			audit.agentId !== agentId ||
			audit.subjectType !== "agent" ||
			audit.subjectId !== agentId ||
			!sameValue(auditChangedFields, result.changedFields) ||
			audit.traceId !== outbox.traceId ||
			audit.requestId !== outbox.requestId ||
			auditOccurredAt.getTime() !== outboxOccurredAt.getTime() ||
			accessFields.length > 0 !== (accessUpdate !== null)
		) {
			throw new Error();
		}
		return {
			schemaVersion: 1,
			agentId,
			baseRevision: values.baseRevision as number,
			nextRevision: values.nextRevision as number,
			expectedAuthorizationRevision: values.expectedAuthorizationRevision,
			nextAuthorizationRevision: values.nextAuthorizationRevision,
			configuration,
			accessUpdate,
			result,
			idempotency: {
				key: idempotency.key,
				requestDigest: idempotency.requestDigest,
			},
			outboxIntent: {
				operation: "agent.configuration.revised.v1",
				payload: {
					schemaVersion: 1,
					agentId,
					baseRevision: values.baseRevision as number,
					configurationRevision: values.nextRevision as number,
					changedFields: result.changedFields,
				},
				traceId: outbox.traceId,
				requestId: outbox.requestId,
				occurredAt: outboxOccurredAt,
			},
			auditEvent: {
				action: expectedAction,
				actorId: audit.actorId,
				agentId,
				subjectType: "agent",
				subjectId: agentId,
				changedFields: result.changedFields,
				traceId: outbox.traceId,
				requestId: outbox.requestId,
				occurredAt: auditOccurredAt,
			},
		};
	});
}

function parseTransactionReadDecision(
	input: unknown,
	agentId: string,
): Awaited<ReturnType<AgentConfigurationTransactionPortV1["read"]>> {
	return persistenceValue(() => {
		const base = exactObject(input, ["outcome"], ["record", "result"]);
		if (base.outcome === "ready") {
			requireAgentManagementExactKeys(base, ["outcome", "record"]);
			const record = exactObject(base.record, [
				"schemaVersion",
				"configuration",
				"authorizationRevision",
			]);
			if (
				record.schemaVersion !== 1 ||
				!isText(record.authorizationRevision, idMaxBytes)
			) {
				invalidCommand();
			}
			return {
				outcome: "ready",
				record: {
					schemaVersion: 1,
					configuration: decodeAgentConfigurationRecordV1(record.configuration),
					authorizationRevision: record.authorizationRevision,
				},
			};
		}
		if (base.outcome === "replayed") {
			requireAgentManagementExactKeys(base, ["outcome", "result"]);
			return { outcome: "replayed", result: parseResult(base.result, agentId) };
		}
		if (base.outcome === "missing" || base.outcome === "idempotency_conflict") {
			requireAgentManagementExactKeys(base, ["outcome"]);
			return { outcome: base.outcome };
		}
		invalidCommand();
	});
}

function parseTransactionCommitDecision(
	input: unknown,
	agentId: string,
): Awaited<ReturnType<AgentConfigurationTransactionPortV1["commit"]>> {
	return persistenceValue(() => {
		const base = exactObject(input, ["outcome"], ["result"]);
		if (base.outcome === "committed" || base.outcome === "replayed") {
			requireAgentManagementExactKeys(base, ["outcome", "result"]);
			return {
				outcome: base.outcome,
				result: parseResult(base.result, agentId),
			};
		}
		if (base.outcome === "stale" || base.outcome === "idempotency_conflict") {
			requireAgentManagementExactKeys(base, ["outcome"]);
			return { outcome: base.outcome };
		}
		invalidCommand();
	});
}

const systemNow = () => new Date();

async function admitCurrentAuthorization(
	admission: AgentConfigurationAuthorizationAdmissionPortV1,
	command: Pick<
		UpdateAgentConfigurationCommandV1,
		"agentId" | "requestId" | "traceId"
	>,
	actorContext: AgentConfigurationActorContextV1,
): Promise<
	Extract<
		Awaited<
			ReturnType<AgentConfigurationAuthorizationAdmissionPortV1["authorize"]>
		>,
		{ readonly status: "admitted" }
	>
> {
	let authorization: Awaited<
		ReturnType<AgentConfigurationAuthorizationAdmissionPortV1["authorize"]>
	>;
	try {
		authorization = parseAuthorizationDecision(
			await admission.authorize({
				schemaVersion: 1,
				agentId: command.agentId,
				actorId: actorContext.actorId,
				requestId: command.requestId,
				traceId: command.traceId,
			}),
		);
	} catch {
		throw new AgentConfigurationError("dependency_unavailable");
	}
	if (
		authorization.status !== "admitted" ||
		authorization.schemaVersion !== 1 ||
		authorization.agentId !== command.agentId ||
		authorization.actorId !== actorContext.actorId ||
		!isText(authorization.authorizationRevision, idMaxBytes)
	) {
		throw new AgentConfigurationError("not_authorized");
	}
	return authorization;
}

function admittedInitialAccess(
	command: InitialAgentConfigurationCommandV1,
	actorContext: AgentConfigurationActorContextV1,
	authorization: Extract<
		Awaited<
			ReturnType<AgentConfigurationAuthorizationAdmissionPortV1["authorize"]>
		>,
		{ readonly status: "admitted" }
	>,
): Pick<AdmittedInitialAgentConfigurationV1, "ownerIds" | "availability"> {
	const authority = authorization.authorityContext;
	if (!authority) {
		throw new AgentConfigurationError("dependency_unavailable");
	}
	const activeUserIds = new Set(
		authority.users
			.filter(({ accountStatus }) => accountStatus === "active")
			.map(({ userId }) => userId),
	);
	const organizationIds = new Set(authority.organizationIds);
	if (
		!activeUserIds.has(actorContext.actorId) ||
		command.coOwnerIds.some((ownerId) => !activeUserIds.has(ownerId)) ||
		command.availability.some((target) =>
			target.kind === "user"
				? !activeUserIds.has(target.userId)
				: !organizationIds.has(target.organizationId),
		)
	) {
		throw new AgentConfigurationError("not_authorized");
	}
	return {
		ownerIds: [
			...new Set([actorContext.actorId, ...command.coOwnerIds]),
		].toSorted(compareText),
		availability: structuredClone(command.availability),
	};
}

async function completeInitialAgentConfigurationAdmissionV1(
	command: InitialAgentConfigurationCommandV1,
	actorContext: AgentConfigurationActorContextV1,
	firstAuthorization: Extract<
		Awaited<
			ReturnType<AgentConfigurationAuthorizationAdmissionPortV1["authorize"]>
		>,
		{ readonly status: "admitted" }
	>,
	dependencies: InitialAgentConfigurationAdmissionDependenciesV1,
): Promise<AdmittedInitialAgentConfigurationV1> {
	admittedInitialAccess(command, actorContext, firstAuthorization);

	let imageAdmission: Awaited<
		ReturnType<AgentConfigurationImageAdmissionPortV1["admitImage"]>
	>;
	try {
		imageAdmission = parseImageDecision(
			await dependencies.imageAdmission.admitImage({
				schemaVersion: 1,
				agentId: command.agentId,
				requestId: command.requestId,
				traceId: command.traceId,
				requested: structuredClone(command.source),
			}),
		);
	} catch {
		throw new AgentConfigurationError("dependency_unavailable");
	}
	const source =
		imageAdmission.status === "admitted" ? imageAdmission.source : undefined;
	const selectionMatches =
		source !== undefined &&
		command.source.kind === source.kind &&
		(command.source.kind === "standard"
			? source.kind === "standard" &&
				command.source.templateId === source.templateId
			: source.kind === "custom" &&
				source.interactionMode === command.source.interactionMode &&
				(command.source.interactionMode === "platform-adapter" ||
					(source.interactionMode === "self-managed" &&
						source.identityResponsibility ===
							command.source.identityResponsibility)));
	if (
		imageAdmission.status !== "admitted" ||
		imageAdmission.agentId !== command.agentId ||
		imageAdmission.requestId !== command.requestId ||
		!source ||
		!selectionMatches
	) {
		throw new AgentConfigurationError("not_admitted");
	}

	if (
		(source.kind === "standard" && command.modelConfiguration === undefined) ||
		(source.kind === "custom" && command.modelConfiguration !== undefined) ||
		(source.kind === "standard" &&
			(command.environment.some(
				({ name }) =>
					!source.allowedEnvironmentKeys.includes(name) ||
					source.platformManagedKeys.includes(name),
			) ||
				command.secrets.some(
					({ name }) =>
						!source.allowedSecretKeys.includes(name) ||
						source.platformManagedKeys.includes(name),
				))) ||
		(!source.connectionEnabled && command.actions.length > 0) ||
		(source.kind === "custom" &&
			source.interactionMode === "self-managed" &&
			command.channels.some(({ enabled }) => enabled))
	) {
		throw new AgentConfigurationError("not_admitted");
	}

	let modelConfiguration: AgentConfigurationModelV1 | null = null;
	if (command.modelConfiguration) {
		let admission: Awaited<
			ReturnType<AgentConfigurationModelAdmissionPortV1["admitModels"]>
		>;
		try {
			admission = parseModelDecision(
				await dependencies.modelAdmission.admitModels({
					schemaVersion: 1,
					agentId: command.agentId,
					requestId: command.requestId,
					traceId: command.traceId,
					requested: structuredClone(command.modelConfiguration),
					current: null,
				}),
			);
		} catch {
			throw new AgentConfigurationError("dependency_unavailable");
		}
		if (
			admission.status !== "admitted" ||
			admission.agentId !== command.agentId ||
			admission.requestId !== command.requestId
		) {
			throw new AgentConfigurationError("not_admitted");
		}
		try {
			modelConfiguration = parseAdmittedModel(
				admission.configuration,
				command.modelConfiguration,
				null,
			);
		} catch {
			throw new AgentConfigurationError("not_admitted");
		}
	}

	let secretAdmission: Awaited<
		ReturnType<AgentConfigurationSecretAdmissionPortV1["admitSecrets"]>
	>;
	try {
		secretAdmission = parseSecretDecision(
			await dependencies.secretAdmission.admitSecrets({
				schemaVersion: 1,
				agentId: command.agentId,
				requestId: command.requestId,
				traceId: command.traceId,
				requested: structuredClone(command.secrets),
				current: [],
			}),
		);
	} catch {
		throw new AgentConfigurationError("dependency_unavailable");
	}
	const requestedSecretNames = new Set(command.secrets.map(({ name }) => name));
	if (
		secretAdmission.status !== "admitted" ||
		secretAdmission.agentId !== command.agentId ||
		secretAdmission.requestId !== command.requestId ||
		secretAdmission.secrets.length !== requestedSecretNames.size ||
		secretAdmission.secrets.some(({ name }) => !requestedSecretNames.has(name))
	) {
		throw new AgentConfigurationError("not_admitted");
	}

	let actionAdmission: Awaited<
		ReturnType<AgentConfigurationActionAdmissionPortV1["admitActions"]>
	>;
	try {
		actionAdmission = parseActionDecision(
			await dependencies.actionAdmission.admitActions({
				schemaVersion: 1,
				agentId: command.agentId,
				requestId: command.requestId,
				traceId: command.traceId,
				requested: structuredClone(command.actions),
			}),
		);
	} catch {
		throw new AgentConfigurationError("dependency_unavailable");
	}
	if (
		actionAdmission.status !== "admitted" ||
		actionAdmission.agentId !== command.agentId ||
		actionAdmission.requestId !== command.requestId ||
		!sameValue(actionAdmission.actions, command.actions)
	) {
		throw new AgentConfigurationError("not_admitted");
	}

	let channelAdmission: Awaited<
		ReturnType<AgentConfigurationChannelAdmissionPortV1["admitChannels"]>
	>;
	try {
		channelAdmission = parseChannelDecision(
			await dependencies.channelAdmission.admitChannels({
				schemaVersion: 1,
				agentId: command.agentId,
				requestId: command.requestId,
				traceId: command.traceId,
				requested: structuredClone(command.channels),
				current: [],
			}),
		);
	} catch {
		throw new AgentConfigurationError("dependency_unavailable");
	}
	const expectedChannels = command.channels
		.filter((change) => change.enabled)
		.map((change) => ({
			kind: change.kind,
			bindingReference: change.enabled ? change.bindingReference : "",
		}))
		.toSorted((left, right) => compareText(left.kind, right.kind));
	if (
		channelAdmission.status !== "admitted" ||
		channelAdmission.agentId !== command.agentId ||
		channelAdmission.requestId !== command.requestId ||
		!sameValue(channelAdmission.channels, expectedChannels)
	) {
		throw new AgentConfigurationError("not_admitted");
	}

	const configuration: AgentConfigurationRecordV1 = {
		schemaVersion: 1,
		agentId: command.agentId,
		revision: 1,
		source,
		modelConfiguration,
		actions: actionAdmission.actions,
		actionSetRevision: actionAdmission.actionSetRevision,
		environment: command.environment,
		secrets: secretAdmission.secrets,
		channels: channelAdmission.channels,
		channelRevision: channelAdmission.channelRevision,
	};
	requireAdmittedConfigurationPolicy(configuration);

	const currentAuthorization = await admitCurrentAuthorization(
		dependencies.authorizationAdmission,
		command,
		actorContext,
	);
	const access = admittedInitialAccess(
		command,
		actorContext,
		currentAuthorization,
	);
	return {
		schemaVersion: 1,
		authorizationRevision: currentAuthorization.authorizationRevision,
		configuration: structuredClone(configuration),
		ownerIds: access.ownerIds,
		availability: access.availability,
	};
}

export async function beginInitialAgentConfigurationAdmissionV1(
	commandInput: InitialAgentConfigurationCommandV1,
	actorContextInput: AgentConfigurationActorContextV1,
	dependencies: InitialAgentConfigurationAdmissionDependenciesV1,
): Promise<InitialAgentConfigurationAdmissionHandleV1> {
	const command = parseInitialCommand(commandInput);
	const actorContext = parseActorContext(actorContextInput);
	const capturedDependencies: InitialAgentConfigurationAdmissionDependenciesV1 =
		{
			authorizationAdmission: dependencies.authorizationAdmission,
			imageAdmission: dependencies.imageAdmission,
			modelAdmission: dependencies.modelAdmission,
			secretAdmission: dependencies.secretAdmission,
			actionAdmission: dependencies.actionAdmission,
			channelAdmission: dependencies.channelAdmission,
		};
	const firstAuthorization = await admitCurrentAuthorization(
		capturedDependencies.authorizationAdmission,
		command,
		actorContext,
	);
	let completion: Promise<AdmittedInitialAgentConfigurationV1> | undefined;
	return Object.freeze({
		schemaVersion: 1 as const,
		agentId: command.agentId,
		actorId: actorContext.actorId,
		complete() {
			completion ??= completeInitialAgentConfigurationAdmissionV1(
				command,
				actorContext,
				firstAuthorization,
				capturedDependencies,
			);
			return completion;
		},
	});
}

export function createAgentConfigurationUseCaseV1(
	dependencies: AgentConfigurationUseCaseDependenciesV1,
	options: AgentConfigurationUseCaseOptionsV1 = {},
): AgentConfigurationUseCaseV1 {
	const now = options.now ?? systemNow;
	type ExecutionCommand = Pick<
		UpdateAgentConfigurationCommandV1,
		"schemaVersion" | "agentId" | "idempotencyKey" | "requestId" | "traceId"
	>;
	const execute = async (
		command: ExecutionCommand,
		actorContext: AgentConfigurationActorContextV1,
		digest: string,
		changesFromCurrent: (
			current: AgentConfigurationRecordV1,
		) => UpdateAgentConfigurationCommandV1["changes"],
	): Promise<AgentConfigurationResultV1> => {
		await admitCurrentAuthorization(
			dependencies.authorizationAdmission,
			command,
			actorContext,
		);
		let readDecision: Awaited<
			ReturnType<AgentConfigurationTransactionPortV1["read"]>
		>;
		try {
			readDecision = parseTransactionReadDecision(
				await dependencies.transaction.read({
					schemaVersion: 1,
					agentId: command.agentId,
					actorId: actorContext.actorId,
					idempotencyKey: command.idempotencyKey,
					requestDigest: digest,
				}),
				command.agentId,
			);
		} catch {
			throw new AgentConfigurationError("persistence_failed");
		}
		if (readDecision.outcome === "replayed") {
			return parseResult(readDecision.result, command.agentId);
		}
		if (readDecision.outcome === "idempotency_conflict") {
			throw new AgentConfigurationError("idempotency_conflict");
		}
		if (
			readDecision.outcome === "missing" ||
			readDecision.record.configuration.agentId !== command.agentId
		) {
			throw new AgentConfigurationError("not_authorized");
		}
		const current = readDecision.record.configuration;
		const authorization = await admitCurrentAuthorization(
			dependencies.authorizationAdmission,
			command,
			actorContext,
		);
		const changes = changesFromCurrent(current);

		let accessUpdate: AgentConfigurationAccessPlanV1 | null = null;
		const changedFields: AgentConfigurationChangedFieldV1[] = [];
		if (changes.ownerIds !== undefined || changes.availability !== undefined) {
			const access = authorization.accessAuthority;
			if (
				!access ||
				access.state.agentId !== command.agentId ||
				access.actorContext.userId !== actorContext.actorId
			) {
				throw new AgentConfigurationError("dependency_unavailable");
			}
			let decision: ReturnType<typeof decideAgentAccessUpdatePolicy>;
			try {
				decision = decideAgentAccessUpdatePolicy(
					{
						schemaVersion: 1,
						agentId: command.agentId,
						expectedRevision: access.state.revision,
						desiredOwnerIds: changes.ownerIds ?? access.state.ownerIds,
						desiredAvailability:
							changes.availability ?? access.state.availability,
						requestId: command.requestId,
						traceId: command.traceId,
					},
					access.state,
					access.actorContext,
					access.authorityContext,
				);
			} catch {
				throw new AgentConfigurationError("dependency_unavailable");
			}
			if (decision.outcome === "denied") {
				throw new AgentConfigurationError("not_authorized");
			}
			if (decision.outcome === "conflict") {
				if (decision.reason === "stale_revision") {
					throw new AgentConfigurationError("stale_revision");
				}
				if (decision.reason !== "no_change") {
					throw new AgentConfigurationError("not_admitted");
				}
			} else {
				const fragment = decision.planFragment;
				if (
					fragment.agentId !== command.agentId ||
					fragment.expectedRevision !== access.state.revision ||
					fragment.auditEvent.actorId !== actorContext.actorId ||
					fragment.auditEvent.subjectType !== "agent" ||
					fragment.auditEvent.subjectId !== command.agentId ||
					fragment.auditEvent.requestId !== command.requestId ||
					fragment.auditEvent.traceId !== command.traceId
				) {
					throw new AgentConfigurationError("dependency_unavailable");
				}
				accessUpdate = {
					schemaVersion: 1,
					fragmentType: "agent_access",
					agentId: fragment.agentId,
					expectedRevision: fragment.expectedRevision,
					ownerIds: fragment.ownerIds,
					availability: fragment.availability,
				};
				if (!sameValue(fragment.ownerIds, [...access.state.ownerIds].sort())) {
					changedFields.push("owners");
				}
				if (
					!sameValue(
						fragment.availability.map(accessTargetKey).sort(),
						access.state.availability.map(accessTargetKey).sort(),
					)
				) {
					changedFields.push("availability");
				}
			}
		}

		let source = current.source;
		if (changes.source) {
			let admission: Awaited<
				ReturnType<AgentConfigurationImageAdmissionPortV1["admitImage"]>
			>;
			try {
				admission = parseImageDecision(
					await dependencies.imageAdmission.admitImage({
						schemaVersion: 1,
						agentId: command.agentId,
						requestId: command.requestId,
						traceId: command.traceId,
						requested: structuredClone(changes.source),
					}),
				);
			} catch {
				throw new AgentConfigurationError("dependency_unavailable");
			}
			const admittedSource =
				admission.status === "admitted" ? admission.source : current.source;
			const selectionMatches =
				changes.source.kind === admittedSource.kind &&
				(changes.source.kind === "standard"
					? admittedSource.kind === "standard" &&
						admittedSource.templateId === changes.source.templateId
					: admittedSource.kind === "custom" &&
						admittedSource.interactionMode === changes.source.interactionMode &&
						(changes.source.interactionMode === "platform-adapter" ||
							(admittedSource.interactionMode === "self-managed" &&
								admittedSource.identityResponsibility ===
									changes.source.identityResponsibility)));
			const preservesSourceKind =
				current.source.kind === admittedSource.kind &&
				(current.source.kind === "standard"
					? admittedSource.kind === "standard" &&
						current.source.templateId === admittedSource.templateId
					: admittedSource.kind === "custom" &&
						current.source.interactionMode === admittedSource.interactionMode);
			if (
				admission.status !== "admitted" ||
				admission.schemaVersion !== 1 ||
				admission.agentId !== command.agentId ||
				admission.requestId !== command.requestId ||
				!selectionMatches ||
				!preservesSourceKind
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			if (sameSourceConfiguration(admittedSource, current.source)) {
				source = current.source;
			} else {
				source = admittedSource;
				changedFields.push("source");
			}
		}

		let modelConfiguration = current.modelConfiguration;
		if (changes.modelConfiguration) {
			if (source.kind !== "standard") {
				throw new AgentConfigurationError("not_admitted");
			}
			let admission: Awaited<
				ReturnType<AgentConfigurationModelAdmissionPortV1["admitModels"]>
			>;
			try {
				admission = parseModelDecision(
					await dependencies.modelAdmission.admitModels({
						schemaVersion: 1,
						agentId: command.agentId,
						requestId: command.requestId,
						traceId: command.traceId,
						requested: structuredClone(changes.modelConfiguration),
						current: structuredClone(current.modelConfiguration),
					}),
				);
			} catch {
				throw new AgentConfigurationError("dependency_unavailable");
			}
			if (
				admission.status !== "admitted" ||
				admission.schemaVersion !== 1 ||
				admission.agentId !== command.agentId ||
				admission.requestId !== command.requestId
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			try {
				modelConfiguration = parseAdmittedModel(
					admission.configuration,
					changes.modelConfiguration,
					current.modelConfiguration,
				);
			} catch {
				throw new AgentConfigurationError("not_admitted");
			}
			if (
				sameModelConfiguration(modelConfiguration, current.modelConfiguration)
			) {
				modelConfiguration = current.modelConfiguration;
			} else {
				changedFields.push("modelConfiguration");
			}
		}

		let environment = current.environment;
		if (changes.environment) {
			if (
				source.kind === "standard" &&
				changes.environment.some(
					({ name }) =>
						!source.allowedEnvironmentKeys.includes(name) ||
						source.platformManagedKeys.includes(name),
				)
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			environment = changes.environment;
			if (!sameValue(environment, current.environment)) {
				changedFields.push("environment");
			}
		}

		let secrets = current.secrets;
		if (changes.secrets) {
			if (
				source.kind === "standard" &&
				changes.secrets.some(
					({ name }) =>
						!source.allowedSecretKeys.includes(name) ||
						source.platformManagedKeys.includes(name),
				)
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			if (changes.secrets.length > 0) {
				let admission: Awaited<
					ReturnType<AgentConfigurationSecretAdmissionPortV1["admitSecrets"]>
				>;
				try {
					admission = parseSecretDecision(
						await dependencies.secretAdmission.admitSecrets({
							schemaVersion: 1,
							agentId: command.agentId,
							requestId: command.requestId,
							traceId: command.traceId,
							requested: structuredClone(changes.secrets),
							current: structuredClone(current.secrets),
						}),
					);
				} catch {
					throw new AgentConfigurationError("dependency_unavailable");
				}
				if (
					admission.status !== "admitted" ||
					admission.schemaVersion !== 1 ||
					admission.agentId !== command.agentId ||
					admission.requestId !== command.requestId ||
					admission.secrets.length !== changes.secrets.length
				) {
					throw new AgentConfigurationError("not_admitted");
				}
				const requestedNames = new Set(changes.secrets.map(({ name }) => name));
				const replacements = new Map<
					string,
					AgentConfigurationRecordV1["secrets"][number]
				>();
				for (const metadata of admission.secrets) {
					if (
						!requestedNames.has(metadata.name) ||
						replacements.has(metadata.name)
					) {
						throw new AgentConfigurationError("not_admitted");
					}
					replacements.set(metadata.name, {
						name: metadata.name,
						secretId: metadata.secretId,
						version: metadata.version,
						isSet: metadata.isSet,
					});
				}
				const merged = new Map(
					current.secrets.map((metadata) => [metadata.name, metadata]),
				);
				for (const [name, metadata] of replacements) {
					merged.set(name, metadata);
				}
				if (merged.size > maxSecretReplacements) {
					throw new AgentConfigurationError("not_admitted");
				}
				secrets = [...merged.values()].toSorted((left, right) =>
					compareText(left.name, right.name),
				);
				if (!sameValue(secrets, current.secrets)) {
					changedFields.push("secrets");
				}
			}
		}

		let actions = current.actions;
		let actionSetRevision = current.actionSetRevision;
		if (changes.actions) {
			if (!source.connectionEnabled) {
				if (changes.actions.length > 0) {
					throw new AgentConfigurationError("not_admitted");
				}
				actions = [];
				if (current.actions.length > 0) changedFields.push("actions");
			} else {
				let admission: Awaited<
					ReturnType<AgentConfigurationActionAdmissionPortV1["admitActions"]>
				>;
				try {
					admission = parseActionDecision(
						await dependencies.actionAdmission.admitActions({
							schemaVersion: 1,
							agentId: command.agentId,
							requestId: command.requestId,
							traceId: command.traceId,
							requested: structuredClone(changes.actions),
						}),
					);
				} catch {
					throw new AgentConfigurationError("dependency_unavailable");
				}
				const admittedActions =
					admission.status === "admitted" ? admission.actions : [];
				if (
					admission.status !== "admitted" ||
					admission.schemaVersion !== 1 ||
					admission.agentId !== command.agentId ||
					admission.requestId !== command.requestId ||
					!isText(admission.actionSetRevision, idMaxBytes) ||
					!sameValue(admittedActions, changes.actions)
				) {
					throw new AgentConfigurationError("not_admitted");
				}
				actions = admittedActions;
				if (!sameValue(actions, current.actions)) {
					actionSetRevision = admission.actionSetRevision;
					changedFields.push("actions");
				}
			}
		}

		let channels = current.channels;
		let channelRevision = current.channelRevision;
		if (changes.channels) {
			if (
				source.kind === "custom" &&
				source.interactionMode === "self-managed"
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			let admission: Awaited<
				ReturnType<AgentConfigurationChannelAdmissionPortV1["admitChannels"]>
			>;
			try {
				admission = parseChannelDecision(
					await dependencies.channelAdmission.admitChannels({
						schemaVersion: 1,
						agentId: command.agentId,
						requestId: command.requestId,
						traceId: command.traceId,
						requested: structuredClone(changes.channels),
						current: structuredClone(current.channels),
					}),
				);
			} catch {
				throw new AgentConfigurationError("dependency_unavailable");
			}
			const admittedChannels =
				admission.status === "admitted" ? admission.channels : [];
			const expected = new Map(
				current.channels.map((binding) => [binding.kind, binding]),
			);
			for (const change of changes.channels) {
				if (change.enabled) {
					expected.set(change.kind, {
						kind: change.kind,
						bindingReference: change.bindingReference,
					});
				} else {
					expected.delete(change.kind);
				}
			}
			const expectedChannels = [...expected.values()].toSorted((left, right) =>
				compareText(left.kind, right.kind),
			);
			if (
				admission.status !== "admitted" ||
				admission.schemaVersion !== 1 ||
				admission.agentId !== command.agentId ||
				admission.requestId !== command.requestId ||
				!isText(admission.channelRevision, idMaxBytes) ||
				!sameValue(admittedChannels, expectedChannels)
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			channels = admittedChannels;
			if (!sameValue(channels, current.channels)) {
				channelRevision = admission.channelRevision;
				changedFields.push("channels");
			}
		}

		requireAdmittedConfigurationPolicy({
			source,
			modelConfiguration,
			environment,
			secrets,
			actions,
			channels,
		});

		changedFields.sort();
		if (changedFields.length === 0) {
			throw new AgentConfigurationError("no_change");
		}
		let occurredAt: Date;
		try {
			const milliseconds = Date.prototype.getTime.call(now());
			if (!Number.isFinite(milliseconds)) throw new Error();
			occurredAt = new Date(milliseconds);
		} catch {
			throw new AgentConfigurationError("persistence_failed");
		}
		const nextRevision = current.revision + 1;
		if (!Number.isSafeInteger(nextRevision)) {
			throw new AgentConfigurationError("persistence_failed");
		}
		const configuration: AgentConfigurationRecordV1 = {
			...current,
			revision: nextRevision,
			source,
			modelConfiguration,
			environment,
			secrets,
			actions,
			actionSetRevision,
			channels,
			channelRevision,
		};
		const result: AgentConfigurationResultV1 = {
			schemaVersion: 1,
			agentId: command.agentId,
			revision: nextRevision,
			changedFields,
		};
		const plan: AgentConfigurationWritePlanV1 = {
			schemaVersion: 1,
			agentId: command.agentId,
			baseRevision: current.revision,
			nextRevision,
			expectedAuthorizationRevision: readDecision.record.authorizationRevision,
			nextAuthorizationRevision: authorization.authorizationRevision,
			configuration,
			accessUpdate,
			result,
			idempotency: {
				key: command.idempotencyKey,
				requestDigest: digest,
			},
			outboxIntent: {
				operation: "agent.configuration.revised.v1",
				payload: {
					schemaVersion: 1,
					agentId: command.agentId,
					baseRevision: current.revision,
					configurationRevision: nextRevision,
					changedFields,
				},
				traceId: command.traceId,
				requestId: command.requestId,
				occurredAt,
			},
			auditEvent: {
				action:
					accessUpdate !== null &&
					changedFields.every(
						(field) => field === "owners" || field === "availability",
					)
						? "agent.access.updated"
						: "agent.configuration.revised",
				actorId: actorContext.actorId,
				agentId: command.agentId,
				subjectType: "agent",
				subjectId: command.agentId,
				changedFields,
				traceId: command.traceId,
				requestId: command.requestId,
				occurredAt,
			},
		};
		let decision: Awaited<
			ReturnType<AgentConfigurationTransactionPortV1["commit"]>
		>;
		try {
			const capturedPlan = snapshotAgentConfigurationWritePlanV1(plan);
			decision = parseTransactionCommitDecision(
				await dependencies.transaction.commit(capturedPlan),
				command.agentId,
			);
		} catch {
			throw new AgentConfigurationError("persistence_failed");
		}
		if (decision.outcome === "stale") {
			throw new AgentConfigurationError("stale_revision");
		}
		if (decision.outcome === "idempotency_conflict") {
			throw new AgentConfigurationError("idempotency_conflict");
		}
		if (!sameValue(decision.result, plan.result)) {
			throw new AgentConfigurationError("persistence_failed");
		}
		return decision.result;
	};
	return {
		async update(commandInput, actorContextInput) {
			const command = parseCommand(commandInput);
			const actorContext = parseActorContext(actorContextInput);
			return await execute(
				command,
				actorContext,
				requestDigest(command, actorContext),
				() => command.changes,
			);
		},
		async upgradeCustomImage(commandInput, actorContextInput) {
			const command = parseUpgradeCustomImageCommand(commandInput);
			const actorContext = parseActorContext(actorContextInput);
			return await execute(
				command,
				actorContext,
				customImageUpgradeRequestDigest(command, actorContext),
				(current) => {
					if (current.source.kind !== "custom") {
						throw new AgentConfigurationError("not_admitted");
					}
					if (current.source.interactionMode === "self-managed") {
						const identityResponsibility =
							current.source.identityResponsibility;
						if (identityResponsibility === undefined) {
							throw new AgentConfigurationError("persistence_failed");
						}
						return {
							source: {
								kind: "custom",
								imageReference: command.imageReference,
								interactionMode: "self-managed",
								identityResponsibility,
							},
						};
					}
					return {
						source: {
							kind: "custom",
							imageReference: command.imageReference,
							interactionMode: "platform-adapter",
						},
					};
				},
			);
		},
	};
}
