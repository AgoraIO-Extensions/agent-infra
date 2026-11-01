import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindSessionReserves } from "../deploy/ack/bind-session-reserves.ts";

const sourceSha = "a".repeat(40);
const resources = {
	cpuMillis: 1000,
	memoryBytes: 2_147_483_648,
	storageBytes: 21_474_836_480,
};
const capacityResources = {
	requests: { cpu: "100m", memory: "128Mi" },
	limits: { cpu: "1", memory: "2Gi" },
};
const actualResourceConfigurationHash = createHash("sha256")
	.update(
		JSON.stringify({ resourceProfileRef: "ack-small", ...capacityResources }),
	)
	.digest("hex");

test("binds ready standard Agent IDs into a default-off reserve plan", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "ack-reserve-bind-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const save = async (name, value) => {
		const file = join(dir, name);
		await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
		});
		return file;
	};
	const plan = await save("plan.json", {
		schemaVersion: 1,
		sourceSha,
		enabled: false,
		revision: 1,
		namespace: "agent-infra",
		totalBudget: {
			cpuMillis: 16_000,
			memoryBytes: 34_359_738_368,
			storageBytes: 549_755_813_888,
		},
		resourceCosts: [
			{ resourceConfigurationHash: actualResourceConfigurationHash, resources },
		],
		maximumReserves: 4,
		maximumConcurrentCreates: 1,
		ttlMs: 900_000,
		cooldownMs: 120_000,
		failureBackoffMs: 30_000,
		profiles: [],
	});
	const state = await save("state.json", {
		schemaVersion: 1,
		sourceSha,
		agents: Object.fromEntries(
			["codex", "claude", "opencode", "pi"].map((name) => [
				name,
				{ agentId: `agent-${name}`, ready: true },
			]),
		),
	});
	const templates = await save("templates.json", {
		schemaVersion: 1,
		sourceSha,
		templates: ["codex", "claude", "opencode", "pi"].map(
			(templateId, index) => ({
				templateId,
				imageDigest: `sha256:${String(index + 1).repeat(64)}`,
			}),
		),
	});
	const profiles = await save("profiles.json", {
		schemaVersion: 1,
		profiles: ["codex", "claude", "opencode", "pi"].map(
			(_templateId, index) => ({
				schemaVersion: 1,
				imageDigest: `sha256:${String(index + 1).repeat(64)}`,
				resourceProfileRef: "ack-small",
				resourceConfigurationHash: actualResourceConfigurationHash,
				maximumConcurrentExecutions: 1,
				conformanceEvidenceHash: "c".repeat(64),
			}),
		),
	});
	const capacity = await save("capacity.json", {
		schemaVersion: 1,
		sourceSha,
		resourceProfileRef: "ack-small",
		resources: capacityResources,
		profilesFile: profiles,
	});
	const result = await bindSessionReserves(
		plan,
		state,
		templates,
		capacity,
		profiles,
		sourceSha,
	);
	assert.equal(result.profileCount, 4);
	const bound = JSON.parse(await readFile(plan, "utf8"));
	assert.equal(bound.enabled, true);
	assert.equal(bound.revision, 2);
	assert.deepEqual(
		bound.profiles.map((p) => p.agentId),
		["agent-codex", "agent-claude", "agent-opencode", "agent-pi"],
	);
	assert(bound.profiles.every((p) => p.minimum === 1 && p.maximum === 1));
});

test("rejects a missing ready Agent binding", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "ack-reserve-bind-missing-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const save = async (name, value) => {
		const file = join(dir, name);
		await writeFile(file, JSON.stringify(value), { mode: 0o600 });
		return file;
	};
	const plan = await save("plan.json", {
		schemaVersion: 1,
		sourceSha,
		enabled: false,
		revision: 1,
		namespace: "agent-infra",
		totalBudget: { cpuMillis: 1, memoryBytes: 1, storageBytes: 1 },
		resourceCosts: [
			{ resourceConfigurationHash: actualResourceConfigurationHash, resources },
		],
		maximumReserves: 4,
		maximumConcurrentCreates: 1,
		ttlMs: 1,
		cooldownMs: 1,
		failureBackoffMs: 1,
		profiles: [],
	});
	const state = await save("state.json", {
		schemaVersion: 1,
		sourceSha,
		agents: { codex: { agentId: "agent-codex", ready: false } },
	});
	const templates = await save("templates.json", {
		schemaVersion: 1,
		sourceSha,
		templates: [
			{ templateId: "codex", imageDigest: `sha256:${"1".repeat(64)}` },
		],
	});
	const profiles = await save("profiles.json", {
		schemaVersion: 1,
		profiles: [
			{
				imageDigest: `sha256:${"1".repeat(64)}`,
				resourceProfileRef: "ack-small",
				resourceConfigurationHash: actualResourceConfigurationHash,
				conformanceEvidenceHash: "c".repeat(64),
			},
		],
	});
	const capacity = await save("capacity.json", {
		schemaVersion: 1,
		sourceSha,
		resourceProfileRef: "ack-small",
		resources: capacityResources,
		profilesFile: profiles,
	});
	await assert.rejects(
		bindSessionReserves(plan, state, templates, capacity, profiles, sourceSha),
		/RESERVE_AGENT_NOT_READY/,
	);
});
