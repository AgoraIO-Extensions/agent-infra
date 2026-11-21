import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Synthetic, credential-free inputs that satisfy deploy/ack/networkpolicy-enforcement.mjs
// for script-level tests of ACK entries that now require current evidence (#4351).
const nodeUid = "44444444-4444-4444-8444-444444444444";
const nodeName = "virtual-kubelet-cn-hangzhou-i";

export const sessionEciAdmission = (namespace) =>
	[
		"kind: MutatingAdmissionPolicy",
		"metadata:",
		`  name: ${namespace}-session-eci`,
		"spec:",
		"  mutations:",
		"    - jsonPatch:",
		'        expression: JSONPatch{op:"add",path:"/spec/nodeSelector/type",value:"virtual-kubelet"}',
		"---",
		"kind: MutatingAdmissionPolicyBinding",
		"metadata:",
		`  name: ${namespace}-session-eci`,
	].join("\n");

/** Writes evidence/config files and returns the env plus read-only `kubectl get` answers. */
export async function writeNetworkPolicyEvidence(directory, options) {
	const { namespace, namespaceUid, kubeSystemNamespaceUid } = options;
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
			placement: { architecture: "amd64", legacyUnplaced: "reject" },
			nodes: [{ name: nodeName, uid: nodeUid }],
			targets: [],
			probes: [
				{
					destination: {
						pod: "probe-target",
						uid: "55555555-5555-4555-8555-555555555555",
						nodeName,
						port: 3003,
					},
					policyUid: "66666666-6666-4666-8666-666666666666",
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
		},
		sessionEci: sessionEciAdmission(namespace),
	};
}
