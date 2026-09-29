import { PostgresLdapSessionStoreV1 } from "@agent-infra/platform-store";
import {
	createLdapBrowserAdapter,
	type LdapBrowserInput,
} from "./ldap-browser.js";

/** Bind login routes and API identity to one directory and persistent session store. */
export function createPostgresLdapBrowserDeployment(
	input: Omit<LdapBrowserInput, "sessions"> & { databaseUrl: string },
) {
	const sessions = new PostgresLdapSessionStoreV1(input.databaseUrl);
	const adapter = createLdapBrowserAdapter({ ...input, sessions });
	const publicOrigin = new URL(input.publicOrigin);
	return {
		identity: adapter.identityAdapter,
		browserAuth: {
			handleRequest(request: Request) {
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
