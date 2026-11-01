import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
	apiReplicaTarget,
	observeApiRollout,
} from "../deploy/ack/api-rollout-observation.ts";

function fixture({ missing = false, silent = false } = {}) {
	let deployment = missing
		? null
		: {
				metadata: { uid: "api-uid", resourceVersion: "1", generation: 1 },
				spec: { replicas: 2 },
				status: {
					observedGeneration: 1,
					updatedReplicas: 2,
					availableReplicas: 2,
					readyReplicas: 2,
				},
			};
	const watch = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		kill() {
			this.emit("close", 0);
			return true;
		},
	});
	const emit = (type = "MODIFIED", value = deployment) => {
		watch.stdout.write(
			`${type}|${value.metadata.uid}|${value.metadata.resourceVersion}|${value.metadata.generation}|${value.spec.replicas}|${value.status.observedGeneration}|${value.status.updatedReplicas}|${value.status.availableReplicas}|${value.status.readyReplicas}\n`,
		);
	};
	return {
		watch,
		emit,
		get current() {
			return deployment;
		},
		set current(value) {
			deployment = value;
		},
		options: {
			sourceSha: "a".repeat(40),
			desiredReplicas: 2,
			timeoutMs: 150,
			readApi: () => structuredClone(deployment),
			watchApi: () => {
				if (!silent) queueMicrotask(() => emit("ADDED"));
				return watch;
			},
		},
	};
}

test("API watch starts before mutation and covers the final resource version", async () => {
	const f = fixture();
	const { value, receipt } = await observeApiRollout(f.options, async () => {
		f.current.metadata.resourceVersion = "2";
		f.current.status.availableReplicas = 1;
		f.current.status.readyReplicas = 1;
		f.emit();
		f.current.metadata.resourceVersion = "3";
		f.current.status.availableReplicas = 2;
		f.current.status.readyReplicas = 2;
		setTimeout(() => f.emit(), 20);
		return 42;
	});
	assert.equal(value, 42);
	assert.equal(receipt.status, "observed-available");
	assert.equal(receipt.windowComplete, true);
	assert.equal(receipt.minimumAvailableReplicas, 1);
	assert.equal(receipt.eventCount, 3);
	assert.equal(receipt.httpAvailabilityVerified, false);
	assert(!JSON.stringify(receipt).includes("api-uid"));
});

test("a transient zero-available event cannot be hidden by final 2/2 readiness", async () => {
	const f = fixture();
	await assert.rejects(
		observeApiRollout(f.options, async () => {
			f.current.status.availableReplicas = 0;
			f.current.metadata.resourceVersion = "2";
			f.emit();
			f.current.status.availableReplicas = 2;
			f.current.metadata.resourceVersion = "3";
			f.emit();
		}),
		(error) => {
			assert.equal(error.receipt.status, "observed-unavailable");
			assert.equal(error.receipt.windowComplete, false);
			assert.equal(error.receipt.minimumAvailableReplicas, 0);
			assert.equal(error.receipt.failureCode, "API_ROLLOUT_AVAILABILITY_LOST");
			return true;
		},
	);
});

for (const scenario of [
	"no-initial-event",
	"closed-watch",
	"missing-final-version",
	"uid-drift",
	"replica-drift",
	"unready-final",
	"operation-failed",
]) {
	test(`API observation rejects ${scenario} and preserves a bounded partial receipt`, async () => {
		const f = fixture({ silent: scenario === "no-initial-event" });
		let actionRan = false;
		await assert.rejects(
			observeApiRollout(f.options, async () => {
				actionRan = true;
				f.current.metadata.resourceVersion = "2";
				if (scenario === "closed-watch") f.watch.emit("close", 1);
				if (scenario === "uid-drift") f.current.metadata.uid = "foreign";
				if (scenario === "replica-drift") f.current.spec.replicas = 3;
				if (scenario === "unready-final") f.current.status.readyReplicas = 1;
				if (scenario === "operation-failed") throw Error("secret-canary");
				if (scenario !== "missing-final-version") f.emit();
			}),
			(error) => {
				assert.equal(error.receipt.windowComplete, false);
				assert.equal(error.receipt.status, "unknown");
				assert.match(error.receipt.failureCode, /^API_ROLLOUT_/);
				assert(!JSON.stringify(error.receipt).includes("secret-canary"));
				return true;
			},
		);
		assert.equal(actionRan, scenario !== "no-initial-event");
	});
}

test("fresh installation records no prior service instead of inventing continuity", async () => {
	const f = fixture({ missing: true });
	const { receipt } = await observeApiRollout(f.options, async () => {
		f.current = fixture().current;
	});
	assert.equal(receipt.status, "not-applicable-new-deployment");
	assert.equal(receipt.windowComplete, false);
	assert.equal(receipt.eventCount, 0);
	assert.equal(receipt.beforeReplicas, null);
	assert.equal(receipt.afterReplicas, 2);
});

test("API target comes from one rendered Deployment, never an unrelated replica count", () => {
	const api = {
		kind: "Deployment",
		metadata: { name: "agent-infra-api" },
		spec: { replicas: 2 },
	};
	assert.equal(apiReplicaTarget(JSON.stringify(api)), 2);
	assert.throws(() =>
		apiReplicaTarget(`${JSON.stringify(api)}\n---\n${JSON.stringify(api)}`),
	);
	assert.throws(() =>
		apiReplicaTarget(JSON.stringify({ ...api, spec: { replicas: 0 } })),
	);
});

test("CLI retains a watch receipt around a real subprocess and cleans up the observer", async (t) => {
	const { mkdtemp, mkdir, writeFile, readFile, rm } = await import(
		"node:fs/promises"
	);
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const run = promisify(execFile);
	const dir = await mkdtemp(join(tmpdir(), "ack-api-watch-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "bin"));
	const state = join(dir, "state.json");
	const output = join(dir, "receipt.json");
	const rendered = join(dir, "rendered.json");
	await writeFile(state, JSON.stringify(fixture().current));
	await writeFile(
		rendered,
		JSON.stringify({
			kind: "Deployment",
			metadata: { name: "agent-infra-api" },
			spec: { replicas: 2 },
		}),
	);
	await writeFile(
		join(dir, "bin/kubectl"),
		`#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); const file=process.env.WATCH_TEST_STATE; if(args.includes('--watch')) { if(!args.includes('--output-watch-events'))process.exit(2); let prior; const emit=()=>{ const d=JSON.parse(fs.readFileSync(file)); if(d.metadata.resourceVersion===prior)return; const type=prior?'MODIFIED':'ADDED';prior=d.metadata.resourceVersion; process.stdout.write([type,d.metadata.uid,prior,d.metadata.generation,d.spec.replicas,d.status.observedGeneration,d.status.updatedReplicas,d.status.availableReplicas,d.status.readyReplicas].join('|')+'\\n'); };emit();setInterval(emit,10); } else if(args.includes('get'))process.stdout.write(fs.readFileSync(file));`,
		{ mode: 0o700 },
	);
	const command = join(dir, "change.cjs");
	await writeFile(
		command,
		`const fs=require('node:fs');const file=process.env.WATCH_TEST_STATE;const d=JSON.parse(fs.readFileSync(file));d.metadata.resourceVersion='2';d.status.availableReplicas=1;fs.writeFileSync(file,JSON.stringify(d));setTimeout(()=>{d.metadata.resourceVersion='3';d.status.availableReplicas=2;fs.writeFileSync(file,JSON.stringify(d));},80);`,
	);
	await run(
		process.execPath,
		[
			join(import.meta.dirname, "../deploy/ack/api-rollout-observation.ts"),
			"ack-test",
			rendered,
			output,
			"5s",
			"--",
			process.execPath,
			command,
		],
		{
			env: {
				...process.env,
				PATH: `${join(dir, "bin")}:${process.env.PATH}`,
				ACK_KUBECONFIG: join(dir, "unused-kubeconfig"),
				ACK_SOURCE_SHA: "a".repeat(40),
				WATCH_TEST_STATE: state,
			},
			timeout: 10000,
		},
	);
	const receipt = JSON.parse(await readFile(output, "utf8"));
	assert.equal(receipt.status, "observed-available");
	assert.equal(receipt.windowComplete, true);
	assert.equal(receipt.minimumAvailableReplicas, 1);
	assert.equal(receipt.afterReplicas, 2);
});
