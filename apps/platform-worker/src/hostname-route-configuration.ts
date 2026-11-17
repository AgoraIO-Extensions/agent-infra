import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import type { WorkloadPublicRoutePolicyV1 } from "./workload-public-route.js";
import { workloadResourceNameV1 } from "./workload-resource-name.js";

export interface WorkloadHostnameRoutesV1 {
	readonly hostSuffix: string;
	readonly platformOrigin: string;
	readonly clusterIssuerName: string;
	readonly agentIds: readonly string[];
}

export type HostnameRouteConfigurationV1 =
	| { readonly schemaVersion: 1; readonly enabled: false }
	| {
			readonly schemaVersion: 1;
			readonly enabled: true;
			readonly namespace: string;
			readonly hostnameRoutes: WorkloadHostnameRoutesV1;
	  };

export interface HostnameRouteConfigurationSourceV1 {
	readonly configuration: HostnameRouteConfigurationV1;
	/** Original mounted file bytes, not the canonical serialization. */
	readonly sha256: string;
}

export const defaultHostnameRouteConfigurationFileV1 =
	"/var/run/agent-infra/deployment/hostname-routes.json";
const dnsName =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const namespaceName = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

function invalid(): never {
	throw new TypeError("HOSTNAME_ROUTE_CONFIGURATION_INVALID");
}

function record(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
	return input as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
	if (Object.keys(value).sort().join() !== [...keys].sort().join()) invalid();
}

export function canonicalDeploymentOriginV1(value: unknown): URL {
	if (typeof value !== "string") invalid();
	try {
		const origin = new URL(value);
		if (
			origin.origin !== value ||
			origin.protocol !== "https:" ||
			origin.port ||
			isIP(origin.hostname) !== 0 ||
			!origin.hostname.includes(".") ||
			origin.hostname.length > 253 ||
			!dnsName.test(origin.hostname)
		)
			invalid();
		return origin;
	} catch {
		return invalid();
	}
}

export function parseWorkloadHostnameRoutesV1(
	input: unknown,
): WorkloadHostnameRoutesV1 {
	const value = record(input);
	exactKeys(value, [
		"hostSuffix",
		"platformOrigin",
		"clusterIssuerName",
		"agentIds",
	]);
	if (
		typeof value.hostSuffix !== "string" ||
		value.hostSuffix.length > 214 ||
		!value.hostSuffix.includes(".") ||
		!dnsName.test(value.hostSuffix) ||
		isIP(value.hostSuffix) !== 0 ||
		typeof value.clusterIssuerName !== "string" ||
		value.clusterIssuerName.length > 253 ||
		!dnsName.test(value.clusterIssuerName) ||
		!Array.isArray(value.agentIds) ||
		value.agentIds.length < 1 ||
		value.agentIds.length > 512 ||
		new Set(value.agentIds).size !== value.agentIds.length ||
		value.agentIds.some(
			(id) => typeof id !== "string" || !/^[\x21-\x7e]{1,160}$/.test(id),
		)
	)
		invalid();
	const platform = canonicalDeploymentOriginV1(value.platformOrigin);
	const agentIds = [...value.agentIds] as string[];
	for (const id of agentIds) {
		const host = workloadResourceNameV1(id) + "." + value.hostSuffix;
		if (
			canonicalDeploymentOriginV1("https://" + host).hostname !== host ||
			host === platform.hostname
		)
			invalid();
	}
	return {
		hostSuffix: value.hostSuffix,
		platformOrigin: platform.origin,
		clusterIssuerName: value.clusterIssuerName,
		agentIds: agentIds.sort(),
	};
}

export function parseHostnameRouteConfigurationV1(
	input: unknown,
): HostnameRouteConfigurationV1 {
	const value = record(input);
	if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean")
		invalid();
	if (!value.enabled) {
		exactKeys(value, ["schemaVersion", "enabled"]);
		return { schemaVersion: 1, enabled: false };
	}
	exactKeys(value, ["schemaVersion", "enabled", "namespace", "hostnameRoutes"]);
	if (
		typeof value.namespace !== "string" ||
		!namespaceName.test(value.namespace)
	)
		invalid();
	return {
		schemaVersion: 1,
		enabled: true,
		namespace: value.namespace,
		hostnameRoutes: parseWorkloadHostnameRoutesV1(value.hostnameRoutes),
	};
}

/** Only the scoped selection changes; no global route default is rewritten. */
export function bindHostnameRouteConfigurationV1<
	T extends WorkloadPublicRoutePolicyV1 & { readonly namespace: string },
>(
	policy: T,
	input: HostnameRouteConfigurationV1 | undefined,
	actualNamespace = policy.namespace,
): T {
	if (input === undefined) return policy;
	const configuration = parseHostnameRouteConfigurationV1(input);
	if (!configuration.enabled) {
		if (policy.hostnameRoutes !== undefined)
			throw new Error("HOSTNAME_ROUTE_CONFIGURATION_CONFLICT");
		return policy;
	}
	if (
		configuration.namespace !== policy.namespace ||
		configuration.namespace !== actualNamespace
	)
		throw new Error("HOSTNAME_ROUTE_CONFIGURATION_SCOPE_MISMATCH");
	if (
		policy.hostnameRoutes !== undefined &&
		JSON.stringify(parseWorkloadHostnameRoutesV1(policy.hostnameRoutes)) !==
			JSON.stringify(configuration.hostnameRoutes)
	)
		throw new Error("HOSTNAME_ROUTE_CONFIGURATION_CONFLICT");
	if (
		configuration.hostnameRoutes.agentIds.some((id) =>
			policy.pathRoutes?.agentIds.includes(id),
		)
	)
		throw new Error("HOSTNAME_ROUTE_CONFIGURATION_CONFLICT");
	return { ...policy, hostnameRoutes: configuration.hostnameRoutes };
}

export function serializeHostnameRouteConfigurationV1(input: unknown): string {
	return (
		JSON.stringify(parseHostnameRouteConfigurationV1(input), null, 2) + "\n"
	);
}

/** Same single read and byte digest for production and the normal RO producer. */
export function readHostnameRouteConfigurationV1(
	options: { readonly file?: string; readonly required?: boolean } = {},
): HostnameRouteConfigurationSourceV1 | undefined {
	const explicit = process.env.PLATFORM_WORKER_HOSTNAME_ROUTES_FILE;
	const file =
		options.file ?? explicit ?? defaultHostnameRouteConfigurationFileV1;
	const required = options.required ?? explicit !== undefined;
	if (!isAbsolute(file)) invalid();
	let bytes: Buffer;
	try {
		bytes = readFileSync(file);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") {
			if (!required) return undefined;
			throw new Error("HOSTNAME_ROUTE_CONFIGURATION_MISSING");
		}
		throw new Error("HOSTNAME_ROUTE_CONFIGURATION_UNAVAILABLE");
	}
	if (bytes.length > 131072) invalid();
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return invalid();
	}
	return {
		configuration: parseHostnameRouteConfigurationV1(value),
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

export function hostnameRouteConfigurationPlanV1(input: unknown) {
	const configuration = parseHostnameRouteConfigurationV1(input);
	const content = serializeHostnameRouteConfigurationV1(configuration);
	return {
		schemaVersion: 1 as const,
		kind: "agent-hostname-route-plan" as const,
		status: "planned" as const,
		configurationSha256: createHash("sha256").update(content).digest("hex"),
		enabled: configuration.enabled,
		bindings: configuration.enabled
			? configuration.hostnameRoutes.agentIds.map((agentId) => {
					const name = workloadResourceNameV1(agentId);
					const host = name + "." + configuration.hostnameRoutes.hostSuffix;
					return {
						agentId,
						namespace: configuration.namespace,
						origin: "https://" + host,
						host,
						path: "/",
						certificateName: name + "-tls",
						tlsSecretName: name + "-tls",
						issuerRef: {
							group: "cert-manager.io",
							kind: "ClusterIssuer",
							name: configuration.hostnameRoutes.clusterIssuerName,
						},
					};
				})
			: [],
		fieldMutated: false,
		certificateIssued: false,
		businessVerified: false,
	};
}
