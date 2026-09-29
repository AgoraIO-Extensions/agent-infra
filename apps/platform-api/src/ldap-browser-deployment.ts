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
	return {
		identity: adapter.identityAdapter,
		browserAuth: {
			handleRequest: adapter.handleRequest,
			close: () => sessions.close(),
		},
	};
}
