import {
	parseAdmittedModel,
	parseChannelDecision,
	parseImageDecision,
	parseModelDecision,
	parseSecretDecision,
} from "./agent-configuration-admission.js";
import { admitCurrentAuthorization } from "./agent-configuration-authorization.js";
import {
	parseActorContext,
	parseInitialCommand,
} from "./agent-configuration-input.js";
import { requireAdmittedConfigurationPolicy } from "./agent-configuration-record.js";
import {
	type AdmittedInitialAgentConfigurationV1,
	type AgentConfigurationActorContextV1,
	type AgentConfigurationAuthorizationAdmissionPortV1,
	type AgentConfigurationChannelAdmissionPortV1,
	AgentConfigurationError,
	type AgentConfigurationImageAdmissionPortV1,
	type AgentConfigurationModelAdmissionPortV1,
	type AgentConfigurationModelV1,
	type AgentConfigurationRecordV2,
	type AgentConfigurationSecretAdmissionPortV1,
	type InitialAgentConfigurationAdmissionDependenciesV1,
	type InitialAgentConfigurationAdmissionHandleV1,
	type InitialAgentConfigurationCommandV2,
} from "./agent-configuration-types.js";
import { compareText, sameValue } from "./agent-configuration-values.js";

function admittedInitialAccess(
	command: InitialAgentConfigurationCommandV2,
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
	const applicationIds = new Set(authority.applicationIds ?? []);
	if (
		!activeUserIds.has(actorContext.actorId) ||
		command.coOwnerIds.some((ownerId) => !activeUserIds.has(ownerId)) ||
		command.availability.some((target) =>
			target.kind === "user"
				? !activeUserIds.has(target.userId)
				: target.kind === "organization"
					? !organizationIds.has(target.organizationId)
					: !applicationIds.has(target.applicationId),
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
	command: InitialAgentConfigurationCommandV2,
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

	const configuration: AgentConfigurationRecordV2 = {
		schemaVersion: 2,
		agentId: command.agentId,
		revision: 1,
		source,
		modelConfiguration,
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
	commandInput: InitialAgentConfigurationCommandV2,
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
