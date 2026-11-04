import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { privateJson } from "./private-input.ts";

export function cacheWorkerReady(deployment: any, pods: any[], image: string) {
	return deployment?.spec?.template?.spec?.containers?.some((c: any) => c.image === image) &&
		deployment.status?.observedGeneration === deployment.metadata?.generation &&
		deployment.status?.updatedReplicas === deployment.spec?.replicas &&
		deployment.status?.availableReplicas === deployment.spec?.replicas && pods.length > 0 &&
		pods.every(p => !p.metadata?.deletionTimestamp && p.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True") && p.spec?.containers?.every((c: any) => c.image === image) &&
			p.status?.containerStatuses?.length === p.spec?.containers?.length &&
			p.status.containerStatuses.every((c: any) => c.ready === true && c.imageID?.endsWith(`@${image.split("@")[1]}`)));
}

async function main() {
	const [action] = process.argv.slice(2);
	const env = process.env;
	assert(action === "check" && env.ACK_KUBECONFIG && env.ACK_IMAGE_MANIFEST && env.ACK_SOURCE_SHA, "CACHE_WORKER_INPUT_REQUIRED");
	const manifest = await privateJson(env.ACK_IMAGE_MANIFEST);
	assert(manifest.commitSha === env.ACK_SOURCE_SHA && manifest.platform === "linux/amd64" && manifest.images?.platformWorker, "CACHE_WORKER_SOURCE_MISMATCH");
	const target = manifest.images.platformWorker;
	const image = `${target.repository}@${target.digest}`;
	assert(/^ghcr\.io\/agoraio-extensions\/agent-infra\/platform-worker@sha256:[a-f0-9]{64}$/u.test(image), "CACHE_WORKER_IMAGE_INVALID");
	const namespace = env.ACK_NAMESPACE ?? "agent-infra";
	const command = (args: string[], input?: string) => execFileSync("kubectl", ["--kubeconfig", env.ACK_KUBECONFIG!, "--request-timeout=30s", "-n", namespace, ...args], { input, encoding: "utf8", timeout: 40_000, stdio: ["pipe", "pipe", "pipe"] });
	const deadline = Date.now();
	do {
		const deployment = JSON.parse(command(["get", "deployment", "agent-infra-worker", "-o", "json"]));
		const pods = JSON.parse(command(["get", "pods", "-l", "app.kubernetes.io/name=agent-infra,app.kubernetes.io/component=platform-worker", "-o", "json"])).items;
		if (cacheWorkerReady(deployment, pods, image)) {
			console.info(JSON.stringify({ status: "ready", sourceSha: env.ACK_SOURCE_SHA, image }));
			return;
		}
		assert(Date.now() < deadline, "CACHE_WORKER_UPGRADE_REQUIRED");
		await new Promise(resolve => setTimeout(resolve, 5_000));
	} while (true);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("ACK_CACHE_WORKER_NOT_COMPATIBLE"); process.exitCode = 1; });
