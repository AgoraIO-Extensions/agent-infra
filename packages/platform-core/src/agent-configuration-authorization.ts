import { parseAuthorizationDecision } from "./agent-configuration-admission.js";
import { parseStandardTemplateReleaseTargetV1 } from "./agent-configuration-input.js";
import {
	type AgentConfigurationActorContextV1,
	type AgentConfigurationAuthorizationAdmissionPortV1,
	AgentConfigurationError,
	type StandardTemplateReleaseAuthorizationPortV1,
	type StandardTemplateReleaseAuthorizationV1,
	type StandardTemplateReleaseTargetV1,
	type UpdateAgentConfigurationCommandV2,
} from "./agent-configuration-types.js";
import {
	exactObject,
	idMaxBytes,
	isText,
	sameValue,
} from "./agent-configuration-values.js";

export const systemNow = () => new Date();

export async function admitCurrentAuthorization(
	admission: AgentConfigurationAuthorizationAdmissionPortV1,
	command: Pick<
		UpdateAgentConfigurationCommandV2,
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

export async function admitStandardTemplateRelease(
	admission: StandardTemplateReleaseAuthorizationPortV1 | undefined,
	target: StandardTemplateReleaseTargetV1,
	command: { readonly requestId: string; readonly traceId: string },
	actor: AgentConfigurationActorContextV1,
): Promise<StandardTemplateReleaseAuthorizationV1> {
	if (!admission) throw new AgentConfigurationError("not_authorized");
	let value: Record<string, unknown>;
	try {
		value = exactObject(
			await admission.authorize({
				schemaVersion: 1,
				intent: "standard_template.release_to_agent",
				target: structuredClone(target),
				actorId: actor.actorId,
				...command,
			}),
			["schemaVersion", "status"],
			[
				"intent",
				"target",
				"actorId",
				"accountStatus",
				"isAdministrator",
				"identityRevision",
				"deploymentRevision",
				"authorizationRevision",
			],
		);
	} catch {
		throw new AgentConfigurationError("dependency_unavailable");
	}
	if (
		value.status !== "admitted" ||
		value.schemaVersion !== 1 ||
		value.intent !== "standard_template.release_to_agent" ||
		value.actorId !== actor.actorId ||
		value.accountStatus !== "active" ||
		value.isAdministrator !== true ||
		!isText(value.identityRevision, idMaxBytes) ||
		!isText(value.deploymentRevision, idMaxBytes) ||
		!isText(value.authorizationRevision, idMaxBytes)
	)
		throw new AgentConfigurationError("not_authorized");
	let bound: StandardTemplateReleaseTargetV1;
	try {
		bound = parseStandardTemplateReleaseTargetV1(value.target);
	} catch {
		throw new AgentConfigurationError("not_authorized");
	}
	if (!sameValue(target, bound))
		throw new AgentConfigurationError("not_authorized");
	return {
		schemaVersion: 1,
		status: "admitted",
		intent: "standard_template.release_to_agent",
		target: bound,
		actorId: actor.actorId,
		accountStatus: "active",
		isAdministrator: true,
		identityRevision: value.identityRevision,
		deploymentRevision: value.deploymentRevision,
		authorizationRevision: value.authorizationRevision,
	};
}
