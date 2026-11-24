import {
	type TemplatePublicationCommitV1,
	TemplatePublicationCommitV1Schema,
} from "@agent-infra/contracts/pilot";
import { parseStandardTemplateReleaseTargetV1 } from "./agent-configuration-input.js";
import {
	type AgentConfigurationActorContextV1,
	AgentConfigurationError,
	type StandardTemplateReleaseTargetV1,
} from "./agent-configuration-types.js";
import {
	exactObject,
	isText,
	sameValue,
} from "./agent-configuration-values.js";

export type AutomaticTemplatePublicationCommitV1 = TemplatePublicationCommitV1;
export const parseAutomaticTemplatePublicationCommitV1 = (
	input: unknown,
): TemplatePublicationCommitV1 =>
	TemplatePublicationCommitV1Schema.parse(input);
export interface AutomaticTemplatePublicationAuthorizationV1 {
	readonly schemaVersion: 1;
	readonly status: "admitted";
	readonly intent: "standard_template.auto_publish";
	readonly target: StandardTemplateReleaseTargetV1;
	readonly actorId: string;
	readonly identityRevision: string;
	readonly deploymentRevision: string;
	readonly authorizationRevision: string;
	readonly publication: AutomaticTemplatePublicationCommitV1;
}
export interface AutomaticTemplatePublicationAuthorizationPortV1 {
	authorize(input: {
		readonly schemaVersion: 1;
		readonly intent: "standard_template.auto_publish";
		readonly target: StandardTemplateReleaseTargetV1;
		readonly actorId: string;
		readonly requestId: string;
		readonly traceId: string;
	}): Promise<
		| AutomaticTemplatePublicationAuthorizationV1
		| { readonly schemaVersion: 1; readonly status: "rejected" }
	>;
}

export async function admitAutomaticTemplatePublicationV1(
	port: AutomaticTemplatePublicationAuthorizationPortV1,
	target: StandardTemplateReleaseTargetV1,
	command: { requestId: string; traceId: string },
	actor: AgentConfigurationActorContextV1,
): Promise<AutomaticTemplatePublicationAuthorizationV1> {
	try {
		const raw = await port.authorize({
			schemaVersion: 1,
			intent: "standard_template.auto_publish",
			target: structuredClone(target),
			actorId: actor.actorId,
			...command,
		});
		if (raw.status !== "admitted") throw new Error();
		const value = exactObject(raw, [
			"schemaVersion",
			"status",
			"intent",
			"target",
			"actorId",
			"identityRevision",
			"deploymentRevision",
			"authorizationRevision",
			"publication",
		]);
		const publication = parseAutomaticTemplatePublicationCommitV1(
			value.publication,
		);
		if (
			value.schemaVersion !== 1 ||
			value.intent !== "standard_template.auto_publish" ||
			value.actorId !== actor.actorId ||
			publication.servicePrincipalRef !== actor.actorId ||
			publication.publicationId !== target.releaseId ||
			!isText(value.identityRevision, 1024) ||
			!isText(value.deploymentRevision, 1024) ||
			!isText(value.authorizationRevision, 1024) ||
			!sameValue(parseStandardTemplateReleaseTargetV1(value.target), target)
		)
			throw new Error();
		return {
			schemaVersion: 1,
			status: "admitted",
			intent: "standard_template.auto_publish",
			target: structuredClone(target),
			actorId: actor.actorId,
			identityRevision: value.identityRevision,
			deploymentRevision: value.deploymentRevision,
			authorizationRevision: value.authorizationRevision,
			publication,
		};
	} catch {
		throw new AgentConfigurationError("not_authorized");
	}
}
