import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	bindSessionReserves,
	readReservePlan,
	waitForReserveMinimum,
} from "../deploy/ack/bind-session-reserves.ts";
import { sessionSandboxReserveDigestV1 } from "../packages/platform-core/src/session-sandbox-reserves.ts";

const sourceSha = "a".repeat(40);
const costs = {
	cpuMillis: 1000,
	memoryBytes: 2147483648,
	storageBytes: 21474836480,
};
async function fixture(t) {
	const dir = await mkdtemp(join(tmpdir(), "ack-reserve-bind-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const save = async (name, value) => {
		const file = join(dir, name);
		await writeFile(file, JSON.stringify(value), { mode: 0o600 });
		return file;
	};
	const requests = {
		schemaVersion: 1,
		origin: "https://platform.example.test",
		requests: [],
	};
	const bodies = [];
	for (const [index, templateId] of ["codex", "claude"].entries()) {
		const name = `approved-${index}`;
		const body = { source: { kind: "standard", templateId } };
		const idempotencyKey = `approved-idempotency-${index}`;
		requests.requests.push({
			name,
			idempotencyKey,
			bodyFile: await save(`${name}.json`, body),
			credentialFile: join(dir, "credential"),
		});
		bodies.push({ name, body, idempotencyKey });
	}
	const profiles = bodies.map((b, index) => ({
		requestName: b.name,
		templateId: b.body.source.templateId,
		imageDigest: `sha256:${String(index + 1).repeat(64)}`,
		resourceConfigurationHash: "b".repeat(64),
		resources: costs,
		storageConfigurationVersion: "storage-v1",
		networkPolicyVersion: "network-v1",
		signingConfigurationVersion: "signing-v1",
		transportConfigurationVersion: "transport-v1",
		connectionConfigurationVersion: "connection-v1",
		minimum: 1,
		maximum: 2,
	}));
	const plan = {
		schemaVersion: 1,
		sourceSha,
		enabled: true,
		revision: 2,
		namespace: "agent-infra",
		totalBudget: {
			cpuMillis: 16000,
			memoryBytes: 34359738368,
			storageBytes: 549755813888,
		},
		resourceCosts: [
			{ resourceConfigurationHash: "b".repeat(64), resources: costs },
		],
		maximumReserves: 4,
		maximumConcurrentCreates: 1,
		ttlMs: 900000,
		cooldownMs: 120000,
		failureBackoffMs: 30000,
		profiles,
	};
	const state = {
		schemaVersion: 1,
		origin: requests.origin,
		sourceSha,
		requestHash: createHash("sha256")
			.update(JSON.stringify({ origin: requests.origin, bodies }))
			.digest("hex"),
		agents: Object.fromEntries(
			bodies.map((b, index) => [
				b.name,
				{ agentId: `fresh-agent-${index}`, ready: true },
			]),
		),
	};
	const stateDirectory = join(dir, "state");
	await mkdir(stateDirectory, { mode: 0o700 });
	const stateFile = join(stateDirectory, "agent-bindings.json");
	await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
	const profilesFile = await save("profiles.json", {
		schemaVersion: 1,
		sourceSha,
		profiles: profiles.map(({ requestName, ...profile }) => ({
			...profile,
			resourceConfigurationHash: "b".repeat(64),
			conformanceEvidenceHash: "c".repeat(64),
		})),
	});
	const capacityFile = await save("capacity.json", {
		schemaVersion: 1,
		sourceSha,
		resourceProfileRef: "ack-small",
		resources: {
			requests: { cpu: "100m", memory: "128Mi" },
			limits: { cpu: "1", memory: "2Gi" },
		},
		profilesFile,
	});
	const environment = {
		ACK_NAMESPACE: "agent-infra",
		ACK_SESSION_RESERVE_PLAN_FILE: await save("plan.json", plan),
		ACK_AGENT_REQUESTS_FILE: await save("requests.json", requests),
		ACK_WORKLOAD_CAPACITY_FILE: capacityFile,
		ACK_TEMPLATE_IMAGE_MANIFEST: await save("images.json", {
			schemaVersion: 1,
			commitSha: sourceSha,
			platform: "linux/amd64",
			images: Object.fromEntries(
				profiles.map((p) => [p.templateId, { digest: p.imageDigest }]),
			),
		}),
		ACK_SESSION_RESERVES_FILE: await save("reserves.json", {
			...plan,
			enabled: false,
			revision: 1,
			profiles: [],
		}),
		ACK_AGENT_STATE_DIR: stateDirectory,
	};
	return { dir, save, environment, plan, state, stateFile, requests, bodies };
}

test("binds approved request names through real source/body bindings without changing the plan", async (t) => {
	const f = await fixture(t);
	const planBefore = await readFile(
		f.environment.ACK_SESSION_RESERVE_PLAN_FILE,
	);
	const result = await bindSessionReserves(f.environment, sourceSha);
	assert.equal(result.changed, true);
	assert.equal(result.profileCount, 2);
	const bound = JSON.parse(
		await readFile(f.environment.ACK_SESSION_RESERVES_FILE),
	);
	assert.deepEqual(
		bound.profiles.map((p) => p.agentId),
		["fresh-agent-0", "fresh-agent-1"],
	);
	assert(
		bound.profiles.every(
			(p) =>
				p.minimum === 1 &&
				p.maximum === 2 &&
				p.storageConfigurationVersion === "storage-v1",
		),
	);
	assert.equal(result.configHash, sessionSandboxReserveDigestV1(bound));
	assert.deepEqual(
		await readFile(f.environment.ACK_SESSION_RESERVE_PLAN_FILE),
		planBefore,
	);
	assert.equal(
		(await bindSessionReserves(f.environment, sourceSha)).changed,
		false,
	);
});

for (const scenario of [
	"wrong-source",
	"wrong-namespace",
	"wrong-image",
	"wrong-template",
	"unknown-field",
	"duplicate-request",
	"zero-maximum",
	"minimum-exceeds-global-limit",
	"minimum-exceeds-budget",
	"unready",
	"stale-state-source",
	"stale-request-hash",
	"duplicate-agent",
	"revision-regression",
	"revision-conflict",
	"public-plan",
	"output-alias",
]) {
	test(`binding rejects ${scenario} without changing the reserve file`, async (t) => {
		const f = await fixture(t);
		if (scenario === "wrong-source") f.plan.sourceSha = "f".repeat(40);
		if (scenario === "wrong-namespace") f.plan.namespace = "foreign";
		if (scenario === "wrong-image")
			f.plan.profiles[0].imageDigest = `sha256:${"f".repeat(64)}`;
		if (scenario === "wrong-template") f.plan.profiles[0].templateId = "claude";
		if (scenario === "unknown-field") f.plan.credential = "private-sentinel";
		if (scenario === "duplicate-request")
			f.plan.profiles[1].requestName = f.plan.profiles[0].requestName;
		if (scenario === "zero-maximum") f.plan.maximumReserves = 0;
		if (scenario === "minimum-exceeds-global-limit") {
			f.plan.maximumReserves = 2;
			for (const p of f.plan.profiles) p.minimum = 2;
		}
		if (scenario === "minimum-exceeds-budget")
			f.plan.totalBudget.cpuMillis = 1000;
		if (scenario === "unready") f.state.agents["approved-0"].ready = false;
		if (scenario === "stale-state-source") f.state.sourceSha = "f".repeat(40);
		if (scenario === "stale-request-hash") f.state.requestHash = "f".repeat(64);
		if (scenario === "duplicate-agent")
			f.state.agents["approved-1"].agentId =
				f.state.agents["approved-0"].agentId;
		await writeFile(
			f.environment.ACK_SESSION_RESERVE_PLAN_FILE,
			JSON.stringify(f.plan),
			{ mode: 0o600 },
		);
		await writeFile(f.stateFile, JSON.stringify(f.state), { mode: 0o600 });
		if (scenario === "public-plan")
			await chmod(f.environment.ACK_SESSION_RESERVE_PLAN_FILE, 0o644);
		if (scenario === "output-alias")
			f.environment.ACK_SESSION_RESERVES_FILE =
				f.environment.ACK_SESSION_RESERVE_PLAN_FILE;
		if (scenario === "revision-regression" || scenario === "revision-conflict")
			await writeFile(
				f.environment.ACK_SESSION_RESERVES_FILE,
				JSON.stringify({
					...f.plan,
					enabled: false,
					profiles: [],
					revision: scenario === "revision-regression" ? 3 : 2,
				}),
				{ mode: 0o600 },
			);
		const before = await readFile(f.environment.ACK_SESSION_RESERVES_FILE);
		await assert.rejects(bindSessionReserves(f.environment, sourceSha));
		assert.deepEqual(
			await readFile(f.environment.ACK_SESSION_RESERVES_FILE),
			before,
		);
	});
}

test("plan check needs no Agent state or runtime measurement and rejects cross-template requests", async (t) => {
	const f = await fixture(t);
	await rm(f.stateFile);
	assert.equal(
		(await readReservePlan(f.environment, sourceSha)).plan.profiles.length,
		2,
	);
	await writeFile(
		f.requests.requests[0].bodyFile,
		JSON.stringify({
			source: { kind: "custom", interactionMode: "platform-adapter" },
		}),
		{ mode: 0o600 },
	);
	await assert.rejects(
		readReservePlan(f.environment, sourceSha),
		/TEMPLATE_INVALID/,
	);
});

test("readiness waits for every approved minimum", async () => {
	const configuration = {
		sourceSha,
		profiles: [
			{ agentId: "one", minimum: 1 },
			{ agentId: "two", minimum: 2 },
		],
	};
	const configHash = sessionSandboxReserveDigestV1(configuration);
	let now = 0;
	let reads = 0;
	const result = await waitForReserveMinimum(
		configuration,
		async () => ({
			sourceSha,
			configHash,
			counts: { one: 1, two: reads++ ? 2 : 1 },
		}),
		{
			timeoutMs: 100,
			now: () => now,
			wait: async () => {
				now += 10;
			},
		},
	);
	assert.equal(reads, 2);
	assert.equal(result.ready, true);
	assert.deepEqual(
		result.profiles.map((p) => p.ready),
		[1, 2],
	);
	assert.equal(result.businessVerified, false);
});
for (const scenario of [
	"source",
	"config",
	"invalid-count",
	"deadline",
	"late-success",
]) {
	test(`readiness rejects ${scenario}`, async () => {
		const configuration = {
			sourceSha,
			profiles: [{ agentId: "one", minimum: 1 }],
		};
		let now = 0;
		const inspect = async () => {
			if (scenario === "late-success") now = 101;
			return {
				sourceSha: scenario === "source" ? "f".repeat(40) : sourceSha,
				configHash:
					scenario === "config"
						? "f".repeat(64)
						: sessionSandboxReserveDigestV1(configuration),
				counts: {
					one:
						scenario === "invalid-count" ? -1 : scenario === "deadline" ? 0 : 1,
				},
			};
		};
		await assert.rejects(
			waitForReserveMinimum(configuration, inspect, {
				timeoutMs: 100,
				now: () => now,
				wait: async () => {
					now += 50;
				},
			}),
		);
	});
}
