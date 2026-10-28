import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { privateBytes, privateJson } from "./private-input.ts";
import { validateTemplatePreflightJob } from "./template-model-preflight.mjs";

export async function prepareTemplatePreflight(listFile: string, manifestFile: string, evidenceDirectory: string, worktree: string, sourceSha: string, kubeconfig: string, namespace: string) {
	assert(/^[a-f0-9]{40}$/u.test(sourceSha) && isAbsolute(worktree) && isAbsolute(evidenceDirectory) && isAbsolute(kubeconfig));
	assert([worktree, evidenceDirectory, kubeconfig].every((value) => !/[\r\n\0]/u.test(value)));
	const stat = await lstat(evidenceDirectory);
	assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, "PREFLIGHT_OUTPUT_NOT_PRIVATE");
	const directory = await realpath(evidenceDirectory);
	let inGit = false;
	try { inGit = execFileSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === "true"; } catch {}
	assert(!inGit, "PREFLIGHT_OUTPUT_INSIDE_WORKTREE");
	const list = await privateJson(listFile);
	const manifest = await privateJson(manifestFile);
	assert(list.schemaVersion === 1 && Array.isArray(list.jobs) && list.jobs.length === 4 && new Set(list.jobs).size === 4);
	assert(manifest.schemaVersion === 1 && manifest.commitSha === sourceSha && manifest.platform === "linux/amd64");
	const seen = new Set();
	const jobs = [];
	const drivers = { codex: "codex", claude: "claude", opencode: "acp", pi: "pi" } as const;
	for (const file of list.jobs) {
		assert(typeof file === "string" && isAbsolute(file) && !/[\r\n\0]/u.test(file));
		const job = validateTemplatePreflightJob(await privateJson(file));
		const image = manifest.images?.[job.templateId];
		assert(!seen.has(job.templateId) && job.sourceCommit === sourceSha && job.kubeconfig === kubeconfig && job.namespace === namespace && image &&
			job.driver === drivers[job.templateId as keyof typeof drivers] && job.protocol === (job.templateId === "codex" ? "openai-responses-v1" : "anthropic-messages-v1") &&
			job.imageReference === `${image.repository}@${image.digest}` && job.imageDigest === image.digest, "PREFLIGHT_JOB_BINDING_INVALID");
		for (const key of ["kubeconfig", "grantPrivateKeyFile", "runtimeServiceTokenFile", "relayKeyFile"])
			await privateBytes(job[key]);
		seen.add(job.templateId);
		jobs.push(job);
	}
	assert.equal(seen.size, 4);
	const runDirectory = await mkdtemp(join(directory, "template-run-"));
	const files = [];
	for (const job of jobs) {
		const file = join(runDirectory, `${job.templateId}.job.json`);
		await writeFile(file, `${JSON.stringify({ ...job, worktree, outputDirectory: join(runDirectory, job.templateId) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		files.push(file);
	}
	return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [list, manifest, evidence, worktree] = process.argv.slice(2);
		const { ACK_SOURCE_SHA: source, ACK_KUBECONFIG: kubeconfig, ACK_NAMESPACE: namespace } = process.env;
		assert(source && kubeconfig && namespace);
		const files = await prepareTemplatePreflight(list, manifest, evidence, worktree, source, kubeconfig, namespace);
		// Private job paths are consumed by the shell via a mode-0600 list file.
		process.stdout.write(`${files.join("\n")}\n`);
	} catch {
		process.stderr.write("ACK_PREFLIGHT_PREPARATION_FAILED\n");
		process.exitCode = 1;
	}
}
