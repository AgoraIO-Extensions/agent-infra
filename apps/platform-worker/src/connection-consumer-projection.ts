import {
	supportsProtectedOpenCodeMcpTransport,
	supportsProtectedPiMcpTransport,
} from "@agent-infra/agent-runtime";
import { resolveApprovedConnectionConsumerProfileV1 } from "@agent-infra/contracts/connection-consumer-profile";
import type {
	V1EnvVar,
	V1Pod,
	V1Volume,
	V1VolumeMount,
} from "@kubernetes/client-node";
import { WorkloadKubernetesError } from "./kubernetes-client.js";

export const runtimeConnectionConsumerAnnotation =
	"agent-infra.agora.io/connection-consumer-snapshot";
export const runtimeConnectionConsumerFileEnvironment =
	"AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE";
export const runtimeConnectionConsumerRevisionEnvironment =
	"AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_REVISION";
export const runtimeConnectionInstallationRevisionEnvironment =
	"AGENT_INFRA_RUNTIME_CONNECTION_INSTALLATION_REVISION";
export const runtimeConnectionAcpMcpBridgeEnvironment =
	"AGENT_INFRA_RUNTIME_ACP_MCP_BRIDGE";
export const runtimeConnectionPiMcpBridgeEnvironment =
	"AGENT_INFRA_RUNTIME_PI_MCP_BRIDGE";

/** Per-Agent approved snapshots. A present map is authoritative and missing IDs fail closed. */
export type RuntimeConnectionConsumerSnapshotsByAgentV1 = Readonly<
	Record<string, string | null>
>;

export function runtimeConnectionConsumerSnapshotForAgentV1(
	snapshot: string | null | undefined,
	byAgent: RuntimeConnectionConsumerSnapshotsByAgentV1 | undefined,
	agentId: string,
): string | null | undefined {
	if (byAgent === undefined) return snapshot;
	if (!Object.hasOwn(byAgent, agentId)) return null;
	return byAgent[agentId] ?? null;
}

export function runtimeConnectionInstallationRevisionForAgentV1(
	revision: string | null | undefined,
	byAgent: Readonly<Record<string, string | null>> | undefined,
	agentId: string,
): string | null | undefined {
	if (byAgent === undefined) return revision;
	if (!Object.hasOwn(byAgent, agentId)) return null;
	return byAgent[agentId] ?? null;
}

export function isRuntimeConnectionEnvironmentV1(name: string): boolean {
	return [
		runtimeConnectionConsumerFileEnvironment,
		runtimeConnectionConsumerRevisionEnvironment,
		runtimeConnectionInstallationRevisionEnvironment,
		runtimeConnectionAcpMcpBridgeEnvironment,
		runtimeConnectionPiMcpBridgeEnvironment,
	].includes(name);
}

const directory = "/var/run/agent-infra/connection-consumer";
const fileName = "snapshot.json";
const maximumSnapshotBytes = 8192;

/** Keep original control checks while excluding only this new delivery's fields. */
export function runtimeConnectionConsumerControlPodV1(pod: V1Pod): V1Pod {
	const copy = structuredClone(pod);
	if (copy.metadata?.annotations)
		delete copy.metadata.annotations[runtimeConnectionConsumerAnnotation];
	for (const container of copy.spec?.containers ?? []) {
		container.env = container.env?.filter(
			(entry) => !isRuntimeConnectionEnvironmentV1(entry.name),
		);
		container.volumeMounts = container.volumeMounts?.filter(
			(entry) => entry.name !== "connection-consumer",
		);
	}
	if (copy.spec)
		copy.spec.volumes = copy.spec.volumes?.filter(
			(entry) => entry.name !== "connection-consumer",
		);
	return copy;
}

/** Capture the deployment source once. This copy is neither egress nor token authority. */
export function createRuntimeConnectionConsumerSnapshotV1(
	profile: unknown,
	approval: unknown,
): string | null | undefined {
	if (profile === undefined && approval === undefined) return undefined;
	try {
		const input = structuredClone({ profile, approval });
		const approved = resolveApprovedConnectionConsumerProfileV1(
			input.profile,
			input.approval,
		);
		if (approved.status !== "available") throw new Error();
		const snapshot = JSON.stringify({
			profile: approved.profile,
			approval: input.approval,
		});
		if (Buffer.byteLength(snapshot, "utf8") > maximumSnapshotBytes)
			throw new Error();
		return snapshot;
	} catch {
		// Keep the original control plane alive; new business rejects this marker.
		return null;
	}
}

/** Only deployment-approved nonsecret references select the Host's fixed export. */
export function createRuntimeConnectionInstallationRevisionV1(
	supply: unknown,
	consumerSnapshot: string | null | undefined,
): string | null | undefined {
	if (supply === undefined) return undefined;
	try {
		const input = structuredClone(supply) as Record<string, unknown> | null;
		if (
			!consumerSnapshot ||
			!input ||
			typeof input !== "object" ||
			Array.isArray(input) ||
			Object.keys(input).sort().join(",") !== "ref,revision" ||
			[input.ref, input.revision].some(
				(value) =>
					typeof value !== "string" ||
					!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
			)
		)
			throw new Error();
		return JSON.stringify([input.ref, input.revision]);
	} catch {
		return null;
	}
}

/** A delivery projection of the approved source, not another configuration source. */
export function runtimeConnectionConsumerProjectionV1(
	snapshot?: string | null,
	installationRevision?: string | null,
	templateBinding?: {
		readonly driver: "codex" | "claude" | "acp" | "pi";
		readonly templateId: string;
	},
): {
	annotations: Record<string, string>;
	env: V1EnvVar[];
	volumeMounts: V1VolumeMount[];
	volumes: V1Volume[];
} {
	if (installationRevision != null && !snapshot)
		throw new WorkloadKubernetesError("policy");
	if (snapshot === undefined || snapshot === null)
		return { annotations: {}, env: [], volumeMounts: [], volumes: [] };
	let revision: string;
	try {
		if (installationRevision != null) {
			if (Buffer.byteLength(installationRevision, "utf8") > 512)
				throw new Error();
			const selected: unknown = JSON.parse(installationRevision);
			if (
				!Array.isArray(selected) ||
				selected.length !== 2 ||
				createRuntimeConnectionInstallationRevisionV1(
					{ ref: selected[0], revision: selected[1] },
					snapshot,
				) !== installationRevision
			)
				throw new Error();
		}
		if (Buffer.byteLength(snapshot, "utf8") > maximumSnapshotBytes)
			throw new Error();
		const input = JSON.parse(snapshot);
		if (
			!input ||
			typeof input !== "object" ||
			Array.isArray(input) ||
			Object.keys(input).sort().join(",") !== "approval,profile"
		)
			throw new Error();
		if (
			createRuntimeConnectionConsumerSnapshotV1(
				input.profile,
				input.approval,
			) !== snapshot
		)
			throw new Error();
		revision = JSON.stringify([
			input.approval.configFingerprint,
			input.approval.source.ref,
			input.approval.source.revision,
		]);
	} catch {
		throw new WorkloadKubernetesError("policy");
	}
	return {
		annotations: { [runtimeConnectionConsumerAnnotation]: snapshot },
		env: [
			...(installationRevision != null
				? [
						{
							name: runtimeConnectionInstallationRevisionEnvironment,
							value: installationRevision,
						},
					]
				: []),
			{
				name: runtimeConnectionConsumerFileEnvironment,
				value: `${directory}/${fileName}`,
			},
			...(installationRevision != null &&
			supportsProtectedOpenCodeMcpTransport() &&
			templateBinding?.driver === "acp" &&
			templateBinding.templateId === "opencode"
				? [
						{
							name: runtimeConnectionAcpMcpBridgeEnvironment,
							value: "verified-v1",
						},
					]
				: []),
			...(installationRevision != null &&
			supportsProtectedPiMcpTransport() &&
			templateBinding?.driver === "pi" &&
			templateBinding.templateId === "pi"
				? [
						{
							name: runtimeConnectionPiMcpBridgeEnvironment,
							value: "verified-v1",
						},
					]
				: []),
			// Immutable PodSpec assertion, never a configuration override.
			{ name: runtimeConnectionConsumerRevisionEnvironment, value: revision },
		],
		volumeMounts: [
			{ name: "connection-consumer", mountPath: directory, readOnly: true },
		],
		volumes: [
			{
				name: "connection-consumer",
				downwardAPI: {
					defaultMode: 0o444,
					items: [
						{
							path: fileName,
							fieldRef: {
								apiVersion: "v1",
								fieldPath: `metadata.annotations['${runtimeConnectionConsumerAnnotation}']`,
							},
						},
					],
				},
			},
		],
	};
}
