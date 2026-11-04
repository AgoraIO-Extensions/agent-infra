import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { cacheOwner, ensureCaches, hash, parseCachePlan, type CacheBackend } from "./image-cache.ts";

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/gu, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function signedParameters(fields: Record<string, string>, secret: string) {
	const canonical = Object.keys(fields).sort().map(key => `${encode(key)}=${encode(fields[key])}`).join("&");
	const signature = createHmac("sha1", `${secret}&`).update(`POST&%2F&${encode(canonical)}`).digest("base64");
	return new URLSearchParams({ ...fields, Signature: signature });
}

export function cloudBackend(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): CacheBackend {
	const key = env.ALIBABA_CLOUD_ACCESS_KEY_ID;
	const secret = env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
	const token = env.ALIBABA_CLOUD_SECURITY_TOKEN;
	assert(key && secret && token, "CACHE_SHORT_LIVED_IDENTITY_REQUIRED");
	assert(/^vsw-[a-z0-9]+$/u.test(env.ACK_CACHE_VSWITCH_ID ?? "") && /^sg-[a-z0-9]+$/u.test(env.ACK_CACHE_SECURITY_GROUP_ID ?? ""), "CACHE_NETWORK_INVALID");
	assert(env.GHCR_CACHE_TOKEN && env.GHCR_CACHE_USER, "CACHE_REGISTRY_IDENTITY_REQUIRED");
	const size = Number(env.ACK_IMAGE_CACHE_SIZE_GIB ?? 30);
	assert(Number.isInteger(size) && size >= 20 && size <= 100, "CACHE_SIZE_INVALID");
	const rpc = async (action: string, parameters: Record<string, string>) => {
		const body = signedParameters({ Format: "JSON", Version: "2018-08-08", Action: action, RegionId: "cn-hangzhou", AccessKeyId: key, SecurityToken: token, SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0", SignatureNonce: randomUUID(), Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"), ...parameters }, secret);
		const response = await request("https://eci.cn-hangzhou.aliyuncs.com/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(30_000), redirect: "error" });
		const result = await response.json() as any;
		assert(response.ok && !result.Code, "CACHE_CLOUD_REQUEST_FAILED");
		return result;
	};
	return {
		namePrefix: "agent-infra-published-imc",
		async get(name) {
			const matches: any[] = [];
			let next = "";
			const seen = new Set<string>();
			do {
				assert(!seen.has(next) && seen.size < 20, "CACHE_CLOUD_PAGINATION_INVALID");
				seen.add(next);
				const result = await rpc("DescribeImageCaches", { ImageCacheName: name, Limit: "100", ...(next ? { NextToken: next } : {}) });
				assert(Array.isArray(result.ImageCaches), "CACHE_CLOUD_RESPONSE_INVALID");
				matches.push(...result.ImageCaches.filter((cache: any) => cache.ImageCacheName === name));
				next = result.NextToken ?? "";
			} while (next);
			assert(matches.length <= 1, "CACHE_CLOUD_DUPLICATE");
			const cache = matches[0];
			if (!cache) return undefined;
			const owner = cache.Tags?.find((tag: any) => (tag.Key ?? tag.TagKey) === "agent-infra-cache-owner");
			return { name, id: cache.ImageCacheId, phase: cache.Status, images: cache.Images, owner: owner?.Value ?? owner?.TagValue, expiresAt: cache.ExpireDateTime };
		},
		async create(name, images) {
			const inventory = await rpc("DescribeImageCaches", { "Tag.1.Key": "agent-infra-cache-owner", "Tag.1.Value": cacheOwner, Limit: "100" });
			assert(Array.isArray(inventory.ImageCaches) && inventory.ImageCaches.length < 48 && !inventory.NextToken, "CACHE_BUDGET_EXCEEDED");
			for (const ref of images) {
				const [repository, expectedDigest] = ref.replace("ghcr.io/", "").split("@");
				const authorization = `Basic ${Buffer.from(`${env.GHCR_CACHE_USER}:${env.GHCR_CACHE_TOKEN}`).toString("base64")}`;
				const tokenResponse = await request(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`, { headers: { authorization }, signal: AbortSignal.timeout(30_000), redirect: "error" });
				assert(tokenResponse.ok, "CACHE_REGISTRY_AUTH_FAILED");
				const registryToken = (await tokenResponse.json() as any).token;
				assert(typeof registryToken === "string" && registryToken.length > 0, "CACHE_REGISTRY_AUTH_FAILED");
				const response = await request(`https://ghcr.io/v2/${repository}/manifests/${expectedDigest}`, { headers: { authorization: `Bearer ${registryToken}`, accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" }, signal: AbortSignal.timeout(30_000), redirect: "error" });
				assert(response.ok, "CACHE_REGISTRY_MANIFEST_FAILED");
				const bytes = Buffer.from(await response.arrayBuffer());
				assert(`sha256:${createHash("sha256").update(bytes).digest("hex")}` === expectedDigest, "CACHE_REGISTRY_DIGEST_MISMATCH");
				const manifest = JSON.parse(bytes.toString("utf8"));
				assert(!manifest.manifests && /^sha256:[a-f0-9]{64}$/u.test(manifest.config?.digest), "CACHE_ARCHITECTURE_MANIFEST_REQUIRED");
				const configResponse = await request(`https://ghcr.io/v2/${repository}/blobs/${manifest.config.digest}`, { headers: { authorization: `Bearer ${registryToken}` }, signal: AbortSignal.timeout(30_000) });
				assert(configResponse.ok, "CACHE_REGISTRY_CONFIG_FAILED");
				const configBytes = Buffer.from(await configResponse.arrayBuffer());
				assert(`sha256:${createHash("sha256").update(configBytes).digest("hex")}` === manifest.config.digest, "CACHE_REGISTRY_DIGEST_MISMATCH");
				const config = JSON.parse(configBytes.toString("utf8"));
				assert(config.os === "linux" && config.architecture === "amd64", "CACHE_ARCHITECTURE_MISMATCH");
			}
			await rpc("CreateImageCache", {
				ImageCacheName: name, ClientToken: hash({ name, images }), VSwitchId: env.ACK_CACHE_VSWITCH_ID!, SecurityGroupId: env.ACK_CACHE_SECURITY_GROUP_ID!, ImageCacheSize: String(size), AutoMatchImageCache: "true",
				"Tag.1.Key": "agent-infra-cache-owner", "Tag.1.Value": cacheOwner,
				"ImageRegistryCredential.1.Server": "ghcr.io", "ImageRegistryCredential.1.UserName": env.GHCR_CACHE_USER!, "ImageRegistryCredential.1.Password": env.GHCR_CACHE_TOKEN!,
				...Object.fromEntries(images.map((ref, i) => [`Image.${i + 1}`, ref])),
			});
		},
	};
}
async function main() {
	const [file, output] = process.argv.slice(2);
	assert(file && output, "CACHE_ARGUMENTS_INVALID");
	const plan = parseCachePlan(JSON.parse(await readFile(file, "utf8")));
	let completed: unknown[] = [];
	try {
		const result = await ensureCaches(plan, cloudBackend(), { onProgress: async caches => {
			completed = caches;
			await writeFile(output, `${JSON.stringify({ schemaVersion: 1, kind: "ack-image-cache", sourceSha: plan.sourceSha, status: "preparing", caches, businessVerified: false }, null, 2)}\n`, { mode: 0o600 });
		} });
		await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
		console.info(JSON.stringify({ status: result.status, cacheCount: result.caches.length }));
	} catch (error) {
		const code = error instanceof Error && /^CACHE_[A-Z_]+$/u.test(error.message) ? error.message : "CACHE_REQUEST_FAILED";
		await writeFile(output, `${JSON.stringify({ schemaVersion: 1, kind: "ack-image-cache", sourceSha: plan.sourceSha, status: "failed", failureCode: code, caches: completed, businessVerified: false }, null, 2)}\n`, { mode: 0o600 });
		throw new Error(code);
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("ACK_CLOUD_CACHE_FAILED"); process.exitCode = 1; });
