import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
	continueExecutorProcessGroupV1,
	executorChildrenV1,
	waitForExecutorProcessGroupExitV1,
	waitForExecutorProcessGroupV1,
} from "../apps/agent-runtime-host/src/executor-process-group.ts";

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
