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

export interface AutomaticTemplatePublicationCommitV1 {
	readonly schemaVersion: 1; readonly publicationId: string; readonly authorizationRevision: string; readonly batchRef: string; readonly targetRef: string; readonly servicePrincipalRef: string; readonly approvedBy: string;
	readonly lease: { readonly schemaVersion: 1; readonly itemId: string; readonly leaseOwner: string; readonly deliveryFence: string };
}
export function parseAutomaticTemplatePublicationCommitV1(input: unknown): AutomaticTemplatePublicationCommitV1 {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
	const v = input as Record<string, unknown>; const lease = v.lease;
	if(v.schemaVersion!==1 || typeof v.publicationId!=="string" || typeof v.authorizationRevision!=="string" || typeof v.batchRef!=="string" || typeof v.targetRef!=="string" || typeof v.servicePrincipalRef!=="string" || typeof v.approvedBy!=="string" || !lease || typeof lease!=="object" || Array.isArray(lease)) throw new Error();
	const l=lease as Record<string,unknown>; if(l.schemaVersion!==1 || typeof l.itemId!=="string" || typeof l.leaseOwner!=="string" || typeof l.deliveryFence!=="string" || !/^[1-9][0-9]{0,18}$/.test(l.deliveryFence)) throw new Error();
	return {schemaVersion:1,publicationId:v.publicationId,authorizationRevision:v.authorizationRevision,batchRef:v.batchRef,targetRef:v.targetRef,servicePrincipalRef:v.servicePrincipalRef,approvedBy:v.approvedBy,lease:{schemaVersion:1,itemId:l.itemId,leaseOwner:l.leaseOwner,deliveryFence:l.deliveryFence}};
}
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
		const publication = parseAutomaticTemplatePublicationCommitV1(value.publication);
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
