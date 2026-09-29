import { timingSafeEqual } from "node:crypto";
import { PostgresLdapSessionStoreV1 } from "@agent-infra/platform-store";
import {
	createLdapBrowserAdapter,
	type LdapBrowserInput,
} from "./ldap-browser.js";

/** Bind login routes and API identity to one directory and persistent session store. */
export function createPostgresLdapBrowserDeployment(
	input: Omit<LdapBrowserInput, "sessions"> & {
		databaseUrl: string;
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
		browserAuth: {
			handleRequest(request: Request) {
				if (!trustedProxy(request)) return new Response(null, { status: 400 });
				const incoming = new URL(request.url);
				// Local nginx owns this exact Host and scheme marker at TLS termination.
				// A mismatched or direct request keeps its URL for the adapter to reject.
				if (
					incoming.protocol === "http:" &&
					incoming.host === publicOrigin.host &&
					request.headers.get("host") === publicOrigin.host &&
					request.headers.get("x-forwarded-proto") === "https"
				) {
					incoming.protocol = "https:";
					return adapter.handleRequest(new Request(incoming, request));
				}
				return adapter.handleRequest(request);
			},
			close: () => sessions.close(),
		},
	};
}
