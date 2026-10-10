import { readFile } from "node:fs/promises";
import { createLdapIdentityDirectory } from "@agent-infra/identity";
import { PostgresPlatformUserDisablesV1 } from "@agent-infra/platform-store";
import { createProtectedConnectionInstallationForwarder } from "./connection-installation-callback-forwarder.js";
import {
	createDirectoryOrganizationAuthorityResolverV1,
	createDirectoryOrganizationIdsResolverV1,
} from "./directory-authority.js";
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
	organizationIds: configuredOrganizationIds,
	directorySnapshot,
	publicOrigin,
	connectionConsumerProfile,
	connectionConsumerProfileApproval,
	connectionInstallationConfiguration,
	connectionInstallationCallback,
	apiInput,
	directorySearch,
} = await import(configurationModule);
const databaseUrl = process.env.PLATFORM_DATABASE_URL;
if (!databaseUrl) throw new Error("PLATFORM_DATABASE_URL is required");
if (typeof ldap?.verifyCurrentStatus !== "function") {
	throw new Error("LDAP current account authority is required");
}
if (typeof directorySearch !== "function") {
	throw new Error("Directory search authority is required");
}
let organizationIds = configuredOrganizationIds;
let organizationAuthority:
	| ReturnType<typeof createDirectoryOrganizationAuthorityResolverV1>
	| undefined;
if (directorySnapshot !== undefined) {
	organizationAuthority =
		createDirectoryOrganizationAuthorityResolverV1(directorySnapshot);
	organizationIds = createDirectoryOrganizationIdsResolverV1(directorySnapshot);
}
if (typeof organizationIds !== "function") {
	throw new Error("Directory organization authority is required");
}
const tokenFile = process.env.PLATFORM_API_PROXY_TOKEN_FILE;
if (!tokenFile?.startsWith("/")) {
	throw new Error("PLATFORM_API_PROXY_TOKEN_FILE must be an absolute path");
}
const trustedProxyToken = await readFile(tokenFile, "utf8");
const directory = createLdapIdentityDirectory(ldap);
const userGovernance = new PostgresPlatformUserDisablesV1(
	databaseUrl,
	async (userId) => {
		const account = await directory.currentByUserId(userId);
		return account
			? {
					userId: account.userId,
					accountStatus: account.accountStatus,
					isSystemAdmin: account.roles.includes("system_admin"),
				}
			: null;
	},
);
const browser = createPostgresLdapBrowserDeployment({
	databaseUrl,
	directory,
	isPlatformDisabled: userGovernance.isPlatformDisabled.bind(userGovernance),
	organizationIds,
	...(organizationAuthority ? { organizationAuthority } : {}),
	publicOrigin,
	trustedProxyToken,
});
const callbackForwarder =
	connectionInstallationCallback ??
	(connectionInstallationConfiguration &&
	process.env.PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE
		? {
				forward: createProtectedConnectionInstallationForwarder({
					authFile: process.env.PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE,
				}),
			}
		: undefined);

export const browserAuth = browser.browserAuth;
export function createPlatformApiAssemblyInput() {
	return createProductionPlatformApiAssemblyInputV1({
		...apiInput,
		userGovernance,
		directory: { identity: browser.identity, search: directorySearch },
		connectionConsumerProfile,
		connectionConsumerProfileApproval,
		...(connectionInstallationConfiguration
			? {
					connectionInstallation: {
						configuration: connectionInstallationConfiguration,
						publicOrigin,
					},
				}
			: {}),
		...(callbackForwarder
			? { connectionInstallationCallback: callbackForwarder }
			: {}),
		databaseUrl,
		identity: browser.identity,
	});
}
