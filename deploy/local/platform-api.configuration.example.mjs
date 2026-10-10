// Copy this file outside the repository as configuration.mjs and replace every
// placeholder with a reviewed deployment-owned implementation. Do not put
// passwords, private keys, Kubernetes credentials or model credentials here.

import { requiredEnv } from "./environment.mjs";

const missing = (name) => {
	throw new Error(`Configure deployment export: ${name}`);
};

// TLS is enabled by default (ldaps://); set tls: false for ldap://.
// identityIds: new PostgresLdapIdentityIds(PLATFORM_DATABASE_URL) from
// @agent-infra/platform-store. Supply a deployment-owned
// verifyCurrentStatus function. A dedicated activeAttribute is not required.
export const ldap = missing("ldap");

// These functions must query current, trusted deployment facts. They must throw
// on dependency failure rather than returning a permissive default.
export const isPlatformDisabled = missing("isPlatformDisabled");
export const organizationIds = missing("organizationIds");
export const publicOrigin = requiredEnv("PLATFORM_PUBLIC_ORIGIN");

// apiInput is the credential-free Platform admission boundary. Keep Worker
// private keys and raw model credentials out of this API-only module.
// To enable the file boundary, set apiInput.files to a deployment-owned
// PlatformFileDeploymentV1 using createS3ObjectStorageV1. Keep S3 credentials
// in the deployment adapter; never expose them through API contracts or Web.
// apiInput.taskAdmissionPolicy is required: maximumWaitingTasksPerAgent (tasks)
// and waitingTimeoutMs (milliseconds) must both be positive safe integers.
// Supply reviewed deployment values explicitly; fixture values are not defaults.
export const apiInput = missing("apiInput");

// Search must resolve current, canonical directory records for the Web
// application pickers. It must throw on dependency failure.
export const directorySearch = missing("directorySearch");
