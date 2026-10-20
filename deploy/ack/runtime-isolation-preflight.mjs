#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// This probe has no user data, model Key or business authority.
const namespace = process.env.ACK_NAMESPACE ?? "agent-infra";
const image = process.env.ACK_RUNTIME_IMAGE ?? "";
const kubeconfig = process.env.ACK_KUBECONFIG;
const driver = process.env.ACK_RUNTIME_DRIVER ?? "codex";
if (
	!kubeconfig || driver !== "codex" ||
	!/^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9._-]+)+@sha256:[a-f0-9]{64}$/.test(image) ||
	!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)
) throw new Error("Set ACK_KUBECONFIG, ACK_RUNTIME_IMAGE to a manifest Digest and ACK_RUNTIME_DRIVER=codex");

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
let created = false;
let stage = "create";
console.log(JSON.stringify({ scope: "codex-landlock-installation", probePod: name }));
try {
	kubectl(["create", "-f", "-"], JSON.stringify({
		apiVersion: "v1", kind: "Pod",
		metadata: { name, labels: { ...placement.labels, [ownershipLabel]: owner }, annotations: placement.annotations },
		spec: {
			restartPolicy: "Never", automountServiceAccountToken: false,
			nodeSelector: placement.nodeSelector, tolerations: placement.tolerations,
			imagePullSecrets: process.env.ACK_IMAGE_PULL_SECRET ? [{ name: process.env.ACK_IMAGE_PULL_SECRET }] : [],
			securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
			containers: [{ name: "probe", image, command: ["/bin/sh", "-c", "sleep 180"],
				resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "2Gi" } },
				securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
			}],
		},
	}));
	created = true;
	stage = "scheduling-and-pull";
	kubectl(["wait", "--for=condition=Ready", `pod/${name}`, "--timeout=120s"]);
	const pod = JSON.parse(kubectl(["get", "pod", name, "-o", "json"]));
	if (pod.metadata.labels[ownershipLabel] !== owner || pod.spec.containers[0].image !== image)
		throw new Error("Probe ownership or image changed");
	stage = "landlock-installation";
	kubectl(["exec", name, "--", "setpriv", "--no-new-privs", "--landlock-access", "fs:ioctl-dev", "--", "/bin/true"]);
	console.log(JSON.stringify({ status: "passed", scope: "codex-landlock-installation", image, node: pod.spec.nodeName,
		businessConversationVerified: false, networkIsolationVerified: false }));
} catch {
	console.error(JSON.stringify({ status: "failed", stage, probePod: name, hint: "Check scheduling/image pull, setpriv and enforceable Landlock ABI 5; Pod health alone is insufficient" }));
	process.exitCode = 1;
} finally {
	if (created) {
		try {
			const pod = JSON.parse(kubectl(["get", "pod", name, "-o", "json"]));
			if (pod.metadata.labels[ownershipLabel] !== owner) throw new Error("Probe ownership changed");
			kubectl(["delete", "pod", name, "--wait=false"]);
		} catch {
			console.error(JSON.stringify({ status: "cleanup-failed", probePod: name, hint: "Inspect ownership before deleting" }));
			process.exitCode = 1;
		}
	}
}
