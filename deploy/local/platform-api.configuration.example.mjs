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
// Optional generic #1341/#1683 consumer. When supplied, this takes precedence
// over organizationIds and must map every matched snapshot department to a
// reviewed Platform organization ID. The endpoint/token are deployment-owned.
export const directorySnapshot = undefined;
export const publicOrigin = requiredEnv("PLATFORM_PUBLIC_ORIGIN");

// apiInput is the credential-free Platform admission boundary. Keep Worker
// private keys and raw model credentials out of this API-only module.
// To enable the file boundary, set apiInput.files to a deployment-owned
// PlatformFileDeploymentV1 using createS3ObjectStorageV1. Keep S3 credentials
// in the deployment adapter; never expose them through API contracts or Web.
// apiInput.taskAdmissionPolicy is required: maximumWaitingTasksPerAgent (tasks)
// and waitingTimeoutMs (milliseconds) must both be positive safe integers.
// Supply reviewed deployment values explicitly; fixture values are not defaults.
// Every apiInput.templates entry whose modelBinding.driver is "codex" must also
// set codexModelProfiles to the pinned Codex model/list of that exact image:
//   codexModelProfiles: [{ model: "<model>", reasoningLevels: ["medium", "high"] }]
// Generate it offline with deploy/runtime/codex-model-profiles.mjs; see
// deploy/platform-api/README.md. Missing profiles stop the API at startup.
export const apiInput = missing("apiInput");

// Optional explicit production ports. The entrypoint merges these into
// apiInput and rejects duplicate definitions. Gateway and model-directory
// implementations remain deployment-owned; do not use fixtures here.
export const customAgentGateway = undefined;
export const modelSelection = undefined;
// Optional deployment-owned native metadata reader. Supply the existing
// reader object only after its API/Worker/Host proof and Session routing are configured.
export const nativeMetadata = undefined;

// Optional controlled Skill Hub Provider import. This is a deployment-owned
// registry + admission pipeline; it must return candidates from approved
// providers and use the same ObjectStorage, source verifier, scanner and
// admission policy that Platform uses for publication. HTTP callers can only
// select an approved provider/name/version; they cannot submit bytes, paths,
// trust, policy or approval facts.
export const providerImport = undefined;

// Robot-token Agent management API (optional):
//
// apiInput.agentApiCreation = {
//   // Application principals authenticated by Platform API credentials. One
//   // application principal may call the API for multiple Agents.
//   allowedPrincipals: [{ kind: "application", id: "<application-id>" }],
//   // Deployment-owned adapter that validates the requested default Relay Key
//   // against the same endpoint/model policy used by the deployment. Platform
//   // encrypts an accepted key with the public wrapping keys above.
//   candidates: async (key, configuration) => /* reviewed adapter */ [],
//   // Optional deployment-owned model admission for keyless configuration.
//   keylessModelAdmission: { admitModels: async (request) => /* decision */ },
// };
//
// The assignment above is illustrative: export the reviewed object through
// the deployment's apiInput. Do not put application tokens, Relay Keys or
// private deployment material in this repository. Omit agentApiCreation (or
// keep allowedPrincipals empty) to keep direct Agent creation fail-closed.

// Optional deployment-owned one-time application credential delivery. When set,
// this must be a trusted in-process recipient for the intended application
// principal; it must never expose credential material through HTTP or logs.
export const applicationCredentialDelivery = undefined;

// Search must resolve current, canonical directory records for the Web
// application pickers. It must throw on dependency failure.
export const directorySearch = missing("directorySearch");
