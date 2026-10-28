import { createPublicKey } from "node:crypto";
import type { AgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type { V1EnvVar } from "@kubernetes/client-node";
import { containerBoundaryAttestationV1 } from "./container-boundary-attestation.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import {
	type WorkloadEgressDestinationV1,
	type WorkloadEgressPolicyV1,
	workloadEgressRulesV1,
} from "./workload-network.js";

/** Public verification material and a deployment-provisioned transport token reference only. */
export interface WorkloadRuntimeAuthV1 {
	readonly workerId: string;
	readonly grantKeyId: string;
	readonly grantPublicKey: string;
	readonly grantIssuer: string;
	readonly serviceTokenSecret: { readonly name: string; readonly key: string };
	/** Fixed Worker origin for the Runtime native metadata callback. */
	readonly nativeMetadataWorkerOrigin?: string;
	/**
	 * Exact Platform API origin for Runtime file exchange. Setting it enables the
	 * Host FileBridge and injects the service token from `serviceTokenSecret`;
	 * leaving it unset keeps file exchange disabled for this Workload.
	 */
	readonly fileExchangeOrigin?: string;
}

const DNS_NAME =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Exact HTTP(S) origin without credentials, path, query or fragment. */
export function isFileExchangeOriginV1(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 512) return false;
	let origin: URL;
	try {
		origin = new URL(value);
	} catch {
		return false;
	}
	if (
		(origin.protocol !== "http:" && origin.protocol !== "https:") ||
		origin.origin !== value ||
		origin.username !== "" ||
		origin.password !== "" ||
		(origin.pathname !== "/" && origin.pathname !== "") ||
		origin.search !== "" ||
		origin.hash !== ""
	)
		return false;
	// In-cluster cleartext is limited to DNS Service names. HTTPS may also use
	// a deployment-approved external address.
	return (
		origin.protocol === "https:" ||
		(DNS_NAME.test(origin.hostname) &&
			!IPV4.test(origin.hostname) &&
			!origin.hostname.startsWith("["))
	);
}

/**
 * Resolve the optional file exchange origin from the mounted deployment module
 * and the fixed environment seam. The mounted module stays authoritative; a
 * duplicate, an origin without Runtime auth, or an invalid origin fails closed
 * before any Kubernetes resource is written.
 */
export function resolveWorkloadFileExchangeOriginV1(input: {
	readonly configured?: string;
	readonly environment?: string;
	readonly hasRuntimeAuth: boolean;
}): string | undefined {
	const environment =
		input.environment === undefined || input.environment === ""
			? undefined
			: input.environment;
	if (input.configured !== undefined && environment !== undefined)
		throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_DUPLICATE");
	if (environment !== undefined) {
		if (!input.hasRuntimeAuth || !isFileExchangeOriginV1(environment))
			throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
		return environment;
	}
	return input.configured;
}

/** TCP port an exact file exchange origin connects to (explicit or scheme default). */
export function fileExchangeOriginPortV1(origin: string): number {
	const url = new URL(origin);
	return url.port === ""
		? url.protocol === "https:"
			? 443
			: 80
		: Number(url.port);
}

/**
 * #3289：文件交换 egress 与 origin 必须同时存在或同时缺失；存在时只有一条、只到部署
 * 声明的单一目的地（精确 IP 或 namespace/Pod 选择器），端口等于 origin 的端口。
 */
export function isWorkloadFileExchangeEgressCurrentV1(
	origin: string | undefined,
	egress: WorkloadEgressPolicyV1["fileExchangeEgress"],
): boolean {
	if (origin === undefined) return egress === undefined;
	if (
		!isFileExchangeOriginV1(origin) ||
		!Array.isArray(egress) ||
		egress.length !== 1 ||
		egress[0]?.port !== fileExchangeOriginPortV1(origin)
	)
		return false;
	try {
		workloadEgressRulesV1({ fileExchangeEgress: egress });
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve the file exchange egress from the mounted deployment module
 * (`policy.fileExchangeEgress`) or the fixed environment seam
 * (`PLATFORM_WORKER_FILE_EXCHANGE_EGRESS`, a JSON destination). The port is
 * always the origin's port. A duplicate source, an egress without origin, an
 * origin without egress, or an invalid destination fails closed before any
 * Kubernetes resource is written.
 */
export function resolveWorkloadFileExchangeEgressV1(input: {
	readonly origin?: string;
	readonly configured?: WorkloadEgressPolicyV1["fileExchangeEgress"];
	readonly environment?: string;
}): WorkloadEgressPolicyV1["fileExchangeEgress"] {
	const environment =
		input.environment === undefined || input.environment === ""
			? undefined
			: input.environment;
	if (input.configured !== undefined && environment !== undefined)
		throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_DUPLICATE");
	if (input.origin !== undefined && !isFileExchangeOriginV1(input.origin))
		throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
	let egress = input.configured;
	if (environment !== undefined) {
		if (input.origin === undefined || environment.length > 4096)
			throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
		let destination: WorkloadEgressDestinationV1;
		try {
			destination = JSON.parse(environment);
		} catch {
			throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
		}
		egress = [{ destination, port: fileExchangeOriginPortV1(input.origin) }];
	}
	if (!isWorkloadFileExchangeEgressCurrentV1(input.origin, egress))
		throw new Error("PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID");
	return egress;
}

export function validateWorkloadRuntimeAuthV1(
	input: WorkloadRuntimeAuthV1,
): void {
	try {
		if (
			Object.keys(input).some(
				(key) =>
					![
						"grantIssuer",
						"grantKeyId",
						"grantPublicKey",
						"serviceTokenSecret",
						"workerId",
						"nativeMetadataWorkerOrigin",
						"fileExchangeOrigin",
					].includes(key),
			) ||
			![input.grantKeyId, input.grantIssuer, input.workerId].every(
				(value) =>
					typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value),
			) ||
			typeof input.grantPublicKey !== "string" ||
			!input.grantPublicKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
			createPublicKey(input.grantPublicKey).asymmetricKeyType !== "ed25519" ||
			createPublicKey(input.grantPublicKey)
				.export({ type: "spki", format: "pem" })
				.toString()
				.trim() !== input.grantPublicKey.trim() ||
			Object.keys(input.serviceTokenSecret).sort().join(",") !== "key,name" ||
			!input.serviceTokenSecret.name
				.split(".")
				.every((part) => /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(part)) ||
			input.serviceTokenSecret.name.length > 253 ||
			!/^[-A-Za-z0-9_.]{1,253}$/.test(input.serviceTokenSecret.key) ||
			(input.fileExchangeOrigin !== undefined &&
				!isFileExchangeOriginV1(input.fileExchangeOrigin)) ||
			(input.nativeMetadataWorkerOrigin !== undefined &&
				(() => {
					try {
						const origin = new URL(input.nativeMetadataWorkerOrigin);
						const releaseScopedService =
							/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?-platform-worker-native-metadata$/.test(
								origin.hostname,
							);
						return (
							origin.protocol !== "http:" ||
							origin.username !== "" ||
							origin.password !== "" ||
							(origin.hostname !== "platform-worker-native-metadata" &&
								!releaseScopedService) ||
							(origin.port !== "" && origin.port !== "80") ||
							(origin.pathname !== "/" && origin.pathname !== "") ||
							origin.search !== "" ||
							origin.hash !== ""
						);
					} catch {
						return true;
					}
				})())
		)
			throw new Error();
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
}

export function workloadRuntimeAuthEnvironmentV1(
	auth: WorkloadRuntimeAuthV1,
	desired: AgentWorkloadDesiredV1,
): V1EnvVar[] {
	return [
		{
			name: "AGENT_INFRA_RUNTIME_READINESS_BINDING",
			value: JSON.stringify({
				workerId: auth.workerId,
				agentId: desired.agentId,
				workloadRevision: desired.workloadRevision,
				fence: desired.fence,
				imageDigest: desired.imageDigest,
			}),
		},
		{ name: "AGENT_INFRA_RUNTIME_AGENT_ID", value: desired.agentId },
		{
			name: "AGENT_INFRA_RUNTIME_DATA_DIR",
			value: `${desired.persistentVolume.mountPath}/runtime`,
		},
		{ name: "PORT", value: String(desired.service.port) },
		{ name: "AGENT_INFRA_RUNTIME_GRANT_KEY_ID", value: auth.grantKeyId },
		{
			name: "AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY",
			value: auth.grantPublicKey,
		},
		{ name: "AGENT_INFRA_RUNTIME_GRANT_ISSUER", value: auth.grantIssuer },
		{
			name: "AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
			valueFrom: {
				secretKeyRef: { ...auth.serviceTokenSecret, optional: false },
			},
		},
		...(auth.nativeMetadataWorkerOrigin === undefined
			? []
			: ([
					{
						name: "AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN",
						value: auth.nativeMetadataWorkerOrigin,
					},
					{
						name: "AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN",
						valueFrom: {
							secretKeyRef: { ...auth.serviceTokenSecret, optional: false },
						},
					},
				] satisfies V1EnvVar[])),
		...(auth.fileExchangeOrigin === undefined
			? []
			: ([
					{
						name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
						value: auth.fileExchangeOrigin,
					},
					{
						// The deployment service token stays in the runtime-auth
						// Secret; it is never copied into the Pod env or a log line.
						name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
						valueFrom: {
							secretKeyRef: { ...auth.serviceTokenSecret, optional: false },
						},
					},
				] satisfies V1EnvVar[])),
	];
}

/**
 * Inject the Worker-owned Codex container boundary for one dedicated Workload.
 * The service token is used only to derive the attestation; it is never put in
 * a Pod environment value.
 */
export function codexContainerBoundaryEnvironmentV1(input: {
	readonly enabled: boolean;
	readonly serviceToken?: string;
	readonly scope: string;
}): V1EnvVar[] {
	if (!input.enabled) return [];
	const serviceToken = input.serviceToken;
	if (
		serviceToken === undefined ||
		!/^[\x21-\x7e]{1,8192}$/u.test(serviceToken) ||
		!/^[\x21-\x7e]{1,256}$/u.test(input.scope)
	)
		throw new Error("policy");
	return [
		{ name: "AGENT_INFRA_RUNTIME_ISOLATION_MODE", value: "container-boundary" },
		{
			name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ENABLED",
			value: "worker-v1",
		},
		{
			name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE",
			value: input.scope,
		},
		{
			name: "AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION",
			value: containerBoundaryAttestationV1(serviceToken, input.scope),
		},
	];
}
