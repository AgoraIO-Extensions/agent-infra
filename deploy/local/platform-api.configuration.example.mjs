// Copy this file outside the repository as configuration.mjs and replace every
// placeholder with a reviewed deployment-owned implementation. Do not put
// passwords, private keys, Kubernetes credentials or model credentials here.

const missing = (name) => {
	throw new Error(`Configure deployment export: ${name}`);
};

// Must be an ldaps:// configuration with PostgreSQL-backed identityIds and a
// verifyCurrentStatus function. A dedicated activeAttribute is not required.
export const ldap = missing("ldap");

// These functions must query current, trusted deployment facts. They must throw
// on dependency failure rather than returning a permissive default.
export const isPlatformDisabled = missing("isPlatformDisabled");
export const organizationIds = missing("organizationIds");
export const publicOrigin = "https://localhost:3001";

// apiInput is the credential-free Platform admission boundary. Keep Worker
// private keys and raw model credentials out of this API-only module.
export const apiInput = missing("apiInput");
