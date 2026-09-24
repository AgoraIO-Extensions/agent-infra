import { assertGrantUsable } from "./grants.js";
import type { GrantRecord } from "./types.js";
import { consumerActorSentinel } from "./types.js";

/** Raw current rows read by Store; Core owns the eligibility decision. */
export interface CurrentAuthorityState {
	principalStatus: string;
	principalGeneration: number;
	consumerStatus: string;
	consumerActorRequired: boolean;
	instanceStatus: string;
	instancePrincipalId: string;
	instanceConsumerId: string;
	instanceGeneration: number;
	actorStatus: string | null;
	actorInstanceId: string | null;
	connectionStatus: string;
	connectionProviderId: string;
	currentCredentialVersionId: string | null;
	credentialStatus: string;
	credentialConnectionId: string;
	actionStatus: string;
	actionProviderId: string;
	actionEffect: string;
	providerStatus: string;
	releaseStatus: string;
}

export interface CurrentAuthorityContext {
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string | null;
	actionVersionId: string;
	principalRecoveryGeneration: number;
	expectedGrantRevision?: number;
	expectedEffectPresent?: boolean;
	now?: number;
}

export function isCurrentAuthority(
	grant: GrantRecord,
	state: CurrentAuthorityState,
	context: CurrentAuthorityContext,
): boolean {
	try {
		assertGrantUsable(grant, {
			...context,
			connectionId: grant.connectionId,
			credentialVersionId: grant.credentialVersionId,
		});
	} catch {
		return false;
	}
	const actorId = context.actorId ?? consumerActorSentinel;
	return (
		(context.expectedGrantRevision === undefined ||
			grant.revision === context.expectedGrantRevision) &&
		state.principalStatus === "active" &&
		state.principalGeneration === context.principalRecoveryGeneration &&
		state.consumerStatus === "active" &&
		state.consumerActorRequired === (actorId !== consumerActorSentinel) &&
		state.instanceStatus === "active" &&
		state.instancePrincipalId === context.principalId &&
		state.instanceConsumerId === context.consumerId &&
		state.instanceGeneration === context.principalRecoveryGeneration &&
		(actorId === consumerActorSentinel ||
			(state.actorStatus === "active" &&
				state.actorInstanceId === context.consumerInstanceId)) &&
		state.connectionStatus === "active" &&
		state.currentCredentialVersionId === grant.credentialVersionId &&
		state.credentialStatus === "active" &&
		state.credentialConnectionId === grant.connectionId &&
		state.actionStatus === "published" &&
		state.actionProviderId === state.connectionProviderId &&
		state.providerStatus === "active" &&
		state.releaseStatus === "active" &&
		(context.expectedEffectPresent === undefined ||
			(state.actionEffect === "write") === context.expectedEffectPresent)
	);
}
