import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { customValidationPlan } from "../deploy/ack/custom-validation.ts";

const sourceSha = "a".repeat(40);
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t, mode = "platform-adapter") {
	const root = await mkdtemp(join(tmpdir(), "ack-custom-validation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = join(root, "state");
	const evidence = join(root, "evidence");
	await mkdir(state, { mode: 0o700 });
	await mkdir(evidence, { mode: 0o700 });
	const body = {
		source: {
			kind: "custom",
			interactionMode: mode,
			imageReference: `registry.example.test/custom@sha256:${"b".repeat(64)}`,
		},
	};
	const bodyFile = join(root, "body.json");
	await writeFile(bodyFile, JSON.stringify(body), { mode: 0o600 });
	const request = {
		name: "custom-one",
		bodyFile,
		credentialFile: join(root, "unused-token"),
		idempotencyKey: "custom-one-create",
	};
	const origin = "https://platform.example.test";
	const config = { schemaVersion: 1, origin, requests: [request] };
	const requestsFile = join(root, "requests.json");
	await writeFile(requestsFile, JSON.stringify(config), { mode: 0o600 });
	const binding = {
		schemaVersion: 1,
		origin,
		sourceSha,
		requestHash: hash(
			JSON.stringify({
				origin,
				bodies: [
					{ name: request.name, body, idempotencyKey: request.idempotencyKey },
				],
			}),
		),
		agents: { [request.name]: { agentId: "private-agent-one", ready: true } },
	};
	const bindingFile = join(state, "agent-bindings.json");
	await writeFile(bindingFile, JSON.stringify(binding), { mode: 0o600 });
	const receipt = {
		result: "passed",
		commit: sourceSha,
		worktreeDirty: false,
		agentHash: hash("private-agent-one"),
		sessions: { owner: 200, other: 200 },
		requestedTurnCount: 3,
		completedTurnCount: 3,
		turns: [1, 2, 3].map((index) => ({
			index,
			result: "passed",
			stage: "completed",
			reload: "restored",
			crossUserReadStatus: 404,
			crossUserSseStatus: 404,
			sse: {
				observedFrames: [
					{ type: "text.delta", textLength: 1 },
					{ type: "execution.status", status: "completed" },
				],
			},
		})),
	};
	const receiptFile = join(evidence, "template-custom-custom-one.json");
	await writeFile(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
	const save = async (p, v) => writeFile(p, JSON.stringify(v), { mode: 0o600 });
	const run = (configs = []) =>
		customValidationPlan(requestsFile, state, evidence, sourceSha, configs);
	return {
		root,
		state,
		evidence,
		requestsFile,
		config,
		body,
		bodyFile,
		binding,
		bindingFile,
		receipt,
		receiptFile,
		save,
		run,
	};
}

test("custom ACP acceptance uses the bound three-turn receipt without an HTML probe", async (t) => {
	const f = await fixture(t);
	const result = await f.run();
	assert.equal(result.platformAdapterCount, 1);
	assert.equal(result.selfManagedCount, 0);
	assert.equal(result.webProbeCount, 0);
	assert.equal(result.pass, true);
	assert(!JSON.stringify(result).includes("private-agent-one"));
});

test("self-managed custom Agents still require a distinct Web probe config", async (t) => {
	const f = await fixture(t, "self-managed");
	await assert.rejects(f.run(), /CUSTOM_WEB_PROBES_REQUIRED/);
	const config = join(f.root, "web.json");
	await f.save(config, {
		url: "https://custom.example.test",
		imageDigest: `sha256:${"b".repeat(64)}`,
	});
	const result = await f.run([config]);
	assert.equal(result.selfManagedCount, 1);
	assert.equal(result.webProbeCount, 1);
	assert.equal(result.platformAdapterCount, 0);
});

test("bound own-entry configs select the current self-managed request and exact source", async (t) => {
	const f = await fixture(t, "self-managed");
	const file = join(f.root, "own-entry.json");
	await f.save(file, {
		schemaVersion: 1,
		sourceSha,
		requestName: "custom-one",
	});
	assert.equal((await f.run([file])).selfManagedCount, 1);
	for (const changed of [
		{ schemaVersion: 1, sourceSha, requestName: "unrelated-agent" },
		{ schemaVersion: 1, sourceSha: "b".repeat(40), requestName: "custom-one" },
		{ schemaVersion: 2, sourceSha, requestName: "custom-one" },
	]) {
		await f.save(file, changed);
		await assert.rejects(
			f.run([file]),
			/CUSTOM_ENTRY_REQUEST_BINDING_INVALID/u,
		);
	}
});

for (const failure of [
	"missing",
	"failed",
	"partial",
	"agent",
	"source",
	"dirty",
	"reload",
	"isolation",
	"stream",
]) {
	test(`custom conversation acceptance rejects ${failure} evidence`, async (t) => {
		const f = await fixture(t);
		if (failure === "missing") await rm(f.receiptFile);
		else {
			if (failure === "failed") f.receipt.result = "failed";
			if (failure === "partial") f.receipt.completedTurnCount = 2;
			if (failure === "agent") f.receipt.agentHash = hash("another-agent");
			if (failure === "source") f.receipt.commit = "c".repeat(40);
			if (failure === "dirty") f.receipt.worktreeDirty = true;
			if (failure === "reload") f.receipt.turns[2].reload = "missing";
			if (failure === "isolation") f.receipt.turns[2].crossUserSseStatus = 200;
			if (failure === "stream") f.receipt.turns[2].sse.observedFrames = [];
			await f.save(f.receiptFile, f.receipt);
		}
		await assert.rejects(f.run());
	});
}

test("changed requests, unknown modes, absent custom Agents and extra Web probes fail closed", async (t) => {
	const f = await fixture(t);
	const extra = join(f.root, "web.json");
	await f.save(extra, {});
	await assert.rejects(f.run([extra]), /CUSTOM_WEB_PROBE_COUNT_INVALID/);
	f.body.source.interactionMode = "unknown";
	await f.save(f.bodyFile, f.body);
	await assert.rejects(f.run());
	f.body.source = { kind: "standard", templateId: "codex" };
	await f.save(f.bodyFile, f.body);
	await assert.rejects(f.run());
	f.binding.agents["custom-one"].ready = false;
	await f.save(f.bindingFile, f.binding);
	await assert.rejects(f.run());
});

for (const mode of ["platform-adapter", "self-managed"]) {
	test(`real shell dispatch selects ${mode} validation without skipping required probes`, async (t) => {
		const f = await fixture(t, mode);
		const web = join(f.root, "web.json");
		const digest = `sha256:${"b".repeat(64)}`;
		await f.save(web, { imageDigest: digest });
		await f.save(join(f.evidence, "validated.json"), {
			resources: [{ images: [{ digestHash: hash(digest) }] }],
		});
		const source = await readFile(
			new URL("../deploy/ack/redeploy.sh", import.meta.url),
			"utf8",
		);
		const body = source.slice(
			source.indexOf("validate_custom_agents() {"),
			source.indexOf("\nvalidate() {"),
		);
		const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
		const result = spawnSync(
			"bash",
			[
				"-c",
				`
set -euo pipefail
umask 077
die() { echo "$*" >&2; exit 2; }
node() {
 case "$*" in
  *custom-agent-web-probe.ts*) echo web-probe >> ${quote(join(f.root, "calls"))}; echo '{"pass":true}' ;;
  *) ${quote(process.execPath)} "$@" ;;
 esac
}
repo_root=${quote(new URL("..", import.meta.url).pathname.replace(/\/$/, ""))}
evidence_dir=${quote(f.evidence)}
source_sha=${quote(sourceSha)}
configs_for_test=${quote(mode === "self-managed" ? web : "")}
unset ACK_CUSTOM_AGENT_CONFIGS
ACK_CUSTOM_AGENT_CONFIGS=$configs_for_test
${body}
validate_custom_agents
`,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					BASH_ENV: "/dev/null",
					ACK_AGENT_REQUESTS_FILE: f.requestsFile,
					ACK_AGENT_STATE_DIR: f.state,
					ACK_CUSTOM_AGENT_PROBE: "web",
					ACK_CUSTOM_AGENT_CONFIGS: mode === "self-managed" ? web : "",
				},
			},
		);
		assert.equal(result.status, 0, result.stderr);
		if (mode === "self-managed")
			assert.equal(
				(await readFile(join(f.root, "calls"), "utf8")).trim(),
				"web-probe",
			);
		else
			await assert.rejects(readFile(join(f.root, "calls")), { code: "ENOENT" });
	});
}
