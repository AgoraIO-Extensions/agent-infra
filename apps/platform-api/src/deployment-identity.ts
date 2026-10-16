import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./http/identity.js";
import type { ManagementRouteDependencies } from "./http/management-routes.js";

interface RequestScope {
	readonly request: Request;
	/** 只读展示用的身份，同一个请求内只解析一次（#2632）。 */
	presentationIdentity?: Promise<IdentityContext>;
}

/** Bind admission to the authenticated HTTP request across concurrent awaits. */
export function createDeploymentIdentityScope(identity: IdentityAdapter) {
	const requests = new AsyncLocalStorage<RequestScope>();
	const currentScope = () => {
		const scope = requests.getStore();
		if (!scope) throw new Error("Authenticated request scope is unavailable");
		return scope;
	};
	return {
		currentRequest(): Request {
			return currentScope().request;
		},
		requestScope<T>(request: Request, work: () => Promise<T>): Promise<T> {
			return requests.run({ request }, work);
		},
		async currentIdentity(traceId: string) {
			const { request } = currentScope();
			// Resolve again at admission: a previous session lookup is not authority.
			return resolveIdentity(identity, request, traceId);
		},
		/**
		 * 只读展示用的请求身份：同一个 HTTP 请求内只解析一次，之后复用；跨请求从不复用。
		 * 列表接口要展示每一个 Agent，之前每一项都完整重新解析一次请求身份（会话、LDAP 状态、
		 * 禁用、目录组织），一次列表就是上百次目录快照下载，并发时排队超时变成 503（#2632）。
		 * 准入仍然使用 currentIdentity，每次重新解析。失败的解析只在本请求内共享。
		 */
		async requestIdentity(traceId: string): Promise<IdentityContext> {
			const scope = currentScope();
			scope.presentationIdentity ??= resolveIdentity(
				identity,
				scope.request,
				traceId,
			);
			return scope.presentationIdentity;
		},
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
