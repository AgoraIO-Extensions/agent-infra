import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const cacheOwner = "agent-infra-release-cache-v1";
const digest = /^sha256:[a-f0-9]{64}$/u;
const image = /^ghcr\.io\/agoraio-extensions\/agent-infra\/[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/u;
export type CachePlan = { schemaVersion: 1; sourceSha: string; platform: "linux/amd64"; groups: string[][] };
export type CacheState = { name: string; id?: string; phase?: string; images: string[]; owner?: string; expiresAt?: string; deleting?: boolean };
export type CacheBackend = { namePrefix?: string; get(name: string): Promise<CacheState | undefined>; create(name: string, images: string[]): Promise<void> };
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function parseCachePlan(value: any): CachePlan {
	assert(value?.schemaVersion === 1 && /^[a-f0-9]{40}$/u.test(value.sourceSha) && value.platform === "linux/amd64", "CACHE_PLAN_INVALID");
	assert(Array.isArray(value.groups) && value.groups.length > 0 && value.groups.length <= 48, "CACHE_PLAN_INVALID");
	const groups = value.groups.map((group: unknown) => {
		assert(Array.isArray(group) && group.length > 0 && group.length <= 8 && group.every((ref) => typeof ref === "string" && image.test(ref)), "CACHE_IMAGE_INVALID");
		return [...new Set(group)].sort();
	});
	const uniqueGroups = [...new Map(groups.map((g: string[]) => [hash(g), g])).values()] as string[][];
	assert(uniqueGroups.length <= 24, "CACHE_GROUP_BUDGET_EXCEEDED");
	return { schemaVersion: 1, sourceSha: value.sourceSha, platform: "linux/amd64", groups: uniqueGroups };
}

export function planFromIndexes(lines: string, sourceSha: string): CachePlan {
	const rows = lines.trim().split("\n").map((line) => JSON.parse(line));
	const entries = rows.filter(entry => !entry.sourceTag);
	assert(entries.length === 6 && (rows.length === 6 || rows.length === 12), "CACHE_RELEASE_INCOMPLETE");
	const promotions = rows.filter(entry => entry.sourceTag);
	assert(new Set(promotions.map(entry => entry.reference)).size === promotions.length, "CACHE_RELEASE_INCOMPLETE");
	for (const promotion of promotions) {
		const original = entries.find(entry => entry.reference === `${promotion.reference?.replace(/:latest$/u, "")}:${promotion.sourceTag}`);
		assert(promotion.commitSha === sourceSha && promotion.reference?.endsWith(":latest") && original?.digest === promotion.digest && /^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(promotion.sourceTag), "CACHE_PROMOTION_INVALID");
	}
	const names = new Set(["agent-runtime-host", "agent-runtime-codex", "agent-runtime-claude", "agent-runtime-opencode", "agent-runtime-pi", "custom-agent-base"]);
	const groups: string[][] = [];
	for (const entry of entries) {
		assert(entry.commitSha === sourceSha && digest.test(entry.indexDigest) && entry.digest === entry.indexDigest, "CACHE_RELEASE_SOURCE_MISMATCH");
		const repository = entry.reference?.split(":")[0];
		const name = repository?.split("/").at(-1);
		assert(names.delete(name) && digest.test(entry.platformDigests?.["linux/amd64"]), "CACHE_RELEASE_INCOMPLETE");
		assert(entry.reference === `${repository}:release-${sourceSha}` || /^v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/u.test(entry.reference.slice(repository.length + 1)), "CACHE_RELEASE_TAG_INVALID");
		groups.push([`${repository}@${entry.platformDigests["linux/amd64"]}`]);
	}
	assert(names.size === 0, "CACHE_RELEASE_INCOMPLETE");
	return parseCachePlan({ schemaVersion: 1, sourceSha, platform: "linux/amd64", groups });
}

export function cacheName(images: string[], prefix = "agent-infra-imc") {
	assert(/^[a-z0-9-]{1,40}$/u.test(prefix), "CACHE_NAME_INVALID");
	return `${prefix}-${hash({ platform: "linux/amd64", images: [...images].sort() }).slice(0, 32)}`;
}

export function assertCacheReady(cache: CacheState, images: string[], now = Date.now()) {
	assert(cache.owner === cacheOwner && hash([...cache.images].sort()) === hash([...images].sort()), "CACHE_IDENTITY_MISMATCH");
	assert(!cache.deleting && cache.phase === "Ready" && /^imc-[a-z0-9]+$/u.test(cache.id ?? ""), "CACHE_NOT_READY");
	assert(!cache.expiresAt || (Number.isFinite(Date.parse(cache.expiresAt)) && Date.parse(cache.expiresAt) > now + 300_000), "CACHE_EXPIRED");
}

export async function ensureCaches(plan: CachePlan, backend: CacheBackend, options: { timeoutMs?: number; checkOnly?: boolean; sleep?: (ms: number) => Promise<void>; now?: () => number; onProgress?: (caches: { name: string; id: string; images: string[] }[]) => Promise<void> } = {}) {
	plan = parseCachePlan(plan);
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? 1_200_000;
	assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1_800_000, "CACHE_TIMEOUT_INVALID");
	const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const deadline = now() + timeoutMs;
	const results: { name: string; id: string; images: string[] }[] = [];
	for (const images of plan.groups) {
		let name = cacheName(images, backend.namePrefix);
		let cache = await backend.get(name);
		if (cache && ["Failed", "Expired", "UpdateFailed"].includes(cache.phase ?? "") ) {
			assert(cache.owner === cacheOwner && hash([...cache.images].sort()) === hash(images), "CACHE_IDENTITY_MISMATCH");
			name = `${name}-retry1`;
			cache = await backend.get(name);
		}
		if (!cache) {
			assert(!options.checkOnly, "CACHE_MISSING");
			assert(now() < deadline, "CACHE_TIMEOUT");
			await backend.create(name, images);
		}
		while (true) {
			cache = await backend.get(name);
			if (cache) {
				assert(cache.owner === cacheOwner && hash([...cache.images].sort()) === hash(images), "CACHE_IDENTITY_MISMATCH");
				if (cache.phase === "Ready") {
					assertCacheReady(cache, images, now());
					results.push({ name, id: cache.id!, images });
					await options.onProgress?.([...results]);
					break;
				}
				assert(!["Failed", "Expired", "UpdateFailed"].includes(cache.phase ?? ""), "CACHE_PREPARATION_FAILED");
			}
			assert(!options.checkOnly, "CACHE_NOT_READY");
			assert(now() < deadline, "CACHE_TIMEOUT");
			await sleep(Math.min(10_000, deadline - now()));
		}
	}
	// Earlier groups must still be valid after the final group finishes.
	for (const result of results) {
		const current = await backend.get(result.name);
		assert(current && current.id === result.id, "CACHE_IDENTITY_MISMATCH");
		assertCacheReady(current, result.images, now());
	}
	return { schemaVersion: 1, kind: "ack-image-cache", sourceSha: plan.sourceSha, platform: plan.platform, checkedAt: new Date(now()).toISOString(), status: "ready", caches: results, businessVerified: false };
}

export async function ensureCachesWithReceipt(plan: CachePlan, backend: CacheBackend, output: string, options: { checkOnly?: boolean } = {}) {
	let caches: { name: string; id: string; images: string[] }[] = [];
	const write = (status: string, reason?: string) => writeFile(output, `${JSON.stringify({ schemaVersion: 1, kind: "ack-image-cache", sourceSha: plan.sourceSha, platform: plan.platform, checkedAt: new Date().toISOString(), status, caches, businessVerified: false, ...(reason ? { reason } : {}) }, null, 2)}\n`, { mode: 0o600 });
	await write("preparing");
	try {
		const receipt = await ensureCaches(plan, backend, { ...options, onProgress: async progress => { caches = progress; await write("preparing"); } });
		await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		return receipt;
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		await write("failed", /^CACHE_[A-Z_]+$/u.test(message) ? message : "CACHE_PREPARATION_FAILED");
		throw new Error("ACK_IMAGE_CACHE_FAILED");
	}
}

export function kubernetesBackend(kubeconfig: string, namespace: string, pullSecret: string, sizeGiB = 30): CacheBackend {
	assert(kubeconfig && /^[a-z0-9][a-z0-9-]*$/u.test(namespace) && /^[a-z0-9][a-z0-9.-]*$/u.test(pullSecret), "CACHE_TARGET_INVALID");
	assert(Number.isInteger(sizeGiB) && sizeGiB >= 20 && sizeGiB <= 100, "CACHE_SIZE_INVALID");
	const command = (args: string[], input?: string) => {
		try { return execFileSync("kubectl", ["--kubeconfig", kubeconfig, "--request-timeout=30s", ...args], { input, encoding: "utf8", timeout: 40_000, stdio: ["pipe", "pipe", "pipe"] }); }
		catch { throw new Error("CACHE_KUBERNETES_REQUEST_FAILED"); }
	};
	return {
		async get(name) {
			const raw = command(["get", "imagecache", "-n", namespace, name, "--ignore-not-found", "-o", "json"]);
			if (!raw.trim()) return undefined;
			const value = JSON.parse(raw);
			return { name: value.metadata.name, owner: value.metadata.labels?.["agent-infra.agora.io/cache-owner"], images: value.spec.images, phase: value.status?.phase, id: value.status?.imageCacheId, expiresAt: value.status?.expireDateTime, deleting: Boolean(value.metadata.deletionTimestamp) };
		},
		async create(name, images) {
			const inventory = JSON.parse(command(["get", "imagecache", "-n", namespace, "-l", `agent-infra.agora.io/cache-owner=${cacheOwner}`, "-o", "json"]));
			assert(Array.isArray(inventory.items) && inventory.items.length < 48, "CACHE_OBJECT_BUDGET_EXCEEDED");
			command(["create", "-n", namespace, "-f", "-"], JSON.stringify({ apiVersion: "eci.alibabacloud.com/v1", kind: "ImageCache", metadata: { name, labels: { "agent-infra.agora.io/cache-owner": cacheOwner }, annotations: { "k8s.aliyun.com/imc-enable-reuse": "true" } }, spec: { images, imagePullSecrets: [`${namespace}:${pullSecret}`], imageCacheSize: sizeGiB } }));
		},
	};
}

async function main() {
	const [action, file, output] = process.argv.slice(2);
	assert(file && output, "CACHE_ARGUMENTS_INVALID");
	if (action === "plan-release") {
		const plan = planFromIndexes(await readFile(file, "utf8"), process.env.ACK_SOURCE_SHA ?? "");
		await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
		return;
	}
	assert(action === "ensure" || action === "check", "CACHE_ARGUMENTS_INVALID");
	const plan = parseCachePlan(JSON.parse(await readFile(file, "utf8")));
	assert(plan.sourceSha === process.env.ACK_SOURCE_SHA, "CACHE_RELEASE_SOURCE_MISMATCH");
	const backend = kubernetesBackend(process.env.ACK_KUBECONFIG ?? "", process.env.ACK_NAMESPACE ?? "", process.env.ACK_IMAGE_PULL_SECRET ?? "ack-ghcr-pull", Number(process.env.ACK_IMAGE_CACHE_SIZE_GIB ?? 30));
	const timeoutMs = Number(process.env.ACK_IMAGE_CACHE_TIMEOUT_MS ?? 1_200_000);
	const receipt = await ensureCachesWithReceipt(plan, backend, output, { checkOnly: action === "check", timeoutMs });
	console.info(JSON.stringify({ status: "ready", cacheCount: receipt.caches.length, sourceSha: plan.sourceSha }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("ACK_IMAGE_CACHE_FAILED"); process.exitCode = 1; });
