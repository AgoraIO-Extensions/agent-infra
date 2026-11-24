import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Copies standard images byte-for-byte from GHCR to the internal registry (workflow Spec §10.4).
const repository = "AgoraIO-Extensions/agent-infra";
const sourcePrefix = "ghcr.io/agoraio-extensions/agent-infra";
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const namePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const versionTag = /^v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/u;
const templateNames = ["agent-runtime-host", "agent-runtime-codex", "agent-runtime-claude", "agent-runtime-opencode", "agent-runtime-pi", "custom-agent-base"];
const platformNames = ["web", "platform-api", "platform-worker", "enterprise-directory-sync"];
const maximumReferences = 200;

export type MirrorImage = { name: string; digest: string; source: string };
export type MirrorPlan =
	| { schemaVersion: 1; status: "planned"; sourceSha?: string; images: MirrorImage[] }
	| { schemaVersion: 1; status: "skipped"; reason: string; sourceSha?: string; images: [] };
export type MirrorResult = { name: string; digest: string; status: "copied" | "present" | "failed"; reason?: string; durationSeconds: number };
export type MirrorReceipt = { schemaVersion: 1; status: "passed" | "failed" | "skipped"; reason?: string; sourceSha?: string; durationSeconds?: number; images: MirrorResult[] | [] };
export type MirrorRegistry = {
	/** Raw manifest bytes for a digest-pinned reference, or undefined when the registry does not have it. */
	manifest(reference: string): Buffer | string | undefined;
	copy(source: string, tag: string, pinned: string): void;
};

const sha256 = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function validatePublicationRun(run: any, id: string, attempt: string) {
	assert(/^\d+$/u.test(id) && /^\d+$/u.test(attempt), "MIRROR_RUN_INVALID");
	assert(String(run.id) === id && String(run.run_attempt) === attempt && run.status === "completed" && run.conclusion === "success", "MIRROR_RUN_NOT_SUCCESSFUL");
	assert(run.repository?.full_name === repository && run.head_repository?.full_name === repository && run.path === ".github/workflows/publish-images.yml", "MIRROR_RUN_UNTRUSTED");
	assert((run.event === "workflow_dispatch" && run.head_branch === "main") || (run.event === "push" && versionTag.test(run.head_branch)), "MIRROR_RUN_UNTRUSTED");
	const parts = run.display_title?.split("|").map((part: string) => part.trim());
	assert(parts?.length === 4 && parts[0] === run.event && parts[1] === "publish-images" && parts[2] === run.head_branch && /^[a-f0-9]{40}$/u.test(parts[3]), "MIRROR_RUN_SOURCE_INVALID");
	return parts[3] as string;
}

function indexImages(lines: string, names: string[], sourceSha: string): MirrorImage[] | "smoke" {
	const rows = lines.trim().split("\n").map((line) => JSON.parse(line));
	const entries = rows.filter((entry) => !entry.sourceTag);
	assert(entries.length === names.length, "MIRROR_RELEASE_INCOMPLETE");
	const expected = new Set(names);
	const images: MirrorImage[] = [];
	let smoke = false;
	for (const entry of entries) {
		assert(entry.commitSha === sourceSha && digestPattern.test(entry.indexDigest) && entry.digest === entry.indexDigest, "MIRROR_RELEASE_SOURCE_MISMATCH");
		const [imageRepository, tag] = String(entry.reference ?? "").split(":");
		const name = imageRepository?.slice(sourcePrefix.length + 1);
		assert(imageRepository === `${sourcePrefix}/${name}` && expected.delete(name), "MIRROR_RELEASE_INCOMPLETE");
		const digest = entry.platformDigests?.["linux/amd64"];
		assert(digestPattern.test(digest), "MIRROR_RELEASE_INCOMPLETE");
		if (tag?.startsWith("smoke-")) smoke = true;
		else assert(tag === `release-${sourceSha}` || versionTag.test(tag ?? ""), "MIRROR_RELEASE_TAG_INVALID");
		images.push({ name, digest, source: `${imageRepository}@${digest}` });
	}
	assert(expected.size === 0, "MIRROR_RELEASE_INCOMPLETE");
	return smoke ? "smoke" : images;
}

/** Template receipts are always published; Platform receipts only by full releases and tags. */
export function planFromPublication(templateLines: string, platformLines: string | undefined, sourceSha: string): MirrorPlan {
	const templates = indexImages(templateLines, templateNames, sourceSha);
	const platform = platformLines === undefined ? [] : indexImages(platformLines, platformNames, sourceSha);
	if (templates === "smoke" || platform === "smoke") return { schemaVersion: 1, status: "skipped", reason: "MIRROR_SMOKE_PUBLICATION", sourceSha, images: [] };
	return { schemaVersion: 1, status: "planned", sourceSha, images: [...templates, ...platform] };
}

export function parseMirrorReferences(text: string): MirrorPlan {
	const references = [...new Set(text.split(/[\s,]+/u).filter(Boolean))];
	assert(references.length > 0 && references.length <= maximumReferences, "MIRROR_REFERENCES_INVALID");
	const images = references.map((source) => {
		const [imageRepository, digest] = source.split("@");
		const name = imageRepository?.slice(sourcePrefix.length + 1) ?? "";
		assert(imageRepository === `${sourcePrefix}/${name}` && namePattern.test(name) && digestPattern.test(digest ?? ""), "MIRROR_REFERENCES_INVALID");
		return { name, digest, source };
	});
	return { schemaVersion: 1, status: "planned", images };
}

export function targetReference(prefix: string, image: Pick<MirrorImage, "name" | "digest">) {
	assert(/^[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(prefix), "MIRROR_PREFIX_INVALID");
	return { tag: `${prefix}/${image.name}:sha256-${image.digest.slice(7)}`, pinned: `${prefix}/${image.name}@${image.digest}` };
}

/** Results never carry the internal prefix or registry output: the receipt and summary are public. */
export function mirrorImages(plan: MirrorPlan, prefix: string, registry: MirrorRegistry, now = Date.now): MirrorReceipt {
	if (plan.status === "skipped") return { schemaVersion: 1, status: "skipped", reason: plan.reason, sourceSha: plan.sourceSha, images: [] };
	const started = now();
	const images: MirrorResult[] = plan.images.map((image) => {
		const begin = now();
		const result = (status: MirrorResult["status"], reason?: string): MirrorResult =>
			({ name: image.name, digest: image.digest, status, ...(reason ? { reason } : {}), durationSeconds: (now() - begin) / 1000 });
		const target = targetReference(prefix, image);
		const existing = registry.manifest(target.pinned);
		if (existing !== undefined) return sha256(existing) === image.digest ? result("present") : result("failed", "MIRROR_DIGEST_MISMATCH");
		try {
			registry.copy(image.source, target.tag, target.pinned);
		} catch {
			return result("failed", "MIRROR_COPY_FAILED");
		}
		const copied = registry.manifest(target.pinned);
		return copied !== undefined && sha256(copied) === image.digest ? result("copied") : result("failed", "MIRROR_DIGEST_MISMATCH");
	});
	return { schemaVersion: 1, status: images.every((image) => image.status !== "failed") ? "passed" : "failed", sourceSha: plan.sourceSha, durationSeconds: (now() - started) / 1000, images };
}

export function summaryMarkdown(receipt: MirrorReceipt) {
	const lines = ["## Mirror images", "", `- Status: ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`];
	if (receipt.sourceSha) lines.push(`- Source: \`${receipt.sourceSha}\``);
	if (receipt.durationSeconds !== undefined) lines.push(`- Duration: ${receipt.durationSeconds}s`);
	if (receipt.images.length) {
		lines.push("", "| Image | Digest | Result | Seconds |", "| --- | --- | --- | --- |");
		for (const image of receipt.images) lines.push(`| ${image.name} | \`${image.digest}\` | ${image.status}${image.reason ? ` (${image.reason})` : ""} | ${image.durationSeconds} |`);
	}
	return `${lines.join("\n")}\n`;
}

function command(file: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
	return execFileSync(file, args, { input: options.input, env: options.env, timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

async function planCommand(output: string) {
	const id = process.env.PUBLISH_RUN_ID ?? "";
	const attempt = process.env.PUBLISH_ATTEMPT ?? "";
	const references = process.env.MIRROR_REFERENCES ?? "";
	let plan: MirrorPlan;
	if (references.trim()) {
		assert(!id && !attempt, "MIRROR_ARGUMENTS_INVALID");
		plan = parseMirrorReferences(references);
	} else {
		const gh = (args: string[]) => command("gh", args).toString("utf8");
		const run = JSON.parse(gh(["api", `repos/${repository}/actions/runs/${id}/attempts/${attempt}`]));
		const sourceSha = validatePublicationRun(run, id, attempt);
		const pages = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repository}/actions/runs/${id}/artifacts?per_page=100`]));
		const artifacts = pages.flatMap((page: any) => page.artifacts);
		const directory = await mkdtemp(join(tmpdir(), "image-mirror-"));
		const receipt = async (name: string, file: string, required: boolean) => {
			const matches = artifacts.filter((artifact: any) => artifact.name === name);
			if (!required && matches.length === 0) return undefined;
			assert(matches.length === 1 && !matches[0].expired && matches[0].size_in_bytes > 0 && matches[0].size_in_bytes < 1_000_000, "MIRROR_RELEASE_ARTIFACT_INVALID");
			gh(["run", "download", id, "--repo", repository, "--name", name, "--dir", join(directory, name)]);
			const path = join(directory, name, file);
			const stat = await lstat(path);
			assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 1_000_000, "MIRROR_RELEASE_ARTIFACT_INVALID");
			return readFile(path, "utf8");
		};
		const templates = await receipt(`published-indexes-${sourceSha}-${attempt}`, "published-indexes.jsonl", true);
		const platform = await receipt(`published-platform-indexes-${sourceSha}-${attempt}`, "published-platform-indexes.jsonl", false);
		plan = planFromPublication(templates as string, platform, sourceSha);
	}
	await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
	console.info(JSON.stringify({ status: plan.status, sourceSha: plan.sourceSha, images: plan.images.length }));
}

async function copyCommand(planFile: string, output: string) {
	const plan = JSON.parse(await readFile(planFile, "utf8")) as MirrorPlan;
	assert(plan.schemaVersion === 1 && (plan.status === "planned" || plan.status === "skipped"), "MIRROR_PLAN_INVALID");
	if (plan.status === "planned") for (const image of plan.images) parseMirrorReferences(image.source);
	const prefix = process.env.MIRROR_REPOSITORY_PREFIX ?? "";
	const crane = process.env.CRANE_BIN ?? "crane";
	const config = await mkdtemp(join(tmpdir(), "image-mirror-auth-"));
	const env = { ...process.env, DOCKER_CONFIG: config };
	let receipt: MirrorReceipt;
	try {
		if (plan.status === "planned") {
			targetReference(prefix, plan.images[0] ?? { name: "probe", digest: `sha256:${"0".repeat(64)}` });
			command(crane, ["auth", "login", "ghcr.io", "--username", "github-actions", "--password-stdin"], { input: process.env.GHCR_TOKEN ?? "", env });
			command(crane, ["auth", "login", prefix.split("/")[0] as string, "--username", process.env.MIRROR_REGISTRY_USERNAME ?? "", "--password-stdin"], { input: process.env.MIRROR_REGISTRY_PASSWORD ?? "", env });
		}
		receipt = mirrorImages(plan, prefix, {
			manifest(reference) {
				try {
					return command(crane, ["manifest", reference], { env });
				} catch {
					return undefined;
				}
			},
			copy(source, tag) {
				command(crane, ["copy", source, tag], { env });
			},
		});
	} finally {
		await rm(config, { recursive: true, force: true });
	}
	await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(receipt));
	console.info(JSON.stringify({ status: receipt.status, images: receipt.images.length, durationSeconds: receipt.durationSeconds }));
	assert(receipt.status !== "failed", "MIRROR_FAILED");
}

async function main() {
	const [action, first, second] = process.argv.slice(2);
	if (action === "plan" && first && !second) return planCommand(first);
	if (action === "copy" && first && second) return copyCommand(first, second);
	throw new Error("MIRROR_ARGUMENTS_INVALID");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main().catch((error) => {
		const message = error instanceof Error ? error.message : "";
		console.error(/^MIRROR_[A-Z_]+$/u.test(message) ? message : "MIRROR_REJECTED");
		process.exitCode = 1;
	});
