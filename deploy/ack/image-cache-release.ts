import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCachePlan, planFromIndexes } from "./image-cache.ts";

const repository = "AgoraIO-Extensions/agent-infra";
export function validateReleaseRun(run: any, id: string, attempt: string) {
	assert(/^\d+$/u.test(id) && /^\d+$/u.test(attempt), "CACHE_RUN_INVALID");
	assert(String(run.id) === id && String(run.run_attempt) === attempt && run.status === "completed" && run.conclusion === "success", "CACHE_RUN_NOT_SUCCESSFUL");
	assert(run.repository?.full_name === repository && run.head_repository?.full_name === repository && run.path === ".github/workflows/publish-images.yml", "CACHE_RUN_UNTRUSTED");
	assert((run.event === "workflow_dispatch" && run.head_branch === "main") || (run.event === "push" && /^v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/u.test(run.head_branch)), "CACHE_RUN_UNTRUSTED");
	const parts = run.display_title?.split("|").map((part: string) => part.trim());
	assert(parts?.length === 4 && parts[0] === run.event && parts[1] === "publish-images" && parts[2] === run.head_branch && /^[a-f0-9]{40}$/u.test(parts[3]), "CACHE_RUN_SOURCE_INVALID");
	return parts[3] as string;
}

async function main() {
	const [id, attempt, output] = process.argv.slice(2);
	assert(output, "CACHE_RUN_INVALID");
	if (process.env.ACK_DEPLOYMENT_CACHE_PLAN) {
		assert(process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && process.env.ACK_DEPLOYMENT_CACHE_PLAN.length <= 20_000, "CACHE_DEPLOYMENT_PLAN_UNTRUSTED");
		const plan = parseCachePlan(JSON.parse(process.env.ACK_DEPLOYMENT_CACHE_PLAN));
		await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
		console.info(JSON.stringify({ sourceSha: plan.sourceSha, cacheCount: plan.groups.length, mode: "approved-deployment" }));
		return;
	}
	assert(/^\d+$/u.test(id ?? "") && /^\d+$/u.test(attempt ?? ""), "CACHE_RUN_INVALID");
	const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
	const run = JSON.parse(gh(["api", `repos/${repository}/actions/runs/${id}/attempts/${attempt}`]));
	const source = validateReleaseRun(run, id, attempt);
	const name = `published-indexes-${source}-${attempt}`;
	const pages = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repository}/actions/runs/${id}/artifacts?per_page=100`]));
	const artifacts = pages.flatMap((page: any) => page.artifacts).filter((artifact: any) => artifact.name === name);
	assert(artifacts.length === 1 && !artifacts[0].expired && artifacts[0].size_in_bytes > 0 && artifacts[0].size_in_bytes < 1_000_000, "CACHE_RELEASE_ARTIFACT_INVALID");
	const directory = await mkdtemp(join(tmpdir(), "ack-cache-release-"));
	gh(["run", "download", id, "--repo", repository, "--name", name, "--dir", directory]);
	const file = join(directory, "published-indexes.jsonl");
	const stat = await lstat(file);
	assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 1_000_000, "CACHE_RELEASE_ARTIFACT_INVALID");
	const plan = planFromIndexes(await readFile(file, "utf8"), source);
	await writeFile(output, `${JSON.stringify({ ...plan, publicationRunId: id, publicationAttempt: attempt, artifactId: artifacts[0].id }, null, 2)}\n`, { mode: 0o600 });
	console.info(JSON.stringify({ sourceSha: source, runId: id, attempt, cacheCount: plan.groups.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("ACK_CACHE_RELEASE_REJECTED"); process.exitCode = 1; });
