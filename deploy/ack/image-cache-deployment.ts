import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";
import { ensureCachesWithReceipt, kubernetesBackend, parseCachePlan } from "./image-cache.ts";
import { privateJson } from "./private-input.ts";

export function deploymentCachePlan(sourceSha: string, runtime: any, templates: any, bodies: any[]) {
	const groups: string[][] = [];
	for (const manifest of [runtime, templates]) {
		assert(manifest.schemaVersion === 1 && manifest.commitSha === sourceSha && manifest.platform === "linux/amd64", "CACHE_DEPLOYMENT_SOURCE_MISMATCH");
		for (const value of Object.values(manifest.images ?? {}) as any[]) groups.push([`${value.repository}@${value.digest}`]);
	}
	assert(runtime.images?.runtimeHost && ["codex", "claude", "opencode", "pi"].every(name => templates.images?.[name]), "CACHE_DEPLOYMENT_INCOMPLETE");
	for (const body of bodies) {
		const source = body?.source;
		assert(source?.kind === "standard" || source?.kind === "custom", "CACHE_REQUEST_INVALID");
		if (source.kind === "standard") {
			assert(templates.images[source.templateId], "CACHE_TEMPLATE_UNKNOWN");
			continue;
		}
		if (typeof source.imageReference === "string") groups.push([source.imageReference]);
		else {
			assert(typeof source.manifest === "string", "CACHE_REQUEST_INVALID");
			let count = 0;
			for (const document of parseAllDocuments(source.manifest)) {
				assert(document.errors.length === 0, "CACHE_REQUEST_INVALID");
				const resource = document.toJSON();
				if (["Deployment", "StatefulSet", "Job"].includes(resource?.kind)) {
					const spec = resource.spec?.template?.spec;
					assert(Array.isArray(spec?.containers) && spec.containers.length > 0, "CACHE_REQUEST_INVALID");
					groups.push([...spec.containers, ...(spec.initContainers ?? [])].map(c => c.image));
					count++;
				}
			}
			assert(count > 0, "CACHE_REQUEST_INVALID");
		}
	}
	return parseCachePlan({ schemaVersion: 1, sourceSha, platform: "linux/amd64", groups });
}

async function main() {
	const [outputDirectory] = process.argv.slice(2);
	const env = process.env;
	assert(outputDirectory && env.ACK_SOURCE_SHA && env.ACK_RUNTIME_IMAGE_MANIFEST && env.ACK_TEMPLATE_IMAGE_MANIFEST, "CACHE_DEPLOYMENT_INPUT_REQUIRED");
	for (const name of ["image-cache.ready.json", "image-cache.values.json"]) await rm(`${outputDirectory}/${name}`, { force: true });
	const bodies = [];
	if (env.ACK_AGENT_REQUESTS_FILE) {
		const requests = await privateJson(env.ACK_AGENT_REQUESTS_FILE);
		assert(Array.isArray(requests.requests), "CACHE_REQUEST_INVALID");
		for (const request of requests.requests) bodies.push(await privateJson(request.bodyFile));
	}
	let plan = deploymentCachePlan(env.ACK_SOURCE_SHA, await privateJson(env.ACK_RUNTIME_IMAGE_MANIFEST), await privateJson(env.ACK_TEMPLATE_IMAGE_MANIFEST), bodies);
	if (bodies.some(body => body.source?.workspaceSnapshots?.length)) assert(env.ACK_IMAGE_CACHE_EXTRA_GROUPS_FILE, "CACHE_INIT_IMAGES_REQUIRED");
	if (env.ACK_IMAGE_CACHE_EXTRA_GROUPS_FILE) {
		const extra = parseCachePlan(await privateJson(env.ACK_IMAGE_CACHE_EXTRA_GROUPS_FILE));
		assert(extra.sourceSha === plan.sourceSha, "CACHE_DEPLOYMENT_SOURCE_MISMATCH");
		plan = parseCachePlan({ ...plan, groups: [...plan.groups, ...extra.groups] });
	}
	const namespace = env.ACK_NAMESPACE ?? "agent-infra";
	assert(/^[a-z0-9][a-z0-9-]*$/u.test(namespace) && env.ACK_KUBECONFIG, "CACHE_TARGET_INVALID");
	const previousRaw = execFileSync("kubectl", ["--kubeconfig", env.ACK_KUBECONFIG, "--request-timeout=30s", "get", "validatingadmissionpolicy", `${namespace}-session-image-cache`, "--ignore-not-found", "-o", "json"], { encoding: "utf8", timeout: 40_000, stdio: ["ignore", "pipe", "pipe"] });
	let previousEntries: { images: string[]; cacheId: string }[] = [];
	if (previousRaw.trim()) {
		const previous = JSON.parse(previousRaw);
		assert(previous.metadata?.labels?.["app.kubernetes.io/name"] === "agent-infra" && previous.spec?.matchConstraints?.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === namespace, "CACHE_POLICY_OWNER_MISMATCH");
		const entries = JSON.parse(previous.spec.variables.find((v: any) => v.name === "caches").expression);
		previousEntries = Object.entries(entries).map(([cacheId, images]) => ({ cacheId, images: images as string[] }));
		plan = parseCachePlan({ ...plan, groups: [...plan.groups, ...Object.values(entries)] });
	}
	await writeFile(`${outputDirectory}/image-cache.existing.values.json`, `${JSON.stringify({ sessionRuntimeScheduling: { imageCache: { required: previousEntries.length > 0, entries: previousEntries } } })}\n`, { mode: 0o600 });
	await writeFile(`${outputDirectory}/image-cache.plan.json`, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
	const receipt = await ensureCachesWithReceipt(
		plan,
		kubernetesBackend(
			env.ACK_KUBECONFIG,
			namespace,
			env.ACK_IMAGE_PULL_SECRET ?? "ack-ghcr-pull",
			Number(env.ACK_IMAGE_CACHE_SIZE_GIB ?? 30),
		),
		`${outputDirectory}/image-cache.ready.json`,
	);
	await writeFile(`${outputDirectory}/image-cache.values.json`, `${JSON.stringify({ sessionRuntimeScheduling: { imageCache: { required: true, entries: receipt.caches.map(c => ({ images: c.images, cacheId: c.id })) } } }, null, 2)}\n`, { mode: 0o600 });
	console.info(JSON.stringify({ status: receipt.status, cacheCount: receipt.caches.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("ACK_DEPLOYMENT_CACHE_NOT_READY"); process.exitCode = 1; });
