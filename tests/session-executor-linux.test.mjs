import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { buildSync, stop as stopBundler } from "esbuild";
import {
	continueExecutorProcessGroupV1,
	executorChildrenV1,
	waitForExecutorProcessGroupExitV1,
	waitForExecutorProcessGroupV1,
} from "../apps/agent-runtime-host/src/executor-process-group.ts";

const bundledJournal = buildSync({
	entryPoints: ["packages/agent-runtime/src/codex-executor-drain-journal.ts"],
	bundle: true,
	platform: "node",
	target: "node24",
	format: "cjs",
	write: false,
});
// Do not let the build helper itself become an unrelated live child in /proc.
await stopBundler();
const journalModule = { exports: {} };
new Function(
	"require",
	"module",
	"exports",
	bundledJournal.outputFiles[0].text,
)(createRequire(import.meta.url), journalModule, journalModule.exports);
const { CodexExecutorDrainJournalV1 } = journalModule.exports;

async function killGroup(pid) {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
}

test("a successful control signal does not prove the original group drained", {
	skip: process.platform !== "linux",
}, async () => {
	const before = await executorChildrenV1(process.pid);
	const child = spawn(
		"/bin/sh",
		["-c", 'kill -STOP "$$"; trap "" TERM; sleep 30 & echo started; wait'],
		{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	const closed = once(child, "close");
	const output = once(child.stdout, "data");
	try {
		const group = await waitForExecutorProcessGroupV1(
			process.pid,
			before,
			Date.now() + 2_000,
		);
		assert.equal(group?.leader, child.pid);
		assert.equal(
			await waitForExecutorProcessGroupExitV1(group, Date.now() + 80),
			false,
		);
		await continueExecutorProcessGroupV1(process.pid, group);
		assert.equal(String((await output)[0]).trim(), "started");
		process.kill(-group.leader, "SIGTERM");
		assert.equal(
			await waitForExecutorProcessGroupExitV1(group, Date.now() + 120),
			false,
		);
		process.kill(-group.leader, "SIGKILL");
		await closed;
		assert.equal(
			await waitForExecutorProcessGroupExitV1(group, Date.now() + 2_000),
			true,
		);
	} finally {
		await killGroup(child.pid);
		await closed;
	}
});

test("a detached surviving descendant keeps the original group unproven", {
	skip: process.platform !== "linux",
	timeout: 10000,
}, async () => {
	const before = await executorChildrenV1(process.pid);
	const script = [
		'const {spawn}=require("node:child_process");',
		'const child=spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{detached:true,stdio:"ignore"});',
		"child.unref(); process.stdout.write(String(child.pid));",
	].join("");
	const parent = spawn(
		"/bin/sh",
		[
			"-c",
			'kill -STOP "$$"; exec "$@"',
			"detached-descendant",
			process.execPath,
			"-e",
			script,
		],
		{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	const closed = once(parent, "close");
	const output = once(parent.stdout, "data");
	let detached;
	try {
		const group = await waitForExecutorProcessGroupV1(
			process.pid,
			before,
			Date.now() + 2000,
		);
		assert.equal(group?.leader, parent.pid);
		await continueExecutorProcessGroupV1(process.pid, group);
		detached = Number(String((await output)[0]).trim());
		assert.ok(Number.isSafeInteger(detached) && detached > 1);
		await closed;
		process.kill(detached, 0);
		assert.equal(
			await waitForExecutorProcessGroupExitV1(group, Date.now() + 150),
			false,
		);
		process.kill(detached, "SIGKILL");
		assert.equal(
			await waitForExecutorProcessGroupExitV1(group, Date.now() + 2000),
			true,
		);
	} finally {
		if (detached) await killGroup(detached);
		await killGroup(parent.pid);
		await closed;
	}
});

test("same-UID tool cannot open protected Node memory, environment or file descriptors", {
	skip: process.platform !== "linux" || process.getuid() === 0,
}, async () => {
	const { protectExecutorIdentityProcessV1 } = await import(
		"../apps/agent-runtime-host/src/executor-identity-process.ts"
	);
	const target = String(process.pid);
	const inspect = `
		const { openSync, closeSync } = require("node:fs");
		const checks = ["mem", "environ", "fd/0"].map((name) => {
			try { closeSync(openSync("/proc/" + process.argv[1] + "/" + name, "r")); return true; }
			catch (error) { if (error.code !== "EACCES" && error.code !== "EPERM") throw error; return false; }
		});
		process.stdout.write(JSON.stringify([process.getuid(), ...checks]));
	`;
	assert.equal(typeof target, "string");
	protectExecutorIdentityProcessV1();
	const result = spawnSync(process.execPath, ["-e", inspect, target], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), [
		process.getuid(),
		false,
		false,
		false,
	]);
});

test("unrelated groups do not prove the registered group exited", {
	skip: process.platform !== "linux",
}, async () => {
	const before = await executorChildrenV1(process.pid);
	const original = spawn("/bin/sh", ["-c", 'kill -STOP "$$"; exec sleep 30'], {
		detached: true,
	});
	const closed = once(original, "close");
	try {
		const group = await waitForExecutorProcessGroupV1(
			process.pid,
			before,
			Date.now() + 2_000,
		);
		assert.equal(group?.leader, original.pid);
		const unrelated = spawn("/bin/true", [], { detached: true });
		await once(unrelated, "close");
		await setTimeout(20);
		assert.equal(
			await waitForExecutorProcessGroupExitV1(group, Date.now() + 100),
			false,
		);
	} finally {
		await killGroup(original.pid);
		await closed;
	}
});

// These tests compose the production runner observation with its durable Host
// journal. They do not replace authenticated gateway/native-server conformance.
async function drainFixture(executionId = "execution-a") {
	const directory = await mkdtemp(join(tmpdir(), "linux-drain-matrix-"));
	const path = join(directory, "journal.json");
	const scope = {
		executionId,
		podUid: "pod-a",
		generation: 2,
		resourceFence: 3,
		epoch: "epoch-a",
	};
	let journal = await CodexExecutorDrainJournalV1.open(path, scope);
	await journal.bindNativeTurn("turn-a");
	const children = [];
	return {
		scope,
		path,
		get journal() {
			return journal;
		},
		async reopen() {
			await journal.close();
			journal = await CodexExecutorDrainJournalV1.open(path, scope);
			return journal;
		},
		async launch(handle, disconnect = false, admitted = false) {
			const attempt = { protocolSession: "original-session", handle };
			if (!admitted) assert.equal(await journal.admit(attempt), true);
			const before = await executorChildrenV1(process.pid);
			const child = spawn(
				"/bin/sh",
				[
					"-c",
					`kill -STOP "$$"; ${disconnect ? "exec 1>&-;" : ""} exec sleep 30`,
				],
				{
					detached: true,
					stdio: ["pipe", "pipe", "ignore"],
				},
			);
			const closed = once(child, "close");
			children.push({ child, closed });
			const group = await waitForExecutorProcessGroupV1(
				process.pid,
				before,
				Date.now() + 2000,
			);
			assert.equal(group?.leader, child.pid);
			return { attempt, child, closed, group };
		},
		async close() {
			for (const { child } of children) await killGroup(child.pid);
			await Promise.all(children.map(({ closed }) => closed));
			await journal.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

const linux = { skip: process.platform !== "linux", timeout: 15000 };
const stop = { stopRequestId: "stop-original", stopFence: 4 };
async function retained(journal) {
	assert.equal(journal.confirmed(), false);
	assert.equal(journal.evidence(), null);
	assert.equal(
		await journal.admit({ protocolSession: "successor", handle: "next-tool" }),
		false,
	);
}

test(
	"concurrent admitted launch and Stop retain the real group until exit",
	linux,
	async () => {
		const f = await drainFixture();
		try {
			const tool = await f.launch("first");
			const [second, seal] = await Promise.all([
				f.journal.admit({
					protocolSession: "original-session",
					handle: "concurrent",
				}),
				f.journal.seal(stop),
			]);
			assert.equal(second, true);
			assert.equal(seal.attempts.length, 2);
			const concurrent = await f.launch("concurrent", false, true);
			assert.equal(
				await waitForExecutorProcessGroupExitV1(
					concurrent.group,
					Date.now() + 80,
				),
				false,
			);
			assert.equal(
				await waitForExecutorProcessGroupExitV1(tool.group, Date.now() + 80),
				false,
			);
			assert.equal(
				await f.journal.confirm(stop, seal.digest, {
					verifiedAt: Date.now(),
					groups: [],
				}),
				false,
			);
			await retained(f.journal);
			// The admitted, unacknowledged second launch survives recovery; never resend it.
			await f.reopen();
			assert.deepEqual(await f.journal.seal(stop), seal);
			await retained(f.journal);
		} finally {
			await f.close();
		}
	},
);

test(
	"repeated Stop keeps the same inventory while its Linux group lives",
	linux,
	async (t) => {
		const f = await drainFixture();
		try {
			const tool = await f.launch("first");
			const seal = await f.journal.seal(stop);
			assert.deepEqual(await f.journal.seal(stop), seal);
			assert.equal(
				await waitForExecutorProcessGroupExitV1(tool.group, Date.now() + 80),
				false,
			);
			await retained(f.journal);
			await killGroup(tool.child.pid);
			await tool.closed;
			assert.equal(
				await waitForExecutorProcessGroupExitV1(tool.group, Date.now() + 2000),
				true,
			);
			const now = Date.now();
			let tick = 0;
			const clock = t.mock.method(Date, "now", () => now + tick++);
			// A progressing clock must not put the exit after its verification.
			const exitedAt = Date.now();
			const evidence = {
				verifiedAt: Date.now(),
				groups: [{ id: "a".repeat(64), exitedAt }],
			};
			clock.mock.restore();
			assert.equal(await f.journal.confirm(stop, seal.digest, evidence), true);
			assert.equal(f.journal.confirmed(), true);
		} finally {
			await f.close();
		}
	},
);

test(
	"another Execution's exited group cannot drain the original live group",
	linux,
	async () => {
		const a = await drainFixture();
		const b = await drainFixture("execution-b");
		try {
			const original = await a.launch("a");
			// The second fixture owns an independent journal/Execution identity.
			const other = await b.launch("b");
			const seal = await a.journal.seal(stop);
			await b.journal.seal({ ...stop, stopRequestId: "stop-b" });
			await killGroup(other.child.pid);
			await other.closed;
			assert.equal(
				await waitForExecutorProcessGroupExitV1(other.group, Date.now() + 80),
				false,
			);
			assert.equal(
				await waitForExecutorProcessGroupExitV1(
					original.group,
					Date.now() + 80,
				),
				false,
			);
			assert.equal(
				await a.journal.confirm(stop, seal.digest, {
					verifiedAt: Date.now(),
					groups: [],
				}),
				false,
			);
			await retained(a.journal);
		} finally {
			await b.close();
			await a.close();
		}
	},
);

test(
	"stale Stop fence is rejected after a real group exits",
	linux,
	async (t) => {
		const f = await drainFixture();
		try {
			const tool = await f.launch("first");
			const old = await f.journal.seal(stop);
			const renewed = { ...stop, stopFence: 5 };
			const current = await f.journal.seal(renewed);
			await killGroup(tool.child.pid);
			await tool.closed;
			assert.equal(
				await waitForExecutorProcessGroupExitV1(tool.group, Date.now() + 2000),
				true,
			);
			const now = Date.now();
			let tick = 0;
			const clock = t.mock.method(Date, "now", () => now + tick++);
			// A progressing clock must not put the exit after its verification.
			const exitedAt = Date.now();
			const evidence = {
				verifiedAt: Date.now(),
				groups: [{ id: "b".repeat(64), exitedAt }],
			};
			clock.mock.restore();
			assert.equal(await f.journal.confirm(stop, old.digest, evidence), false);
			await retained(f.journal);
			assert.equal(
				await f.journal.confirm(renewed, current.digest, evidence),
				true,
			);
		} finally {
			await f.close();
		}
	},
);

for (const changed of [
	{ generation: 3 },
	{ resourceFence: 4 },
	{ podUid: "replacement-pod" },
	{ epoch: "replacement-epoch" },
]) {
	test(
		`replacement ${Object.keys(changed)[0]} cannot adopt a real group's old journal`,
		linux,
		async () => {
			const f = await drainFixture();
			try {
				const tool = await f.launch("first");
				const seal = await f.journal.seal(stop);
				assert.equal(
					await waitForExecutorProcessGroupExitV1(tool.group, Date.now() + 80),
					false,
				);
				await f.journal.close();
				await assert.rejects(
					CodexExecutorDrainJournalV1.open(f.path, { ...f.scope, ...changed }),
					/CODEX_EXECUTOR_DRAIN_JOURNAL_INVALID/,
				);
				await f.reopen();
				assert.deepEqual(await f.journal.seal(stop), seal);
				await retained(f.journal);
			} finally {
				await f.close();
			}
		},
	);
}

test(
	"real stdout disconnect leaves the living group unknown and recovers without a second launch",
	linux,
	async () => {
		const f = await drainFixture();
		try {
			const tool = await f.launch("original", true);
			const disconnected = once(tool.child.stdout, "end");
			tool.child.stdout.resume();
			await continueExecutorProcessGroupV1(process.pid, tool.group);
			await disconnected;
			process.kill(tool.child.pid, 0);
			const seal = await f.journal.seal(stop);
			assert.equal(
				await waitForExecutorProcessGroupExitV1(tool.group, Date.now() + 100),
				false,
			);
			await retained(f.journal);
			await f.reopen();
			assert.deepEqual(await f.journal.seal(stop), seal);
			assert.equal(await f.journal.admit(tool.attempt), false);
			await retained(f.journal);
			process.kill(tool.child.pid, 0);
		} finally {
			await f.close();
		}
	},
);

test(
	"executor stdio EOF cannot release its adopted live group or replay its admitted launch",
	linux,
	async () => {
		const f = await drainFixture();
		const backend = spawn(
			process.execPath,
			[
				"-e",
				`
 const { spawn } = require("node:child_process");
 process.stdout.write("ready\\n");
 process.stdin.once("data", () => {
  const tool = spawn("/bin/sh", ["-c", 'kill -STOP "$$"; exec sleep 30'], { detached: true, stdio: "ignore" });
  process.stdout.write(String(tool.pid) + "\\n");
 });
 process.stdin.once("end", () => process.exit(0));
 `,
			],
			{ stdio: ["pipe", "pipe", "ignore"] },
		);
		const closed = once(backend, "close");
		let toolPid;
		try {
			await once(backend.stdout, "data");
			const attempt = {
				protocolSession: "original-backend",
				handle: "original-launch",
			};
			assert.equal(await f.journal.admit(attempt), true);
			const baseline = await executorChildrenV1(backend.pid);
			const output = once(backend.stdout, "data");
			backend.stdin.write("launch\n");
			toolPid = Number(String((await output)[0]).trim());
			const group = await waitForExecutorProcessGroupV1(
				backend.pid,
				baseline,
				Date.now() + 2000,
			);
			assert.equal(group?.leader, toolPid);
			const seal = await f.journal.seal(stop);
			backend.stdin.end();
			await closed;
			process.kill(toolPid, 0);
			assert.equal(
				await waitForExecutorProcessGroupExitV1(group, Date.now() + 100),
				false,
			);
			await f.reopen();
			assert.deepEqual(await f.journal.seal(stop), seal);
			assert.equal(await f.journal.admit(attempt), false);
			await retained(f.journal);
		} finally {
			if (toolPid) await killGroup(toolPid);
			backend.kill("SIGKILL");
			await closed;
			await f.close();
		}
	},
);
