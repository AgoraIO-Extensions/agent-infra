import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, lstat, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCachePlan } from "./image-cache.ts";
import { ensureCachesWithReceipt, kubernetesBackend } from "./image-cache.ts";

const repository = "AgoraIO-Extensions/agent-infra";
const workflow = "ack-image-cache.yml";
export type PlanRun = { databaseId: number; headSha: string; attempt: number; status: string; conclusion: string; event: string; createdAt: string };
export type PlanArtifact = { id: number; name: string; sizeInBytes: number; expired: boolean };

export function selectLatestPlanRun(runs: PlanRun[], defaultHead: string) {
	return [...runs].filter(run => run.status === "completed" && run.conclusion === "success" && (defaultHead === "*" || run.headSha === defaultHead) && /^[a-f0-9]{40}$/u.test(run.headSha) && ["workflow_dispatch", "workflow_run"].includes(run.event)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}
export function validatePlanArtifact(artifact: PlanArtifact, expectedName: string) {
	assert(artifact.name === expectedName && !artifact.expired && artifact.sizeInBytes > 0 && artifact.sizeInBytes < 1_000_000, "CACHE_PLAN_ARTIFACT_INVALID");
}
export function validatePlanWorkflowRun(run: any, defaultHead: string) {
	assert(String(run.head_sha) === defaultHead && run.status === "completed" && run.conclusion === "success", "CACHE_PLAN_RUN_INVALID");
	assert(run.path === ".github/workflows/ack-image-cache.yml" && run.repository?.full_name === repository && run.head_repository?.full_name === repository, "CACHE_PLAN_RUN_UNTRUSTED");
	assert(run.head_branch === "main" && (run.event === "workflow_dispatch" || run.event === "workflow_run"), "CACHE_PLAN_RUN_UNTRUSTED");
}
function command(args: string[], options: { cwd?: string; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}) {
	return execFileSync(args[0], args.slice(1), { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: 120_000, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function privatePath(value: string, name: string) { assert(value && value.startsWith("/"), `${name}_PATH_INVALID`); return value; }
async function acquireLock(path: string) {
	try { const handle = await open(path, "wx", 0o600); await handle.writeFile(`${process.pid}\n`); return handle; }
	catch { throw new Error("CACHE_PREWARM_ALREADY_RUNNING"); }
}
async function atomicJson(path: string, value: unknown) {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}
export async function runOnce(env = process.env) {
	const stateDir = privatePath(env.ACK_AUTO_PREWARM_STATE_DIR ?? "", "ACK_AUTO_PREWARM_STATE_DIR");
	const dryRun = env.ACK_AUTO_PREWARM_DRY_RUN === "true";
	const kubeconfig = dryRun ? "" : privatePath(env.ACK_KUBECONFIG ?? "", "ACK_KUBECONFIG");
	const namespace = env.ACK_NAMESPACE ?? "agent-infra";
	assert(/^[a-z0-9][a-z0-9-]*$/u.test(namespace), "CACHE_TARGET_INVALID");
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	const lock = await acquireLock(join(stateDir, "prewarm.lock"));
	try {
		const defaultHead = command(["gh", "api", `repos/${repository}/git/ref/heads/main`, "--jq", ".object.sha"]);
		const runs = JSON.parse(command(["gh", "run", "list", "--repo", repository, "--workflow", workflow, "--status", "success", "--limit", "20", "--json", "databaseId,headSha,attempt,status,conclusion,event,createdAt"])) as PlanRun[];
		const run = selectLatestPlanRun(runs, "*");
		if (!run) return { status: "idle", reason: "NO_SUCCESSFUL_PLAN" };
		validatePlanWorkflowRun(JSON.parse(command(["gh", "api", `repos/${repository}/actions/runs/${run.databaseId}`])), run.headSha);
		const artifacts = JSON.parse(command(["gh", "api", `repos/${repository}/actions/runs/${run.databaseId}/artifacts?per_page=100`])) as { artifacts: PlanArtifact[] };
		const expectedName = `ack-cache-plan-${run.attempt}`;
		const matching = artifacts.artifacts.filter(artifact => artifact.name === expectedName).map(artifact => ({ ...artifact, sizeInBytes: (artifact as any).sizeInBytes ?? (artifact as any).size_in_bytes }));
		assert(matching.length === 1, "CACHE_PLAN_ARTIFACT_INVALID");
		validatePlanArtifact(matching[0], expectedName);
		const runDir = join(stateDir, `run-${run.databaseId}-attempt-${run.attempt}`);
		await mkdir(runDir, { recursive: true, mode: 0o700 });
		// gh refuses to extract over an existing file. Isolate each download so
		// the next timer tick can revalidate and resume the same run safely.
		const downloadDir = await mkdtemp(join(stateDir, "download-"));
		let plan;
		let downloadedPlan;
		try {
			command(["gh", "run", "download", String(run.databaseId), "--repo", repository, "--name", expectedName, "--dir", downloadDir]);
			const file = join(downloadDir, "cache-plan.json");
			const stat = await lstat(file);
			assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 1_000_000, "CACHE_PLAN_ARTIFACT_INVALID");
			downloadedPlan = JSON.parse(await readFile(file, "utf8"));
			plan = parseCachePlan(downloadedPlan);
		} finally {
			await rm(downloadDir, { recursive: true, force: true });
		}
		const planFile = join(runDir, "cache-plan.json");
		await atomicJson(planFile, downloadedPlan);
		assert(/^[a-f0-9]{40}$/u.test(plan.sourceSha), "CACHE_PLAN_SOURCE_INVALID");
		await atomicJson(join(runDir, "run.json"), { ...run, artifact: matching[0], plan: { sourceSha: plan.sourceSha, groups: plan.groups.length } });
		if (dryRun) return { status: "plan-ready", runId: run.databaseId, runAttempt: run.attempt, sourceSha: plan.sourceSha, cacheCount: plan.groups.length, planFile };
		const receipt = join(runDir, "cache-ready.json");
		const cacheSizeGiB = Number(env.ACK_IMAGE_CACHE_SIZE_GIB ?? 30);
		const timeoutMs = Number(env.ACK_IMAGE_CACHE_TIMEOUT_MS ?? 1_800_000);
		const concurrency = Number(env.ACK_IMAGE_CACHE_CONCURRENCY ?? 6);
		assert(Number.isFinite(cacheSizeGiB) && cacheSizeGiB > 0, "ACK_IMAGE_CACHE_SIZE_GIB_INVALID");
		assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "ACK_IMAGE_CACHE_TIMEOUT_MS_INVALID");
		assert(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 8, "ACK_IMAGE_CACHE_CONCURRENCY_INVALID");
		const ready = await ensureCachesWithReceipt(plan, kubernetesBackend(kubeconfig, namespace, env.ACK_IMAGE_PULL_SECRET ?? "ack-ghcr-pull", cacheSizeGiB), receipt, { timeoutMs, concurrency });
		assert(ready.status === "ready" && ready.sourceSha === plan.sourceSha && ready.caches.length === plan.groups.length, "CACHE_PREWARM_INCOMPLETE");
		await atomicJson(join(stateDir, "last-success.json"), { runId: run.databaseId, runAttempt: run.attempt, sourceSha: plan.sourceSha, receipt, completedAt: new Date().toISOString() });
		return { status: "ready", runId: run.databaseId, runAttempt: run.attempt, sourceSha: plan.sourceSha, cacheCount: ready.caches.length, receipt };
	} finally {
		await lock.close();
		try { await unlink(join(stateDir, "prewarm.lock")); } catch { /* retain the lock if release fails */ }
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runOnce().then(result => console.info(JSON.stringify(result))).catch(error => { const message = error instanceof Error ? error.message : ""; console.error(/^CACHE_[A-Z_]+$/u.test(message) ? message : "CACHE_PREWARM_FAILED"); process.exitCode = 1; });
