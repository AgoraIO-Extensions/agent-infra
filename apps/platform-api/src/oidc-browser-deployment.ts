import {
	OidcBindingError,
	PostgresLdapSessionStoreV1 as PostgresBrowserSessionStoreV1,
	type PostgresOidcIdentityStore,
} from "@agent-infra/platform-store";
import {
	type BrowserSessionInput,
	createBrowserSessionAdapter,
} from "./browser-session.js";
import {
	createOidcBrowserFlow,
	type OidcBrowserIdentity,
} from "./oidc-browser-flow.js";
import { createTrustedProxyVerifier } from "./trusted-proxy.js";

/** Bind login routes and API identity to one directory and persistent session store. */
export function createPostgresOidcBrowserDeployment(
	input: Omit<BrowserSessionInput, "sessions"> & {
		databaseUrl: string;
		oidc: {
			issuer: string;
			clientId: string;
			clientSecret: string;
			store: PostgresOidcIdentityStore;
			verifiedAccount: (
				identity: OidcBrowserIdentity,
			) => Promise<import("@agent-infra/identity").EmployeeAccount | null>;
		};
		/** Shared only by the trusted TLS proxy and API deployment. */
		trustedProxyToken: string;
	},
) {
	const trustedProxy = createTrustedProxyVerifier(input.trustedProxyToken);
	const sessions = new PostgresBrowserSessionStoreV1(input.databaseUrl);
	const adapter = createBrowserSessionAdapter({ ...input, sessions });
	const oidc = input.oidc;
	const flow = createOidcBrowserFlow({
		...oidc,
		publicOrigin: input.publicOrigin,
		transactions: oidc.store,
		logout: (notice) => oidc.store.logout(notice),
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
		return (
			(await flow.handleRequest(request)) ?? adapter.handleRequest(request)
		);
	}
	const publicOrigin = new URL(input.publicOrigin);
	return {
		identity: adapter.identityAdapter,
		/**
		 * 文件交换 Actor 与浏览器会话共享同一当前身份映射（#3060），
		 * 不再由部署入口另行拼装 身份授权输入。
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
							incoming.pathname.startsWith("/auth/oidc/") &&
							request.method === "GET"
						)
					)
						return new Response(null, { status: 405 });
					const publicUrl = new URL(publicOrigin.origin);
					publicUrl.pathname = incoming.pathname;
					publicUrl.search = incoming.search;
					return handle(new Request(publicUrl, request));
				}
				return handle(request);
			},
			close: async () => {
				await Promise.all([sessions.close(), oidc.store.close()]);
			},
		},
	};
}
