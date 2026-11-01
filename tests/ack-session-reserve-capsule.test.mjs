import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCapsule } from "../deploy/ack/run-capsule.ts";
import { sessionSandboxReserveDigestV1 } from "../packages/platform-core/src/session-sandbox-reserves.ts";

for (const tamper of [false, true])
	test(`fresh all binds and promotes the approved reserve output (tamper=${tamper})`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "ack-bound-capsule-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const source = join(root, "source");
		const capsule = join(root, "capsule");
		await mkdir(join(source, "deploy/ack"), { recursive: true });
		await mkdir(capsule, { mode: 0o700 });
		const helper = new URL(
			"../deploy/ack/bind-session-reserves.ts",
			import.meta.url,
		).href;
		const script = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == all ]]
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';import fs from 'node:fs';
const {bindSessionReserves}=await import(${JSON.stringify(helper)});
const e=process.env,b=JSON.parse(fs.readFileSync(e.ACK_BOOTSTRAP_INPUTS_FILE));
const baseline=b.objects.find(x=>x.name==='test-worker-configuration').files['session-reserves.json'];
assert.notEqual(baseline,e.ACK_SESSION_RESERVES_FILE);
assert.equal(JSON.parse(fs.readFileSync(baseline)).enabled,false);
await bindSessionReserves(e,e.ACK_SOURCE_SHA);
assert.equal(JSON.parse(fs.readFileSync(baseline)).enabled,false);
const desired=JSON.parse(fs.readFileSync(e.ACK_SESSION_RESERVES_FILE));
${tamper ? "desired.profiles[0].agentId='unapproved-agent';fs.writeFileSync(e.ACK_SESSION_RESERVES_FILE,JSON.stringify(desired));" : ""}
fs.writeFileSync(baseline,JSON.stringify(desired));
NODE
`;
		await writeFile(join(source, "deploy/ack/redeploy.sh"), script);
		const git = (args) =>
			execFileSync(
				"git",
				[
					"-C",
					source,
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"user.name=Fixture",
					"-c",
					"user.email=fixture@example.test",
					...args,
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			).trim();
		git(["init", "-q"]);
		git(["add", "."]);
		git(["commit", "-qm", "fixture"]);
		const sourceSha = git(["rev-parse", "HEAD"]);
		const save = async (name, value) => {
			const file = join(capsule, name);
			await mkdir(dirname(file), { recursive: true, mode: 0o700 });
			await writeFile(
				file,
				typeof value === "string" ? value : JSON.stringify(value),
				{ mode: 0o600 },
			);
			return file;
		};
		const body = { source: { kind: "standard", templateId: "codex" } };
		const name = "approved-request";
		const idempotencyKey = "approved-key-01";
		const origin = "https://platform.example.test";
		const costs = {
			cpuMillis: 1000,
			memoryBytes: 2147483648,
			storageBytes: 21474836480,
		};
		const plan = {
			schemaVersion: 1,
			sourceSha,
			enabled: true,
			revision: 2,
			namespace: "ack-test",
			totalBudget: costs,
			resourceCosts: [
				{ resourceConfigurationHash: "b".repeat(64), resources: costs },
			],
			maximumReserves: 1,
			maximumConcurrentCreates: 1,
			ttlMs: 60000,
			cooldownMs: 1000,
			failureBackoffMs: 1000,
			profiles: [
				{
					requestName: name,
					templateId: "codex",
					imageDigest: `sha256:${"1".repeat(64)}`,
					resourceConfigurationHash: "b".repeat(64),
					resources: costs,
					storageConfigurationVersion: "v1",
					networkPolicyVersion: "v1",
					signingConfigurationVersion: "v1",
					transportConfigurationVersion: "v1",
					connectionConfigurationVersion: "v1",
					minimum: 1,
					maximum: 1,
				},
			],
		};
		await save("plan.json", plan);
		await save("reserves.json", {
			...plan,
			enabled: false,
			revision: 1,
			profiles: [],
		});
		await save("request.json", body);
		await save("credential", "fixture");
		await save("configuration.mjs", "export const fixture=true;");
		await save("requests.json", {
			schemaVersion: 1,
			origin,
			requests: [
				{
					name,
					idempotencyKey,
					bodyFile: "@CAPSULE_ROOT@/request.json",
					credentialFile: "@CAPSULE_ROOT@/credential",
				},
			],
		});
		await save("images.json", {
			schemaVersion: 1,
			commitSha: sourceSha,
			platform: "linux/amd64",
			images: { codex: { digest: plan.profiles[0].imageDigest } },
		});
		const profilesFile = await save("profiles.json", {
			schemaVersion: 1,
			sourceSha,
			profiles: [],
		});
		await save("capacity.json", {
			schemaVersion: 1,
			sourceSha,
			resourceProfileRef: "ack-small",
			resources: {
				requests: { cpu: "100m", memory: "128Mi" },
				limits: { cpu: "1", memory: "2Gi" },
			},
			profilesFile,
		});
		await save("state/agent-bindings.json", {
			schemaVersion: 1,
			sourceSha,
			origin,
			requestHash: createHash("sha256")
				.update(
					JSON.stringify({ origin, bodies: [{ name, body, idempotencyKey }] }),
				)
				.digest("hex"),
			agents: { [name]: { agentId: "fresh-agent", ready: true } },
		});
		await save("bootstrap.json", {
			namespace: "ack-test",
			objects: ["worker", "api"].map((component) => ({
				kind: "Secret",
				name: `test-${component}-configuration`,
				files: { "configuration.mjs": "@CAPSULE_ROOT@/configuration.mjs" },
			})),
		});
		const manifest = await save("capsule.json", {
			schemaVersion: 1,
			sourceSha,
			inputs: [
				"plan.json",
				"reserves.json",
				"requests.json",
				"images.json",
				"capacity.json",
				"profiles.json",
				"request.json",
				"bootstrap.json",
			],
			directories: ["state", "evidence"],
			environment: {
				ACK_NAMESPACE: "ack-test",
				ACK_BOOTSTRAP_INPUTS_FILE: "@CAPSULE_ROOT@/bootstrap.json",
				ACK_SESSION_RESERVE_PLAN_FILE: "@CAPSULE_ROOT@/plan.json",
				ACK_SESSION_RESERVES_FILE: "@CAPSULE_ROOT@/reserves.json",
				ACK_AGENT_REQUESTS_FILE: "@CAPSULE_ROOT@/requests.json",
				ACK_TEMPLATE_IMAGE_MANIFEST: "@CAPSULE_ROOT@/images.json",
				ACK_WORKLOAD_CAPACITY_FILE: "@CAPSULE_ROOT@/capacity.json",
				ACK_AGENT_STATE_DIR: "@CAPSULE_ROOT@/state",
				ACK_EVIDENCE_DIR: "@CAPSULE_ROOT@/evidence",
			},
		});
		const observe = (environment) => {
			const input = JSON.parse(
				readFileSync(environment.ACK_SESSION_RESERVES_FILE),
			);
			if (!input.enabled) return null;
			return {
				sourceSha,
				configuration: input,
				configurationHash: sessionSandboxReserveDigestV1(input),
				replicas: 1,
			};
		};
		if (tamper) {
			await assert.rejects(
				runCapsule(manifest, "all", source, observe, observe),
				/CAPSULE_RESERVE_PLAN_ADOPTION_MISMATCH/,
			);
			assert.equal(
				JSON.parse(await readFile(join(capsule, "reserves.json"))).enabled,
				false,
			);
		} else {
			const receipt = await runCapsule(
				manifest,
				"all",
				source,
				observe,
				observe,
			);
			assert.equal(receipt.exitCode, 0);
			assert.equal(receipt.reserve.enabled, true);
			assert.equal(receipt.reserve.revision, 2);
			assert.equal(receipt.reserve.mountedInputVerified, true);
			assert(receipt.promotedInputs.includes("reserves.json"));
			const bound = JSON.parse(await readFile(join(capsule, "reserves.json")));
			assert.equal(bound.profiles[0].agentId, "fresh-agent");
			const bootstrap = JSON.parse(
				await readFile(join(capsule, "bootstrap.json")),
			);
			assert(
				bootstrap.objects.every(
					(o) =>
						o.files["session-reserves.json"] === "@CAPSULE_ROOT@/reserves.json",
				),
			);
		}
		assert.deepEqual(
			JSON.parse(await readFile(join(capsule, "plan.json"))),
			plan,
		);
	});
