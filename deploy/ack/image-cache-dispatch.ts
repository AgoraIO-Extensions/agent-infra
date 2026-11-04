import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, parseCachePlan, type CachePlan } from "./image-cache.ts";

const repo = "AgoraIO-Extensions/agent-infra";
export function verifyDispatchedReceipt(value: any, plan: CachePlan, now = Date.now()) {
	assert(value?.schemaVersion === 1 && value.kind === "ack-image-cache" && value.status === "ready" && value.sourceSha === plan.sourceSha && value.platform === plan.platform, "CACHE_RECEIPT_INVALID");
	const at = Date.parse(value.checkedAt);
	assert(Number.isFinite(at) && at <= now + 30_000 && at >= now - 300_000, "CACHE_RECEIPT_STALE");
	assert(Array.isArray(value.caches) && value.caches.length === plan.groups.length && value.caches.every((cache: any) => /^imc-[a-z0-9]+$/u.test(cache.id)), "CACHE_RECEIPT_INVALID");
	const expected = plan.groups.map(group => hash([...group].sort())).sort();
	const actual = value.caches.map((cache: any) => hash([...cache.images].sort())).sort();
	assert(hash(expected) === hash(actual), "CACHE_RECEIPT_IMAGES_MISMATCH");
	return value;
}

export async function dispatchCachePreparation(input: CachePlan) {
	const plan = parseCachePlan(input);
	const requestId = randomUUID();
	const gh = (args: string[], stdin?: string) => {
		try { return execFileSync("gh", args, { input: stdin, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }); }
		catch { throw new Error("CACHE_WORKFLOW_REQUEST_FAILED"); }
	};
	const sleep = () => new Promise(resolve => setTimeout(resolve, 10_000));
	gh(["api", "--method", "POST", `repos/${repo}/actions/workflows/ack-image-cache.yml/dispatches`, "--input", "-"], JSON.stringify({ ref: "main", inputs: { request_id: requestId, deployment_plan: JSON.stringify(plan) } }));
	const deadline = Date.now() + 30 * 60_000;
	let run: any;
	while (!run) {
		assert(Date.now() < deadline, "CACHE_WORKFLOW_NOT_OBSERVED");
		const data = JSON.parse(gh(["api", `repos/${repo}/actions/workflows/ack-image-cache.yml/runs?event=workflow_dispatch&branch=main&per_page=100`]));
		const matches = data.workflow_runs.filter((entry: any) => entry.display_title === `workflow_dispatch | ack-image-cache | main | ${requestId}`);
		assert(matches.length <= 1, "CACHE_WORKFLOW_DUPLICATE");
		run = matches[0];
		if (!run) await sleep();
	}
	console.info(JSON.stringify({ cacheWorkflowRunId: run.id, requestId }));
	while (run.status !== "completed") {
		assert(Date.now() < deadline, "CACHE_WORKFLOW_TIMEOUT");
		await sleep();
		run = JSON.parse(gh(["api", `repos/${repo}/actions/runs/${run.id}`]));
	}
	assert(run.conclusion === "success" && run.head_branch === "main" && run.path === ".github/workflows/ack-image-cache.yml", "CACHE_WORKFLOW_FAILED");
	const directory = await mkdtemp(join(tmpdir(), "ack-cache-ready-"));
	gh(["run", "download", String(run.id), "--repo", repo, "--name", `ack-cache-ready-${run.run_attempt}`, "--dir", directory]);
	const receipt = verifyDispatchedReceipt(JSON.parse(await readFile(join(directory, "cache-ready.json"), "utf8")), plan);
	return { ...receipt, cacheWorkflowRunId: run.id, cacheWorkflowAttempt: run.run_attempt };
}
