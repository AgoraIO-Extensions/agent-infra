import { resolveApprovedConnectionSystemAccessV1 } from "@agent-infra/contracts/connection-consumer-profile";
import type {
	V1Container,
	V1EnvVar,
	V1NetworkPolicy,
	V1Pod,
	V1Secret,
	V1Service,
	V1Volume,
} from "@kubernetes/client-node";
import { connectionManualPublicationProofAnnotationV1 } from "./connection-manual-publication.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { agentContainerSecurityContext } from "./kubernetes-runtime-comparison.js";

const receiver = "AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER";
const names = {
	private: "runtime-oauth-private",
	tls: "runtime-oauth-tls-source",
	callback: "runtime-oauth-callback-source",
	readback: "runtime-oauth-install-source",
} as const;
export const connectionInstallReadbackSecretKeyV1 =
	"connection-install-readback-token";
/** Host env the Host parses into its dynamic publication contract (#4337). */
export const connectionInstallPublicationContractEnvironmentV1 =
	"AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_PUBLICATION_CONTRACT";
const dnsLabel = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const secretName = /^[a-z0-9](?:[-.a-z0-9]{0,251}[a-z0-9])?$/;
const secretKey = /^[-._A-Za-z0-9]{1,253}$/;
const selectorKey = /^[A-Za-z0-9./_-]{1,253}$/;
const selectorValue = /^[A-Za-z0-9](?:[-._A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;

export interface SessionSandboxConnectionInstallBootstrapV1 {
	readonly port: number;
	readonly workerOrigin: string;
	readonly apiSelector: Readonly<Record<string, string>>;
	readonly clientName: string;
	readonly configuration: unknown;
	readonly approval: unknown;
	readonly tlsSecretRef: {
		readonly name: string;
		readonly certKey: string;
		readonly keyKey: string;
	};
	readonly callbackAuthSecretRef: {
		readonly name: string;
		readonly key: string;
	};
	readonly workerCaSecretRef: { readonly name: string; readonly key: string };
	/** Derived install-only transport identity for this Sandbox. */
	readonly installToken: string;
	/**
	 * #4199 C2: the approved dynamic publication contract (non-secret JSON), present only
	 * for a Session of an Agent with a verified Owner manual association.
	 */
	readonly publicationContract?: string;
	/**
	 * #4199 C2: the Worker's proof of this Pod's declaration decision (contract or none),
	 * written to the Pod as an annotation; see `connectionManualPublicationProofV1`.
	 */
	readonly publicationProof?: string;
}

/** Once-per-deployment trust. Sandbox-specific material is selected by the Worker. */
export interface ConnectionInstallBootstrapDeploymentV1
	extends Omit<
		SessionSandboxConnectionInstallBootstrapV1,
		"installToken" | "tlsSecretRef" | "publicationContract" | "publicationProof"
	> {
	readonly tlsSecretForSandbox: (
		resourceName: string,
	) => SessionSandboxConnectionInstallBootstrapV1["tlsSecretRef"];
}

export interface SessionSandboxConnectionInstallLocationV1 {
	readonly namespace: string;
	readonly sandboxId: string;
	readonly podName: string;
	readonly serviceName: string;
	readonly generation: number;
	readonly resourceFence: number;
	readonly workspaceMountPath: string;
	readonly containerPort: number;
	readonly secretName: string;
	readonly imageDigest: string;
	readonly authorizedIngressSelector: Readonly<Record<string, string>>;
	readonly resources: V1Container["resources"];
}

function invalid(): never {
	throw new WorkloadKubernetesError("policy");
}

function validSelector(entries: Readonly<Record<string, string>>) {
	if (!entries || typeof entries !== "object" || Array.isArray(entries))
		return false;
	const pairs = Object.entries(entries);
	return (
		pairs.length > 0 &&
		pairs.every(
			([key, value]) =>
				selectorKey.test(key) &&
				typeof value === "string" &&
				selectorValue.test(value),
		)
	);
}

function source(
	volume: string,
	ref: string,
	items: { key: string; path: string }[],
): V1Volume {
	if (!secretName.test(ref) || items.some(({ key }) => !secretKey.test(key)))
		invalid();
	return {
		name: volume,
		secret: { secretName: ref, optional: true, defaultMode: 0o440, items },
	};
}

function field(name: string, fieldPath: string): V1EnvVar {
	return { name, valueFrom: { fieldRef: { apiVersion: "v1", fieldPath } } };
}

export function connectionInstallInitializerV1(image: string): V1Container {
	return {
		name: "runtime-oauth-provision",
		image,
		imagePullPolicy: "IfNotPresent",
		command: ["/bin/sh", "-ec"],
		args: [
			"ulimit -S -c 0\nulimit -H -c 0\nexec /usr/local/bin/node --disable-sigusr1 /app/dist/runtime-oauth-provisioning-cli.mjs",
		],
	};
}

/** Add the approved empty receiver to the existing Sandbox Service and Pod. */
export function projectSessionSandboxConnectionInstallV1(
	input: SessionSandboxConnectionInstallBootstrapV1,
	location: SessionSandboxConnectionInstallLocationV1,
	objects: {
		pod: V1Pod;
		policy: V1NetworkPolicy;
		service: V1Service;
		secret: V1Secret;
	},
) {
	const { pod, policy, service, secret } = objects;
	const host = pod.spec?.containers[0];
	if (!host || !pod.spec || !policy.spec || !service.spec || !secret.data)
		invalid();
	let worker: URL;
	try {
		worker = new URL(input.workerOrigin);
	} catch {
		invalid();
	}
	const workerHosts = worker.hostname.split(".");
	if (
		!dnsLabel.test(location.namespace) ||
		location.podName !== `sandbox-${location.sandboxId}` ||
		location.serviceName !== location.podName ||
		!dnsLabel.test(location.serviceName) ||
		!Number.isInteger(input.port) ||
		input.port < 1024 ||
		input.port > 65_535 ||
		input.port === location.containerPort ||
		worker.protocol !== "https:" ||
		worker.href !== input.workerOrigin ||
		!worker.port ||
		Number(worker.port) < 1024 ||
		worker.pathname !== "/" ||
		worker.search ||
		worker.hash ||
		worker.username ||
		worker.password ||
		workerHosts.length !== 3 ||
		!dnsLabel.test(workerHosts[0] ?? "") ||
		workerHosts[1] !== location.namespace ||
		workerHosts[2] !== "svc" ||
		!validSelector(input.apiSelector) ||
		!validSelector(location.authorizedIngressSelector) ||
		!/^[\x20-\x7e]{1,100}$/.test(input.clientName) ||
		!/^[A-Za-z0-9_-]{43}$/.test(input.installToken) ||
		(input.publicationContract !== undefined &&
			(typeof input.publicationContract !== "string" ||
				input.publicationContract === "" ||
				Buffer.byteLength(input.publicationContract) > 65_536)) ||
		(input.publicationProof !== undefined &&
			(typeof input.publicationProof !== "string" ||
				!/^[A-Za-z0-9_-]{43}$/.test(input.publicationProof))) ||
		resolveApprovedConnectionSystemAccessV1(input.configuration, input.approval)
			.status !== "available"
	)
		invalid();

	const origin = `https://${location.serviceName}.${location.namespace}.svc:${input.port}/`;
	const launchEnv = [
		{ name: receiver, value: "v1" },
		{ name: "AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_ORIGIN", value: origin },
	];
	const env: V1EnvVar[] = [
		...launchEnv,
		{
			name: "AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_WORKER_ORIGIN",
			value: worker.href,
		},
		{
			name: "AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS",
			value: JSON.stringify(input.configuration),
		},
		{
			name: "AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS_APPROVAL",
			value: JSON.stringify(input.approval),
		},
		{
			name: "AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_CLIENT_NAME",
			value: input.clientName,
		},
		...(input.publicationContract === undefined
			? []
			: [
					{
						name: connectionInstallPublicationContractEnvironmentV1,
						value: input.publicationContract,
					},
				]),
		{ name: "AGENT_INFRA_RUNTIME_SANDBOX_ID", value: location.sandboxId },
		{
			name: "AGENT_INFRA_RUNTIME_SESSION_GENERATION",
			value: String(location.generation),
		},
		{
			name: "AGENT_INFRA_RUNTIME_RESOURCE_FENCE",
			value: String(location.resourceFence),
		},
		field("AGENT_INFRA_RUNTIME_NAMESPACE", "metadata.namespace"),
		field("AGENT_INFRA_RUNTIME_POD_UID", "metadata.uid"),
		field("AGENT_INFRA_RUNTIME_POD_NAME", "metadata.name"),
	];
	const hostEnv = new Map(host.env?.map((item) => [item.name, item]));
	for (const item of env) {
		const existing = hostEnv.get(item.name);
		if (existing && JSON.stringify(existing) !== JSON.stringify(item))
			invalid();
		hostEnv.set(item.name, item);
	}
	host.env = [...hostEnv.values()];
	if (input.publicationProof !== undefined)
		pod.metadata = {
			...pod.metadata,
			annotations: {
				...pod.metadata?.annotations,
				[connectionManualPublicationProofAnnotationV1]: input.publicationProof,
			},
		};
	host.ports = [
		...(host.ports ?? []),
		{ name: "oauth", containerPort: input.port },
	];
	host.volumeMounts = [
		...(host.volumeMounts ?? []),
		{
			name: names.private,
			subPath: "tls",
			mountPath: `${location.workspaceMountPath}/runtime/codex-driver.json.native/conversations/standard-mcp-oauth/tls`,
			readOnly: true,
		},
	];
	const volumes: V1Volume[] = [
		{ name: names.private, emptyDir: { medium: "Memory", sizeLimit: "128Ki" } },
		source(names.tls, input.tlsSecretRef.name, [
			{ key: input.tlsSecretRef.certKey, path: "server.crt" },
			{ key: input.tlsSecretRef.keyKey, path: "server.key" },
		]),
		source(names.callback, input.callbackAuthSecretRef.name, [
			{ key: input.callbackAuthSecretRef.key, path: "callback.auth" },
		]),
		{
			name: names.readback,
			projected: {
				defaultMode: 0o440,
				sources: [
					{
						secret: {
							name: location.secretName,
							items: [
								{
									key: connectionInstallReadbackSecretKeyV1,
									path: "install.auth",
								},
							],
						},
					},
					{
						secret: {
							name: input.workerCaSecretRef.name,
							optional: true,
							items: [
								{ key: input.workerCaSecretRef.key, path: "worker-ca.crt" },
							],
						},
					},
				],
			},
		},
	];
	if (
		!secretName.test(input.workerCaSecretRef.name) ||
		!secretKey.test(input.workerCaSecretRef.key)
	)
		invalid();
	pod.spec.volumes = [...(pod.spec.volumes ?? []), ...volumes];
	pod.spec.initContainers = [
		...(pod.spec.initContainers ?? []),
		{
			...connectionInstallInitializerV1(location.imageDigest),
			env: [
				...launchEnv,
				{
					name: "AGENT_INFRA_RUNTIME_DATA_DIR",
					value: `${location.workspaceMountPath}/runtime`,
				},
			],
			resources: location.resources,
			securityContext: agentContainerSecurityContext(),
			volumeMounts: [
				{ name: "workspace", mountPath: location.workspaceMountPath },
				{ name: names.private, mountPath: "/oauth-private" },
				{ name: names.tls, mountPath: "/oauth-source-tls", readOnly: true },
				{
					name: names.callback,
					mountPath: "/oauth-source-callback",
					readOnly: true,
				},
				{
					name: names.readback,
					mountPath: "/oauth-source-install",
					readOnly: true,
				},
			],
		},
	];
	secret.data[connectionInstallReadbackSecretKeyV1] = Buffer.from(
		input.installToken,
	).toString("base64");
	service.spec.ports = [
		...(service.spec.ports ?? []),
		{ name: "oauth", port: input.port, targetPort: input.port },
	];
	policy.spec.ingress = [
		...(policy.spec.ingress ?? []),
		{
			_from: [location.authorizedIngressSelector, input.apiSelector].map(
				(matchLabels) => ({ podSelector: { matchLabels } }),
			),
			ports: [{ protocol: "TCP", port: input.port }],
		},
	];
	policy.spec.egress = [
		...(policy.spec.egress ?? []),
		{
			to: [
				{ podSelector: { matchLabels: location.authorizedIngressSelector } },
			],
			ports: [{ protocol: "TCP", port: Number(worker.port) }],
		},
	];
}
