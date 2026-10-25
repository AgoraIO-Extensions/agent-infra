const profileEnvironment = "AGENT_INFRA_CONNECTION_PROFILE";
const versionEnvironment = "AGENT_INFRA_CONNECTION_CONFIG_VERSION";
const fingerprintEnvironment = "AGENT_INFRA_CONNECTION_CONFIG_FINGERPRINT";
const sourceRefEnvironment = "AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REF";
const sourceRevisionEnvironment =
	"AGENT_INFRA_CONNECTION_APPROVAL_SOURCE_REVISION";
const webPathEnvironment = "AGENT_INFRA_CONNECTION_WEB_PATH";

export interface ConnectionConsumerEnvironmentConfigurationV1 {
	readonly profile: unknown;
	readonly approval: unknown;
	readonly configVersion: string | undefined;
	readonly webPath: string | undefined;
}

/**
 * Read the deployment-owned non-secret profile already projected by Helm.
 * The deployment module remains authoritative when it provides the profile;
 * this is the env-only fallback used by local and first-party deployments.
 */
export function readConnectionConsumerEnvironmentConfigurationV1(
	environment: NodeJS.ProcessEnv,
): ConnectionConsumerEnvironmentConfigurationV1 | undefined {
	const rawProfile = environment[profileEnvironment];
	const configVersion = environment[versionEnvironment];
	const fingerprint = environment[fingerprintEnvironment];
	const sourceRef = environment[sourceRefEnvironment];
	const sourceRevision = environment[sourceRevisionEnvironment];
	const webPath = environment[webPathEnvironment];
	if (
		[
			rawProfile,
			configVersion,
			fingerprint,
			sourceRef,
			sourceRevision,
			webPath,
		].every((value) => value === undefined || value === "")
	)
		return undefined;
	let profile: unknown;
	try {
		profile = JSON.parse(rawProfile ?? "");
	} catch {
		profile = undefined;
	}
	const approval = {
		schemaVersion: 1,
		configFingerprint: fingerprint ?? "",
		egressEnforced: true,
		source: { ref: sourceRef ?? "", revision: sourceRevision ?? "" },
	};
	if (
		![configVersion, fingerprint, sourceRef, sourceRevision].every(
			(value) => typeof value === "string" && value.length > 0,
		) ||
		configVersion !== `1-${String(fingerprint ?? "")}`
	)
		profile = undefined;
	return { profile, approval, configVersion, webPath };
}
