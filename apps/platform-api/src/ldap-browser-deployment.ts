import { timingSafeEqual } from "node:crypto";
import {
	OidcBindingError,
	PostgresLdapSessionStoreV1,
	type PostgresOidcIdentityStore,
} from "@agent-infra/platform-store";
import {
	createLdapBrowserAdapter,
	type LdapBrowserInput,
} from "./ldap-browser.js";
import {
	createOidcBrowserFlow,
	type OidcBrowserIdentity,
} from "./oidc-browser-flow.js";

/** Bind login routes and API identity to one directory and persistent session store. */
export function createPostgresLdapBrowserDeployment(
	input: Omit<LdapBrowserInput, "sessions"> & {
		databaseUrl: string;
		oidc?: {
			issuer: string;
			clientId: string;
			clientSecret: string;
			store: PostgresOidcIdentityStore;
			verifiedAccount: (
				identity: OidcBrowserIdentity,
			) => Promise<import("@agent-infra/identity").LdapAccount | null>;
		};
		/** Shared only by the trusted TLS proxy and API deployment. */
		trustedProxyToken: string;
	},
) {
	if (
		typeof input.trustedProxyToken !== "string" ||
		!/^[A-Za-z0-9_-]{43,128}$/u.test(input.trustedProxyToken)
	)
		throw new Error("LDAP_BROWSER_PROXY_CONFIGURATION_INVALID");
	const sessions = new PostgresLdapSessionStoreV1(input.databaseUrl);
	const adapter = createLdapBrowserAdapter({ ...input, sessions });
	const oidc = input.oidc;
	const flow =
		oidc &&
		createOidcBrowserFlow({
			...oidc,
			publicOrigin: input.publicOrigin,
			transactions: oidc.store,
			login: async (identity) => {
				try {
					const account = await oidc.verifiedAccount(identity);
					return account
						? adapter.issueSession(account)
						: new Response(null, { status: 401 });
				} catch (error) {
					if (error instanceof OidcBindingError)
						return new Response(null, { status: 401 });
					throw error;
				}
			},
		});
	async function handle(request: Request) {
		if (flow) {
			const path = new URL(request.url).pathname;
			if (path === "/auth/login") return new Response(null, { status: 404 });
			const result = await flow.handleRequest(request);
			if (result) return result;
		}
		return adapter.handleRequest(request);
	}
	const publicOrigin = new URL(input.publicOrigin);
	const proxyToken = Buffer.from(input.trustedProxyToken);
	const trustedProxy = (request: Request) => {
		const supplied = Buffer.from(
			request.headers.get("x-platform-proxy-token") ?? "",
		);
		return (
			supplied.length === proxyToken.length &&
			timingSafeEqual(supplied, proxyToken)
		);
	};
	return {
		identity: adapter.identityAdapter,
		/**
		 * 文件交换 Actor 与浏览器会话共享同一当前身份映射（#3060），
		 * 不再由部署入口另行拼装 LDAP 授权输入。
		 */
		resolveCurrentIdentity: adapter.resolveCurrentIdentity,
		browserAuth: {
			handleRequest(request: Request) {
				if (!trustedProxy(request)) return new Response(null, { status: 400 });
				const incoming = new URL(request.url);
				// Local nginx owns this exact Host and scheme marker at TLS termination.
				// Rebuild the public URL from verified proxy headers because the Node
				// adapter may construct request.url from the upstream service host.
				if (
					request.headers.get("host") === publicOrigin.host &&
					request.headers.get("x-forwarded-proto") === "https"
				) {
					if (
						request.method !== "POST" &&
						!(
							flow &&
							incoming.pathname.startsWith("/auth/oidc/") &&
							request.method === "GET"
						)
					)
						return new Response(null, { status: 405 });
					const publicUrl = new URL(publicOrigin.origin);
					publicUrl.pathname = incoming.pathname;
					publicUrl.search = incoming.search;
					return handle(new Request(publicUrl, request.clone()));
				}
				return handle(request);
			},
			close: async () => {
				await Promise.all([sessions.close(), oidc?.store.close()]);
			},
		},
	};
}
