import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
	type IdentityAdapter,
	resolveApiIdentity,
	resolveIdentity,
} from "./http/identity.js";
import type { ManagementRouteDependencies } from "./http/management-routes.js";

/** Bind admission to the authenticated HTTP request across concurrent awaits. */
export function createDeploymentIdentityScope(identity: IdentityAdapter) {
	const requests = new AsyncLocalStorage<Request>();
	return {
		currentRequest(): Request {
			const request = requests.getStore();
			if (!request)
				throw new Error("Authenticated request scope is unavailable");
			return request;
		},
		requestScope(request: Request, work: () => Promise<void>): Promise<void> {
			return requests.run(request, work);
		},
		async currentIdentity(traceId: string) {
			const request = requests.getStore();
			if (!request)
				throw new Error("Authenticated request scope is unavailable");
			// Resolve again at admission: a previous session lookup is not authority.
			if (
				/^Bearer\s+[^\s]+$/.test(request.headers.get("authorization") ?? "")
			) {
				const api = await resolveApiIdentity(identity, request, traceId);
				return {
					schemaVersion: 1 as const,
					userId: api.ownerId,
					displayName: api.principal.id,
					accountStatus: "active" as const,
					organizationIds: api.organizationIds,
					roles: [] as const,
					authorizationRevision: api.authorizationRevision,
					principal: api.principal,
				};
			}
			return resolveIdentity(identity, request, traceId);
		},
	};
}

export function allocateDeploymentDirectApplicationIds(
	principalKind: "user" | "application",
	principalId: string,
	idempotencyKey: string,
): { readonly applicationId: string; readonly agentId: string } {
	const digest = createHash("sha256")
		.update(`${principalKind}\0${principalId}\0${idempotencyKey}`, "utf8")
		.digest("hex")
		.slice(0, 32);
	return {
		applicationId: `application_api_${digest}`,
		agentId: `agent_api_${digest}`,
	};
}

/** IDs must survive retries before the first transaction, including a restart. */
export const allocateDeploymentApplicationIds: ManagementRouteDependencies["allocateApplicationIds"] =
	async ({ identity, idempotencyKey }) => {
		const digest = createHash("sha256")
			.update(
				JSON.stringify([
					"platform-web-application.v2",
					identity.userId,
					idempotencyKey,
				]),
			)
			.digest("hex");
		return {
			applicationId: `application_${digest}`,
			agentId: `agent_${digest}`,
		};
	};
