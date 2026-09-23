import {
	canonicalChannelBindings,
	parseAdmittedSource,
} from "./agent-configuration-input.js";
import {
	parseStoredModel,
	parseStoredSecrets,
} from "./agent-configuration-record.js";
import type {
	AgentConfigurationAccessAuthorityV1,
	AgentConfigurationAuthorityContextV1,
	AgentConfigurationAuthorizationAdmissionPortV1,
	AgentConfigurationChannelAdmissionPortV1,
	AgentConfigurationImageAdmissionPortV1,
	AgentConfigurationModelAdmissionPortV1,
	AgentConfigurationModelInputV1,
	AgentConfigurationModelV1,
	AgentConfigurationSecretAdmissionPortV1,
	AgentConfigurationSourceV1,
} from "./agent-configuration-types.js";
import {
	denseArray,
	dependencyValue,
	exactObject,
	idMaxBytes,
	invalidCommand,
	isText,
	maxAccessTargets,
	sameValue,
} from "./agent-configuration-values.js";
import {
	parseAgentManagementActorContext,
	parseAgentManagementPortState,
	parseAgentManagementStringArray,
	requireAgentManagementExactKeys,
} from "./agent-management-input.js";

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

export function parseAuthorizationDecision(
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

export function parseImageDecision(
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

export function parseModelDecision(
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

export function parseSecretDecision(
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

export function parseChannelDecision(
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

export function parseAdmittedModel(
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

export function sameSourceConfiguration(
	left: AgentConfigurationSourceV1,
	right: AgentConfigurationSourceV1,
): boolean {
	return sameValue(
		{ ...left, admissionRevision: undefined },
		{ ...right, admissionRevision: undefined },
	);
}

export function sameModelConfiguration(
	left: AgentConfigurationModelV1 | null,
	right: AgentConfigurationModelV1 | null,
): boolean {
	return sameValue(
		left && { ...left, catalogRevision: undefined },
		right && { ...right, catalogRevision: undefined },
	);
}
