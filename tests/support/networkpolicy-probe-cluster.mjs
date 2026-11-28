import assert from "node:assert/strict";
import { labelsSatisfySelectorV1 } from "../../deploy/ack/networkpolicy-enforcement.mjs";
import {
	NetworkPolicyProbeError,
	probeLabelKeysV1,
} from "../../deploy/ack/networkpolicy-probe.mjs";

// Synthetic cluster for the probe pack tests: objects with UIDs, Deployment fan-out and
// ingress NetworkPolicy semantics. No real destination, credential or cluster is used.

export const nodeNames = [
	"virtual-kubelet-cn-hangzhou-i",
	"virtual-kubelet-cn-hangzhou-j",
];
const nodeUid = (n) => `4444444${n}-4444-4444-8444-444444444444`;
const provider = {
	key: "virtual-kubelet.io/provider",
	value: "alibabacloud",
	effect: "NoSchedule",
};
export const virtualNode = (name, n) => ({
	metadata: {
		name,
		uid: nodeUid(n),
		labels: {
			type: "virtual-kubelet",
			"kubernetes.io/arch": "amd64",
			"kubernetes.io/hostname": name,
		},
	},
	spec: { taints: [provider] },
});
export const ecsNode = {
	metadata: {
		name: "cn-hangzhou.10.0.0.12",
		uid: "99999999-9999-4999-8999-999999999999",
		labels: { "kubernetes.io/arch": "amd64" },
	},
	spec: {},
};

/** A tiny cluster: objects with UIDs, controller fan-out and ingress NetworkPolicy semantics. */
export function cluster({ enforce = true, leakNonWorker = false } = {}) {
	let counter = 0;
	const uid = () =>
		`${String(++counter).padStart(8, "0")}-0000-4000-8000-000000000000`;
	const objects = new Map();
	const nodes = [
		virtualNode(nodeNames[0], 1),
		virtualNode(nodeNames[1], 2),
		ecsNode,
	];
	const state = {
		namespaceUid: "11111111-1111-4111-8111-111111111111",
		kubeSystemUid: "22222222-2222-4222-8222-222222222222",
		calls: [],
		enforce,
		leakNonWorker,
		failProbeExec: false,
	};
	const key = (kind, name) => `${kind}/${name}`;
	const put = (kind, object) => {
		const stored = {
			...object,
			metadata: { ...object.metadata, uid: uid() },
		};
		objects.set(key(kind, object.metadata.name), stored);
		return stored;
	};
	const apply = (document) => {
		const labels = document.metadata.labels;
		if (document.kind === "NetworkPolicy")
			return put("networkpolicy", document);
		if (document.kind === "Pod") {
			const pod = put("pod", {
				...document,
				status: {
					phase: "Running",
					podIP: `10.1.0.${counter + 10}`,
					containerStatuses: [{ ready: true, restartCount: 0 }],
				},
				spec: { ...document.spec, nodeName: nodeNames[0] },
			});
			return pod;
		}
		const deployment = put("deployment", document);
		const replicaSet = put("replicaset", {
			metadata: {
				name: `${document.metadata.name}-rs`,
				labels,
				ownerReferences: [{ kind: "Deployment", uid: deployment.metadata.uid }],
			},
		});
		const template = document.spec.template;
		const compute =
			template.metadata.labels["alibabacloud.com/acs"] === "true"
				? "acs"
				: "eci";
		put("pod", {
			metadata: {
				name: `${document.metadata.name}-pod`,
				labels: { ...template.metadata.labels, "pod-template-hash": "abc" },
				annotations: {
					...template.metadata.annotations,
					[compute === "acs"
						? "alibabacloud.com/instance-id"
						: "k8s.aliyun.com/eci-instance-id"]: `${compute}-probe${counter}`,
				},
				ownerReferences: [{ kind: "ReplicaSet", uid: replicaSet.metadata.uid }],
			},
			spec: {
				...template.spec,
				nodeName:
					template.spec.nodeName ??
					template.spec.nodeSelector["kubernetes.io/hostname"],
			},
			status: {
				phase: "Running",
				podIP: `10.1.0.${counter + 10}`,
				containerStatuses: [{ ready: true, restartCount: 0 }],
			},
		});
		return deployment;
	};
	const matches = (labels, selector) =>
		labelsSatisfySelectorV1(labels, selector);
	const kindOf = (name) =>
		({
			pods: "pod",
			pod: "pod",
			deployment: "deployment",
			deployments: "deployment",
			replicasets: "replicaset",
			networkpolicies: "networkpolicy",
			networkpolicy: "networkpolicy",
		})[name];
	const notFound = () => {
		throw Object.assign(new Error("NotFound"), {
			stderr: "Error from server (NotFound): not found",
		});
	};
	const kubectl = (args) => {
		state.calls.push(args);
		const [verb, resource, third] = args;
		const select = (kind) =>
			[...objects.entries()]
				.filter(([k]) => k.startsWith(`${kind}/`))
				.map(([, value]) => value);
		if (verb === "delete") {
			const kind = kindOf(resource);
			const object = objects.get(key(kind, third));
			if (!object) return notFound();
			objects.delete(key(kind, third));
			if (kind === "deployment")
				for (const k of [...objects.keys()])
					if (
						k.startsWith(`replicaset/${third}`) ||
						k.startsWith(`pod/${third}`)
					)
						objects.delete(k);
			return "";
		}
		assert.equal(verb, "get");
		if (resource === "namespace")
			return JSON.stringify({
				metadata: {
					name: third,
					uid:
						third === "kube-system" ? state.kubeSystemUid : state.namespaceUid,
				},
			});
		if (resource === "nodes") return JSON.stringify({ items: nodes });
		if (resource === "pods,deployments,replicasets")
			return JSON.stringify({ items: state.workers ?? [] });
		if (resource === "statefulsets,deployments,jobs") {
			// Agent-level controllers carry the production owner label; probe ones never do.
			return JSON.stringify({ items: [] });
		}
		const kind = kindOf(resource);
		if (args[2] === "-l") {
			const wanted = Object.fromEntries(
				args[3].split(",").map((pair) => pair.split("=")),
			);
			return JSON.stringify({
				items: select(kind).filter((item) =>
					Object.entries(wanted).every(
						([k, v]) => item.metadata.labels?.[k] === v,
					),
				),
			});
		}
		const object = objects.get(key(kind, third));
		return object ? JSON.stringify(object) : notFound();
	};
	// What the client in a source Pod would report.
	const exec = async ({ pod, host }) => {
		state.calls.push(["exec", pod]);
		if (state.failProbeExec)
			throw new NetworkPolicyProbeError("PROBE_EXEC_FAILED");
		const source = objects.get(key("pod", pod));
		const target = select("pod").find((item) => item.status.podIP === host);
		const policies = select("networkpolicy").filter((policy) =>
			matches(target.metadata.labels, policy.spec.podSelector),
		);
		const admitted =
			!state.enforce ||
			policies.length === 0 ||
			(source.metadata.labels[probeLabelKeysV1.source] === "other" &&
				state.leakNonWorker) ||
			policies.some((policy) =>
				(policy.spec.ingress ?? []).some((rule) =>
					(rule.from ?? []).some(
						(peer) =>
							peer.namespaceSelector === undefined &&
							matches(source.metadata.labels, peer.podSelector),
					),
				),
			);
		return JSON.stringify({ outcome: admitted ? "connected" : "timeout" });
		function select(kindName) {
			return [...objects.entries()]
				.filter(([k]) => k.startsWith(`${kindName}/`))
				.map(([, value]) => value);
		}
	};
	return { state, objects, kubectl, exec, apply, nodes };
}
