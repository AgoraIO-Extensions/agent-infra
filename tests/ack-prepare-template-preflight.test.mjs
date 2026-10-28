import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareTemplatePreflight } from "../deploy/ack/prepare-template-preflight.ts";

const sourceSha = "a".repeat(40);
const namespace = "test-ack";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "ack-preflight-prepare-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const evidence = join(root, "evidence");
	await mkdir(evidence, { mode: 0o700 });
	const save = async (file, value) => {
		await writeFile(
			file,
			typeof value === "string" ? value : JSON.stringify(value),
			{ mode: 0o600 },
		);
		return file;
	};
	const material = await save(
		join(root, "private-material"),
		"private-material-not-for-logs",
	);
	const worktree = join(root, "current-worktree");
	const manifest = {
		schemaVersion: 1,
		commitSha: sourceSha,
		platform: "linux/amd64",
		images: {},
	};
	const jobs = [];
	for (const [index, [templateId, driver]] of [
		["codex", "codex"],
		["claude", "claude"],
		["opencode", "acp"],
		["pi", "pi"],
	].entries()) {
		const image = {
			repository: `registry.example.test/${templateId}`,
			digest: `sha256:${String(index + 1).repeat(64)}`,
		};
		manifest.images[templateId] = image;
		const file = join(root, `${templateId}.json`);
		await save(file, {
			schemaVersion: 1,
			scope: "isolated-template-real-model",
			kubeconfig: material,
			namespace,
			sourceCommit: sourceSha,
			templateId,
			driver,
			protocol:
				templateId === "codex"
					? "openai-responses-v1"
					: "anthropic-messages-v1",
			operatorApprovalRef: "authorized-deploy",
			worktree: join(root, "obsolete-worktree"),
			outputDirectory: join(root, "old-output"),
			imageReference: `${image.repository}@${image.digest}`,
			imageDigest: image.digest,
			modelId: "test-model",
			modelOptionId: "test:model",
			reasoningLevel: "high",
			configurationRevision: "rev-1",
			runtimeConfigVersion: "v1",
			approvedRelayOrigin: "https://relay.example.test",
			grantPrivateKeyFile: material,
			runtimeServiceTokenFile: material,
			relayKeyFile: material,
			expectedResourceLimits: { cpu: "1", memory: "2Gi" },
			placement: { nodeSelector: { type: "virtual-kubelet" } },
		});
		jobs.push(file);
	}
	const list = await save(join(root, "jobs.json"), { schemaVersion: 1, jobs });
	const manifestFile = await save(join(root, "manifest.json"), manifest);
	const run = () =>
		prepareTemplatePreflight(
			list,
			manifestFile,
			evidence,
			worktree,
			sourceSha,
			material,
			namespace,
		);
	return {
		root,
		evidence,
		worktree,
		jobs,
		list,
		manifest,
		manifestFile,
		material,
		save,
		run,
	};
}

test("each preflight run has fresh checkpoints and receipts while source jobs and earlier evidence remain intact", async (t) => {
	const f = await fixture(t);
	const original = await Promise.all(f.jobs.map((p) => readFile(p)));
	const first = await f.run();
	for (const file of first) {
		const job = JSON.parse(await readFile(file));
		assert.equal(job.worktree, f.worktree);
		assert.equal((await lstat(file)).mode & 0o777, 0o600);
		assert.equal((await lstat(dirname(file))).mode & 0o777, 0o700);
		await mkdir(job.outputDirectory, { mode: 0o700 });
		await f.save(join(job.outputDirectory, "in-flight.json"), {
			executionId: "old-execution",
		});
		await f.save(join(job.outputDirectory, "runtime-capacity.receipt.json"), {
			previousRun: true,
		});
	}
	const second = await f.run();
	assert.notEqual(dirname(first[0]), dirname(second[0]));
	for (const [i, file] of second.entries()) {
		const job = JSON.parse(await readFile(file));
		const prior = JSON.parse(await readFile(first[i]));
		assert.notEqual(job.outputDirectory, prior.outputDirectory);
		await assert.rejects(lstat(job.outputDirectory), { code: "ENOENT" });
		assert.deepEqual(
			JSON.parse(await readFile(join(prior.outputDirectory, "in-flight.json"))),
			{ executionId: "old-execution" },
		);
		assert.deepEqual(await readFile(f.jobs[i]), original[i]);
		assert.equal(job.imageReference, prior.imageReference);
		assert.equal(job.relayKeyFile, f.material);
	}
});

for (const scenario of [
	"wrong-source",
	"wrong-digest",
	"duplicate-template",
	"missing-template",
	"wrong-target",
	"wrong-driver",
	"malformed-job",
	"public-input",
	"symlink-input",
	"public-output",
	"git-output",
	"private-material-missing",
]) {
	test(`preflight preparation rejects ${scenario} before preparing any run`, async (t) => {
		const f = await fixture(t);
		const job = JSON.parse(await readFile(f.jobs[3]));
		if (scenario === "wrong-source") job.sourceCommit = "b".repeat(40);
		if (scenario === "wrong-digest")
			job.imageDigest = `sha256:${"b".repeat(64)}`;
		if (scenario === "duplicate-template") job.templateId = "codex";
		if (scenario === "wrong-target") job.namespace = "another-namespace";
		if (scenario === "wrong-driver") job.driver = "codex";
		if (scenario === "private-material-missing")
			job.relayKeyFile = join(f.root, "absent");
		await f.save(f.jobs[3], job);
		if (scenario === "missing-template")
			await f.save(f.list, { schemaVersion: 1, jobs: f.jobs.slice(1) });
		if (scenario === "malformed-job")
			await f.save(f.jobs[3], "invalid private-material-not-for-logs");
		if (scenario === "public-input") await chmod(f.jobs[3], 0o644);
		if (scenario === "public-output") await chmod(f.evidence, 0o755);
		if (scenario === "symlink-input") {
			await rm(f.jobs[3]);
			await symlink(f.jobs[0], f.jobs[3]);
		}
		if (scenario === "git-output") execFileSync("git", ["init", "-q", f.root]);
		await assert.rejects(f.run());
		assert.deepEqual(await readdir(f.evidence), []);
	});
}

test("preflight CLI errors do not expose malformed private input", async (t) => {
	const f = await fixture(t);
	await f.save(f.jobs[0], "private-material-not-for-logs: invalid JSON");
	const result = spawnSync(
		process.execPath,
		[
			"deploy/ack/prepare-template-preflight.ts",
			f.list,
			f.manifestFile,
			f.evidence,
			f.worktree,
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				ACK_SOURCE_SHA: sourceSha,
				ACK_NAMESPACE: namespace,
				ACK_KUBECONFIG: f.material,
			},
		},
	);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr.trim(), "ACK_PREFLIGHT_PREPARATION_FAILED");
});
