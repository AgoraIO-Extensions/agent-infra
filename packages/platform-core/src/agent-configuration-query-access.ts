import type { AgentConfigurationAccessTargetV1 } from "./agent-configuration-types.js";
import { isAgentManagementText } from "./agent-management-input.js";
import type { ApiPrincipalV1 } from "./api-identity.js";

/** Decide configuration visibility from one current Store snapshot. */
export function isAgentConfigurationQueryAllowedV1(input: {
	readonly actorId: string;
	readonly organizationIds: readonly string[];
	readonly isAdministrator: boolean;
	readonly principal?: ApiPrincipalV1;
	readonly intent: "discover" | "manage";
	readonly authorizationRevision: string | null;
	readonly ownerIds: readonly string[];
	readonly availability: readonly AgentConfigurationAccessTargetV1[];
	readonly principalGrants: readonly {
		readonly principalType: string;
		readonly principalId: string;
		readonly grantType: string;
		readonly authorizationRevision: string;
		readonly revokedAt: Date | null;
	}[];
}): boolean {
	if (input.principal) {
		if (input.principal.kind === "user" && input.principal.id !== input.actorId)
			return false;
		return (
			isAgentManagementText(input.authorizationRevision) &&
			input.principalGrants.some(
				(grant) =>
					grant.principalType === input.principal?.kind &&
					isAgentManagementText(grant.principalId) &&
					grant.principalId === input.principal?.id &&
					grant.authorizationRevision === input.authorizationRevision &&
					grant.revokedAt === null &&
					(input.intent === "manage"
						? grant.grantType === "manage"
						: grant.grantType === "manage" || grant.grantType === "use"),
			)
		);
	}
	return (
		input.isAdministrator ||
		input.ownerIds.includes(input.actorId) ||
		(input.intent === "discover" &&
			input.availability.some((target) =>
				target.kind === "user"
					? target.userId === input.actorId
					: target.kind === "organization" &&
						input.organizationIds.includes(target.organizationId),
			))
	);
}
