import { randomUUID } from "node:crypto";
import type { PersonalApiAgentReadUseCaseV1 } from "@agent-infra/platform-core";
import type {
	WorkspaceSnapshotCredentialResolverV1,
	WorkspaceSnapshotPrincipalV1,
} from "./workspace-snapshot-service.js";

/**
 * Reuses the existing personal API credential read authority. Application
 * credentials intentionally remain unresolved until their independent
 * principal/current-status adapter is supplied.
 */
export function createWorkspaceSnapshotCredentialResolverV1(input: {
	readonly personalApiAgentRead: PersonalApiAgentReadUseCaseV1;
}): WorkspaceSnapshotCredentialResolverV1 {
	return {
		async resolve(
			material: string,
		): Promise<WorkspaceSnapshotPrincipalV1 | null> {
			try {
				const identity = await input.personalApiAgentRead.readIdentity(
					{ requestId: randomUUID(), traceId: randomUUID() },
					material,
				);
				if (identity.principal.kind !== "user") return null;
				return {
					kind: "user",
					id: identity.principal.id,
					scopes: identity.scopes,
				};
			} catch {
				return null;
			}
		},
	};
}
