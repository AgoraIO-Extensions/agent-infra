import { readFile } from "node:fs/promises";
import { createLdapIdentityDirectory } from "@agent-infra/identity";
import {
	createPostgresLdapBrowserDeployment,
	createProductionPlatformApiAssemblyInputV1,
} from "./index.js";

// The mounted module supplies current directory, policy, Registry and catalog facts.
// Credentials remain in API-only files; the proxy token is a separate Compose Secret.
const configurationModule = process.env.PLATFORM_API_CONFIGURATION_MODULE;
if (!configurationModule || new URL(configurationModule).protocol !== "file:") {
	throw new Error("PLATFORM_API_CONFIGURATION_MODULE must be a file URL");
}
const {
	ldap,
	isPlatformDisabled,
	organizationIds,
	publicOrigin,
	connectionConsumerProfile,
	connectionConsumerProfileApproval,
	apiInput,
} = await import(configurationModule);
const databaseUrl = process.env.PLATFORM_DATABASE_URL;
if (!databaseUrl) throw new Error("PLATFORM_DATABASE_URL is required");
if (typeof ldap?.verifyCurrentStatus !== "function") {
	throw new Error("LDAP current account authority is required");
}
const tokenFile = process.env.PLATFORM_API_PROXY_TOKEN_FILE;
if (!tokenFile?.startsWith("/")) {
	throw new Error("PLATFORM_API_PROXY_TOKEN_FILE must be an absolute path");
}
const trustedProxyToken = await readFile(tokenFile, "utf8");
const directory = createLdapIdentityDirectory(ldap);
const browser = createPostgresLdapBrowserDeployment({
	databaseUrl,
	directory,
	isPlatformDisabled,
	organizationIds,
	publicOrigin,
	trustedProxyToken,
});

export const browserAuth = browser.browserAuth;
export function createPlatformApiAssemblyInput() {
	return createProductionPlatformApiAssemblyInputV1({
		...apiInput,
		connectionConsumerProfile,
		connectionConsumerProfileApproval,
		databaseUrl,
		identity: browser.identity,
	});
}
