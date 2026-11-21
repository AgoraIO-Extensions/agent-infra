import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { networkPolicySpecSha256V1 } from "../../deploy/ack/networkpolicy-enforcement.mjs";

// Synthetic, credential-free inputs that satisfy deploy/ack/networkpolicy-enforcement.mjs
// for script-level tests of ACK entries that now require current evidence (#4351).
const nodeUid = "44444444-4444-4444-8444-444444444444";
const nodeName = "virtual-kubelet-cn-hangzhou-i";
const podUid = "55555555-5555-4555-8555-555555555555";
const policyUid = "66666666-6666-4666-8666-666666666666";
const controllerUid = "88888888-8888-4888-8888-888888888888";

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
				template: {
					metadata: {
						labels: { "app.kubernetes.io/component": "platform-worker" },
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
	const enforcerConfig = Buffer.from(
		JSON.stringify({
			schemaVersion: 1,
			kind: "ack-poseidon-config-readback",
			clusterId: "c0ffee0000",
			component: "poseidon",
			version: "v0.8.0",
			eciNetworkPolicyEnabled: true,
			readAt: minutesAgo(1),
		}),
	);
	const policySpec = {
		podSelector: { matchLabels: { app: "probe-target" } },
		policyTypes: ["Ingress"],
	};
	const evidenceFile = join(directory, "networkpolicy-evidence.json");
	const enforcerConfigFile = join(directory, "poseidon-config.json");
	await writeFile(enforcerConfigFile, enforcerConfig, { mode: 0o600 });
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
				version: "v0.8.0",
				configSha256: createHash("sha256").update(enforcerConfig).digest("hex"),
			},
			placement,
			nodes: [{ name: nodeName, uid: nodeUid }],
			targets: [],
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
						specSha256: networkPolicySpecSha256V1(policySpec),
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
			ACK_NETWORKPOLICY_ENFORCER_CONFIG_FILE: enforcerConfigFile,
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
			"pod/probe-target-0": {
				metadata: {
					name: "probe-target-0",
					uid: podUid,
					namespace,
					labels: { app: "probe-target" },
					ownerReferences: [
						{
							kind: "StatefulSet",
							name: "probe-target",
							uid: controllerUid,
							controller: true,
						},
					],
				},
				spec: {
					nodeName,
					containers: [{ name: "probe", ports: [{ containerPort: 3003 }] }],
				},
				status: { phase: "Running" },
			},
			"networkpolicy/probe-target": {
				metadata: { name: "probe-target", uid: policyUid, namespace },
				spec: policySpec,
			},
		},
		rendered: renderedEnforcementManifest(namespace, placement),
	};
}
