import { createPlatformEntryContextSignerV1 } from "./custom-agent-auth.js";
import type { IdentityContext } from "./http/identity.js";

const untrustedIdentityHeaders = [
	"authorization",
	"cookie",
	"x-agent-id",
	"x-agent-infra-platform-context",
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
