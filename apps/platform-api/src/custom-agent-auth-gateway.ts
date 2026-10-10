import type { Hono } from "hono";
import { createPlatformEntryContextSignerV1 } from "./custom-agent-auth.js";
import { requestMetadata } from "./http/common.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity as resolvePlatformIdentity,
} from "./http/identity.js";

const untrustedIdentityHeaders = [
	"authorization",
	"cookie",
	"x-agent-id",
	"x-agent-infra-platform-context",
	"host",
	"forwarded",
	"origin",
	"x-forwarded-host",
	"x-forwarded-proto",
	"x-forwarded-port",
	"x-platform-identity",
	"x-user-id",
	"x-organization-id",
] as const;

/**
 * Forward one request to the selected custom Agent Service after current
 * platform identity and Agent scope checks. The Service origin is resolved
 * from trusted deployment state, never supplied by the browser request.
 */
export function createCustomAgentAuthGatewayV1(options: {
	readonly resolveIdentity: (request: Request) => Promise<IdentityContext>;
	readonly authorizeAgent: (input: {
		readonly identity: IdentityContext;
		readonly agentId: string;
	}) => Promise<boolean>;
	readonly resolveServiceOrigin: (agentId: string) => Promise<string>;
	readonly issuer: string;
	readonly keyVersion: string;
	readonly privateKey: Parameters<
		typeof createPlatformEntryContextSignerV1
	>[0]["privateKey"];
	readonly now?: () => number;
	readonly id?: () => string;
	readonly forward?: (request: Request) => Promise<Response>;
}) {
	const signContext = createPlatformEntryContextSignerV1(options);
	return async (input: {
		readonly request: Request;
		readonly agentId: string;
	}): Promise<Response> => {
		let identity: IdentityContext;
		let serviceOrigin: string;
		try {
			identity = await options.resolveIdentity(input.request);
			if (!(await options.authorizeAgent({ identity, agentId: input.agentId })))
				return new Response(null, { status: 403 });
			serviceOrigin = await options.resolveServiceOrigin(input.agentId);
		} catch {
			return new Response(null, { status: 503 });
		}
		let origin: URL;
		try {
			origin = new URL(serviceOrigin);
			if (
				origin.protocol !== "https:" ||
				origin.username ||
				origin.password ||
				origin.search ||
				origin.hash ||
				origin.pathname !== "/"
			)
				throw new Error();
		} catch {
			return new Response(null, { status: 503 });
		}
		const incoming = new URL(input.request.url);
		const target = new URL(`${incoming.pathname}${incoming.search}`, origin);
		const headers = new Headers(input.request.headers);
		for (const header of untrustedIdentityHeaders) headers.delete(header);
		headers.set(
			"x-agent-infra-platform-context",
			signContext({
				userId: identity.userId,
				organizationIds: identity.organizationIds,
				roles: identity.roles,
				authorizationRevision: identity.authorizationRevision,
				agentId: input.agentId,
			}).token,
		);
		try {
			const method = input.request.method.toUpperCase();
			const forwarded = new Request(target, {
				method,
				headers,
				body:
					method === "GET" || method === "HEAD"
						? undefined
						: await input.request.arrayBuffer(),
			});
			return await (options.forward ?? fetch)(forwarded);
		} catch {
			return new Response(null, { status: 503 });
		}
	};
}

/**
 * Adapt a public request to the Gateway using a deployment-owned route
 * binding. The request cannot choose an Agent id or Service origin.
 */
export function createCustomAgentAuthGatewayRouteAdapterV1(
	options: CustomAgentAuthGatewayRouteOptionsV1,
) {
	const resolveIdentity = (request: Request) =>
		resolvePlatformIdentity(
			options.identity,
			request,
			requestMetadata(request).traceId,
		);
	return async (request: Request): Promise<Response> => {
		let deployment: CustomAgentAuthDeploymentV1 | null;
		try {
			deployment = await options.resolveDeployment(request);
		} catch {
			return new Response(null, { status: 503 });
		}
		if (
			!deployment ||
			typeof deployment.agentId !== "string" ||
			deployment.agentId.length === 0 ||
			typeof deployment.serviceOrigin !== "string"
		)
			return new Response(null, { status: 503 });
		try {
			const gateway = createCustomAgentAuthGatewayV1({
				resolveIdentity,
				authorizeAgent: options.authorizeAgent,
				resolveServiceOrigin: async (agentId) => {
					if (agentId !== deployment.agentId) throw new Error();
					return deployment.serviceOrigin;
				},
				issuer: options.issuer,
				keyVersion: options.keyVersion,
				privateKey: options.privateKey,
				...(options.now ? { now: options.now } : {}),
				...(options.id ? { id: options.id } : {}),
				...(options.forward ? { forward: options.forward } : {}),
			});
			return await gateway({ request, agentId: deployment.agentId });
		} catch {
			return new Response(null, { status: 503 });
		}
	};
}

/** Register the resolver-backed Gateway as a Hono route. */
export function registerCustomAgentAuthGatewayRoutesV1(
	app: Hono,
	options: CustomAgentAuthGatewayRouteOptionsV1 & {
		readonly path: string;
	},
): void {
	const adapter = createCustomAgentAuthGatewayRouteAdapterV1(options);
	app.all(options.path, (context) => adapter(context.req.raw));
}

export interface CustomAgentAuthDeploymentV1 {
	/** Platform DB/workload state, never a browser supplied path or header. */
	readonly agentId: string;
	/** Canonical HTTPS public route origin resolved by deployment state. */
	readonly serviceOrigin: string;
}

export interface CustomAgentAuthGatewayRouteOptionsV1 {
	readonly identity: IdentityAdapter;
	readonly authorizeAgent: Parameters<
		typeof createCustomAgentAuthGatewayV1
	>[0]["authorizeAgent"];
	readonly resolveDeployment: (
		request: Request,
	) => Promise<CustomAgentAuthDeploymentV1 | null>;
	readonly issuer: string;
	readonly keyVersion: string;
	readonly privateKey: Parameters<
		typeof createPlatformEntryContextSignerV1
	>[0]["privateKey"];
	readonly now?: () => number;
	readonly id?: () => string;
	readonly forward?: (request: Request) => Promise<Response>;
}
