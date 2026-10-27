import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

type RecordValue = Record<string, any>;
type Read = (args: string[]) => string;
const label = "agent-infra.agora.io/bootstrap-id";
const hash = (value: unknown) =>
	createHash("sha256").update(String(value ?? "")).digest("hex");
const resourceKinds = [
	"deploy", "statefulset", "pod", "job", "service", "configmap", "secret",
	"pvc", "ingress", "serviceaccount", "role", "rolebinding", "networkpolicy",
	"resourcequota",
];

function owned(resource: RecordValue, installationId: string, release: string) {
	return (
		resource.metadata?.labels?.[label] === installationId ||
		(resource.metadata?.labels?.["app.kubernetes.io/managed-by"] === "Helm" &&
			resource.metadata?.annotations?.["meta.helm.sh/release-name"] === release)
	);
}

function readiness(resource: RecordValue) {
	const conditions = resource.status?.conditions;
	return Array.isArray(conditions) && conditions.some(
		(condition: RecordValue) =>
			["Ready", "Available", "Complete"].includes(condition.type) &&
			condition.status === "True",
	);
}

export function createCleanupPlan(
	input: { namespace: string; clusterUid: string; namespaceUid: string; installationId: string; release: string },
	read: Read,
) {
	assert(/^[a-f0-9-]{36}$/u.test(input.clusterUid));
	assert(/^[a-f0-9-]{36}$/u.test(input.namespaceUid));
	assert(/^[a-f0-9-]{36}$/u.test(input.installationId));
	assert(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/u.test(input.namespace));
	assert(/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.release));
	const cluster = JSON.parse(read(["get", "namespace", "kube-system", "-o", "json"]));
	const namespace = JSON.parse(read(["get", "namespace", input.namespace, "-o", "json"]));
	assert(cluster.metadata?.uid === input.clusterUid);
	assert(namespace.metadata?.uid === input.namespaceUid);
	const resources: RecordValue[] = [];
	for (const kind of resourceKinds) {
		const value = JSON.parse(read(["-n", input.namespace, "get", kind, "-o", "json"]));
		assert(Array.isArray(value.items));
		resources.push(...value.items.map((resource: RecordValue) => ({
			kind,
			nameHash: hash(resource.metadata?.name),
			uidHash: hash(resource.metadata?.uid),
			owned: owned(resource, input.installationId, input.release),
			ready: readiness(resource),
		})));
	}
	const admission = [`${input.namespace}-session-eci`].flatMap((name) => {
		const result: RecordValue[] = [];
		for (const kind of ["mutatingadmissionpolicy", "mutatingadmissionpolicybinding"]) {
			const raw = read(["get", kind, name, "--ignore-not-found", "-o", "json"]);
			if (raw.trim()) {
				const resource = JSON.parse(raw);
				result.push({ kind, nameHash: hash(resource.metadata?.name), uidHash: hash(resource.metadata?.uid), owned: owned(resource, input.installationId, input.release) });
			}
		}
		return result;
	});
	const all = [...resources, ...admission];
	const foreignCount = all.filter((resource) => !resource.owned).length;
	return {
		schemaVersion: 1,
		kind: "ack-cleanup-plan",
		clusterHash: hash(input.clusterUid),
		namespaceHash: hash(input.namespace),
		namespaceUidHash: hash(input.namespaceUid),
		releaseHash: hash(input.release),
		installationHash: hash(input.installationId),
		resourceCount: all.length,
		foreignCount,
		deletionReady: foreignCount === 0,
		resources: all,
		dataRestoreVerified: false,
		businessVerified: false,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const config = JSON.parse(await readFile(process.argv[2], "utf8"));
		const kubeconfig = process.env.ACK_KUBECONFIG;
		assert(kubeconfig && config.namespace === process.env.ACK_NAMESPACE);
		const read: Read = (args) => execFileSync("kubectl", ["--kubeconfig", kubeconfig, "--request-timeout=20s", ...args], {
			encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
		});
		process.stdout.write(`${JSON.stringify(createCleanupPlan(config, read), null, 2)}\n`);
	} catch {
		process.stderr.write("ACK_CLEANUP_PLAN_FAILED\n");
		process.exitCode = 1;
	}
}
