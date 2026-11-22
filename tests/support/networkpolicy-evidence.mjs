import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import {
	networkPolicySpecSha256V1,
	placementSelectorSha256V1,
} from "../../deploy/ack/networkpolicy-enforcement.mjs";
import {
	networkPolicySpecV1,
	networkPolicyTemplateDigestsV1,
} from "../../packages/platform-core/src/workload-network-policy.ts";

// Synthetic, credential-free inputs that satisfy deploy/ack/networkpolicy-enforcement.mjs
// for script-level tests of ACK entries that now require current evidence (#4351).
const nodeUid = "44444444-4444-4444-8444-444444444444";
const nodeName = "virtual-kubelet-cn-hangzhou-i";
const podUid = "55555555-5555-4555-8555-555555555555";
const policyUid = "66666666-6666-4666-8666-666666666666";
const controllerUid = "88888888-8888-4888-8888-888888888888";

export const workerPodLabels = {
	"app.kubernetes.io/name": "agent-infra",
	"app.kubernetes.io/component": "platform-worker",
};
/** Synthetic Worker NetworkPolicy deployment configuration (no real destinations). */
export const networkPolicyDeploymentConfig = () => ({
	workerSelector: { ...workerPodLabels },
	routeNamespace: "ingress-nginx",
	routeSelector: { "app.kubernetes.io/name": "ingress-nginx" },
	platformApiSelector: { "app.kubernetes.io/component": "platform-api" },
	workspaceSnapshotProjection: false,
	egress: {
		modelEgress: [{ destination: { ip: "198.51.100.10" }, port: 443 }],
		dnsEgress: [
			{ namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
		],
	},
});
export const probeAgentKey = "np-probe.agent-infra.agora.io/agent";

/** Probe-only substitution table and Pod labels for one variant (never production labels). */
export function probePolicyEvidence(
	config,
	variant = "self-managed",
	port = 3003,
) {
	const multi = variant.startsWith("multi-service-");
	const substitutions = {
		agentSelector: { key: probeAgentKey, value: "probe-a" },
		...(multi
			? variant.startsWith("multi-service-migration")
				? {}
				: { service: "probe-svc" }
			: { workerSource: { "np-probe/source": "worker" }, port }),
	};
	return {
		variant,
		substitutions,
		podLabels: {
			target: { [probeAgentKey]: "probe-a" },
			workerSource: { "np-probe/source": "worker" },
			nonWorkerSource: { "np-probe/source": "other" },
		},
		instantiatedSha256: networkPolicySpecSha256V1(
			networkPolicySpecV1({ variant, config, substitutions }),
		),
	};
}

/** The rendered objects the gate reads: Worker placement env and Session ECI admission. */
export function renderedEnforcementManifest(
	namespace,
	placement,
	sessionArchitecture = placement?.architecture ?? "amd64",
) {
	const name = `${namespace}-session-eci`;
	const scope = {
		namespaceSelector: {
			matchLabels: { "kubernetes.io/metadata.name": namespace },
		},
		objectSelector: {
			matchLabels: { "agent-infra.agora.io/managed": "session-sandbox-v1" },
		},
	};
	return [
		{
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name: "agent-infra-worker" },
			spec: {
				selector: { matchLabels: { ...workerPodLabels } },
				template: {
					metadata: {
						labels: { ...workerPodLabels },
					},
					spec: {
						containers: [
							{
								name: "platform-worker",
								env: placement
									? [
											{
												name: "AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT",
												value: JSON.stringify(placement),
											},
										]
									: [],
							},
						],
					},
				},
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "agent-infra-worker" },
			spec: { selector: { ...workerPodLabels } },
		},
		{
			apiVersion: "admissionregistration.k8s.io/v1",
			kind: "MutatingAdmissionPolicy",
			metadata: { name },
			spec: {
				failurePolicy: "Fail",
				matchConstraints: scope,
				mutations: [
					{
						patchType: "JSONPatch",
						jsonPatch: {
							expression: `[JSONPatch{op:"add",path:"/spec/nodeSelector/type",value:"virtual-kubelet"},JSONPatch{op:"add",path:"/spec/nodeSelector/kubernetes.io~1arch",value:"${sessionArchitecture}"}] + [JSONPatch{op:"add",path:"/spec/tolerations",value:[{"key":"virtual-kubelet.io/provider","operator":"Equal","value":"alibabacloud","effect":"NoSchedule"}]}]`,
						},
					},
				],
			},
		},
		{
			apiVersion: "admissionregistration.k8s.io/v1",
			kind: "MutatingAdmissionPolicyBinding",
			metadata: { name },
			spec: { policyName: name, matchResources: scope },
		},
	]
		.map((document) => stringify(document))
		.join("---\n");
}

/** Writes evidence/config files and returns the env plus read-only `kubectl get` answers. */
export async function writeNetworkPolicyEvidence(directory, options) {
	const { namespace, namespaceUid, kubeSystemNamespaceUid } = options;
	const placement = { architecture: "amd64", legacyUnplaced: "reject" };
	const minutesAgo = (minutes) =>
		new Date(Date.now() - minutes * 60_000).toISOString();
	const config = networkPolicyDeploymentConfig();
	const evidenceFile = join(directory, "networkpolicy-evidence.json");
	const configFile = join(directory, "networkpolicy-deployment-config.json");
	await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
	await writeFile(
		evidenceFile,
		JSON.stringify({
			schemaVersion: 1,
			kind: "agent-infra-networkpolicy-enforcement-evidence",
			cluster: { kubeSystemNamespaceUid, clusterId: "c0ffee0000" },
			namespace: { name: namespace, uid: namespaceUid },
			enforcer: {
				runtime: "eci",
				component: "poseidon",
				version: "unobservable",
			},
			placement: {
				...placement,
				selectorSha256: placementSelectorSha256V1(placement.architecture),
			},
			nodes: [{ name: nodeName, uid: nodeUid }],
			networkPolicy: { templateSha256: networkPolicyTemplateDigestsV1(config) },
			probes: [
				{
					destination: {
						pod: "probe-target-0",
						uid: podUid,
						nodeName,
						port: 3003,
						controller: {
							kind: "StatefulSet",
							name: "probe-target",
							uid: controllerUid,
						},
					},
					policy: {
						name: "probe-target",
						uid: policyUid,
						...probePolicyEvidence(config),
					},
					allow: { at: minutesAgo(10), outcome: "connected" },
					deny: {
						at: minutesAgo(9),
						outcome: "timeout",
						policyUid: "77777777-7777-4777-8777-777777777777",
					},
					recovery: { at: minutesAgo(8), outcome: "connected" },
					nonWorker: { at: minutesAgo(7), outcome: "refused" },
				},
			],
			observedAt: minutesAgo(5),
			expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
		}),
		{ mode: 0o600 },
	);
	return {
		env: {
			ACK_NETWORKPOLICY_EVIDENCE_FILE: evidenceFile,
			ACK_NETWORKPOLICY_DEPLOYMENT_CONFIG_FILE: configFile,
		},
		responses: {
			[`namespace/${namespace}`]: {
				metadata: { name: namespace, uid: namespaceUid },
			},
			"namespace/kube-system": {
				metadata: { name: "kube-system", uid: kubeSystemNamespaceUid },
			},
			"nodes/-o": {
				items: [
					{
						metadata: {
							name: nodeName,
							uid: nodeUid,
							labels: {
								type: "virtual-kubelet",
								"kubernetes.io/arch": "amd64",
							},
						},
						spec: {
							taints: [
								{
									key: "virtual-kubelet.io/provider",
									value: "alibabacloud",
									effect: "NoSchedule",
								},
							],
						},
					},
				],
			},
			"statefulsets,deployments,jobs/-l": { items: [] },
		},
		rendered: renderedEnforcementManifest(namespace, placement),
	};
}
