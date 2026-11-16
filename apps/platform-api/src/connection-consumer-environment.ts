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

const systemAccessEnvironment = "AGENT_INFRA_CONNECTION_SYSTEM_ACCESS";
const systemAccessApprovalEnvironment =
	"AGENT_INFRA_CONNECTION_SYSTEM_ACCESS_APPROVAL";

export interface ConnectionSystemAccessEnvironmentConfigurationV1 {
	readonly system: unknown;
	readonly approval: unknown;
	readonly configVersion: string | undefined;
	readonly webPath: string | undefined;
}

function parseJson(value: string | undefined): unknown {
	try {
		return JSON.parse(value ?? "");
	} catch {
		return undefined;
	}
}

/**
 * Read the one-time system access projected by Helm (Spec §13.5.7). It names no
 * Consumer; per-Agent Consumers come only from associations in the Platform DB.
 *
 * The approval is the deployment's explicit, fingerprint-bound attestation
 * (`AGENT_INFRA_CONNECTION_SYSTEM_ACCESS_APPROVAL`), passed through unchanged so the
 * contract check decides it. Nothing is inferred from metadata: an absent approval, an
 * `egressEnforced` that is not literally true, or a fingerprint that does not match the
 * fields keeps Connection unavailable (Spec §13.5.2).
 */
export function readConnectionSystemAccessEnvironmentConfigurationV1(
	environment: NodeJS.ProcessEnv,
): ConnectionSystemAccessEnvironmentConfigurationV1 | undefined {
	const raw = environment[systemAccessEnvironment];
	if (raw === undefined || raw === "") return undefined;
	const configVersion = environment[versionEnvironment];
	const approval = parseJson(environment[systemAccessApprovalEnvironment]);
	const approvedFingerprint =
		approval !== null &&
		typeof approval === "object" &&
		typeof (approval as { configFingerprint?: unknown }).configFingerprint ===
			"string"
			? (approval as { configFingerprint: string }).configFingerprint
			: undefined;
	const separateFingerprint = environment[fingerprintEnvironment];
	let system = parseJson(raw);
	if (
		approvedFingerprint === undefined ||
		configVersion !== `1-${approvedFingerprint}` ||
		// A separately projected fingerprint must name the same approval.
		(separateFingerprint !== undefined &&
			separateFingerprint !== "" &&
			separateFingerprint !== approvedFingerprint) ||
		// A legacy Consumer profile in the same environment is ambiguous; close Connection.
		(environment[profileEnvironment] ?? "") !== ""
	)
		system = null;
	return {
		system,
		approval,
		configVersion,
		webPath: environment[webPathEnvironment],
	};
}
