#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// This probe has no user data, model Key or business authority.
const namespace = process.env.ACK_NAMESPACE ?? "agent-infra";
const image = process.env.ACK_RUNTIME_IMAGE ?? "";
const kubeconfig = process.env.ACK_KUBECONFIG;
const driver = process.env.ACK_RUNTIME_DRIVER ?? "codex";
const runtimeClassName = process.env.ACK_RUNTIME_CLASS ?? "";
if (
	!kubeconfig || driver !== "codex" ||
	!/^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/.test(image) ||
	!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace) ||
	(runtimeClassName !== "" && (runtimeClassName.length > 253 || !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(runtimeClassName)))
) throw new Error("Set ACK_KUBECONFIG, ACK_RUNTIME_IMAGE to a manifest Digest and ACK_RUNTIME_DRIVER=codex; ACK_RUNTIME_CLASS must be a valid RuntimeClass name when set");

const placement = process.env.ACK_RUNTIME_PLACEMENT_FILE
	? JSON.parse(readFileSync(process.env.ACK_RUNTIME_PLACEMENT_FILE, "utf8"))
	: {};
if (Object.keys(placement).some((key) => !["labels", "annotations", "nodeSelector", "tolerations"].includes(key)))
	throw new Error("Placement permits only labels, annotations, nodeSelector and tolerations");
const owner = randomUUID();
const name = `ack-runtime-preflight-${owner.slice(0, 8)}`;
const ownershipLabel = "agent-infra.agora.io/runtime-preflight";
const kubectl = (args, input) => execFileSync(process.env.KUBECTL_BIN ?? "kubectl", [
	"--kubeconfig", kubeconfig, "--namespace", namespace, ...args,
], { encoding: "utf8", input, timeout: 190_000, stdio: ["pipe", "pipe", "pipe"] });
let stage = "create";
const scope = runtimeClassName ? "codex-native-namespace" : "codex-landlock-installation";
console.log(JSON.stringify({ scope, probePod: name, ...(runtimeClassName ? { runtimeClassName } : {}) }));
try {
	const pod = {
		apiVersion: "v1", kind: "Pod",
		metadata: { name, labels: { ...placement.labels, [ownershipLabel]: owner }, annotations: placement.annotations },
		spec: {
			restartPolicy: "Never", automountServiceAccountToken: false,
			nodeSelector: placement.nodeSelector, tolerations: placement.tolerations,
			...(runtimeClassName ? { runtimeClassName } : {}),
			imagePullSecrets: process.env.ACK_IMAGE_PULL_SECRET ? [{ name: process.env.ACK_IMAGE_PULL_SECRET }] : [],
			securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
			containers: [{ name: "probe", image, command: ["/bin/sh", "-c", "sleep 180"],
				resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "2Gi" } },
				securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
			}],
		},
	};
	kubectl(["create", "-f", "-"], JSON.stringify(pod));
	stage = "scheduling-and-pull";
	kubectl(["wait", "--for=condition=Ready", `pod/${name}`, "--timeout=120s"]);
	const createdPod = JSON.parse(kubectl(["get", "pod", name, "-o", "json"]));
	if (createdPod.metadata.labels[ownershipLabel] !== owner || createdPod.spec.containers[0].image !== image || createdPod.spec.runtimeClassName !== (runtimeClassName || undefined))
		throw new Error("Probe ownership or image changed");
	stage = runtimeClassName ? "native-namespace" : "landlock-installation";
	const command = runtimeClassName
		? ["bwrap", "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/bin/true"]
		: ["setpriv", "--no-new-privs", "--landlock-access", "fs:ioctl-dev", "--", "/bin/true"];
	kubectl(["exec", name, "--", ...command]);
	console.log(JSON.stringify({ status: "passed", scope, image, node: createdPod.spec.nodeName,
		businessConversationVerified: false, networkIsolationVerified: false }));
} catch {
	console.error(JSON.stringify({ status: "failed", stage, probePod: name, hint: runtimeClassName
		? "Check RuntimeClass handler/node pool, image pull and bwrap user/mount/pid namespace support; Pod health alone is insufficient"
		: "Check scheduling/image pull, setpriv and enforceable Landlock ABI 5; Pod health alone is insufficient" }));
	process.exitCode = 1;
} finally {
	// A create request that timed out or lost its response may still have persisted the
	// Pod, so cleanup always probes for it instead of trusting a success flag.
	try {
		const raw = kubectl(["get", "pod", name, "--ignore-not-found", "-o", "json"]);
		if (raw.trim()) {
			const pod = JSON.parse(raw);
			if (pod.metadata.labels[ownershipLabel] !== owner) throw new Error("Probe ownership changed");
			kubectl(["delete", "pod", name, "--wait=false"]);
		}
	} catch {
		console.error(JSON.stringify({ status: "cleanup-failed", probePod: name, hint: "Inspect ownership before deleting" }));
		process.exitCode = 1;
	}
}
