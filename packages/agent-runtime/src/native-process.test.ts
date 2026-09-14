import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { spawnNativeProcess } from "./native-process.js";

it("closes a live native process after it changes its process title", async () => {
	const directory = await mkdtemp(join(tmpdir(), "native-title-"));
	const owned = await spawnNativeProcess(
		directory,
		directory,
		{
			command: process.execPath,
			args: [
				"-e",
				"process.stdin.once('data', () => { process.title = 'pi'; process.stdout.write('ready'); }); setInterval(() => {}, 1000)",
			],
			env: {},
		},
		"AGENT_INFRA_PI_OWNER",
	);
	try {
		const ready = once(owned.child.stdout, "data");
		owned.child.stdin.write("start");
		await ready;
		await expect(owned.close()).resolves.toBeUndefined();
		expect(owned.child.signalCode).toBe("SIGKILL");
	} finally {
		// Retain cleanup even when the close regression is deliberately run red.
		owned.child.kill("SIGKILL");
		await owned.exited;
		await rm(directory, { recursive: true, force: true });
	}
});

it.each([
	{ reused: true, pendingExit: false },
	{ reused: false, pendingExit: false },
	{ reused: true, pendingExit: true },
])("does not signal a departed child (%j)", async ({ reused, pendingExit }) => {
	const directory = await mkdtemp(join(tmpdir(), "native-owner-"));
	const owned = await spawnNativeProcess(
		directory,
		directory,
		{
			command: process.execPath,
			args: ["-e", "setTimeout(() => process.exit(0), 200)"],
			env: {},
		},
		"AGENT_INFRA_PI_OWNER",
	);
	await owned.exited;
	const pid = owned.child.pid;
	expect(pid).toBeTypeOf("number");
	if (pendingExit) {
		// libuv can reap a batch before delivering each child's exit callback.
		Object.defineProperty(owned.child, "exitCode", { value: null });
		queueMicrotask(() => {
			Object.defineProperty(owned.child, "exitCode", { value: 0 });
		});
	}
	const originalKill = process.kill.bind(process);
	let probes = 0;
	const kill = vi
		.spyOn(process, "kill")
		.mockImplementation((target, signal) => {
			// Model the group disappearing during verification, or its ID being reused.
			if (target === -Number(pid)) {
				if (signal === 0 && !reused && probes++ > 0)
					throw Object.assign(new Error("synthetic missing process"), {
						code: "ESRCH",
					});
				return true;
			}
			return originalKill(target, signal);
		});
	try {
		if (reused) {
			await expect(owned.close()).rejects.toThrow(
				"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
			);
		} else await expect(owned.close()).resolves.toBeUndefined();
		expect(
			kill.mock.calls.filter(([, signal]) => signal === "SIGKILL"),
		).toEqual([]);
	} finally {
		kill.mockRestore();
		await rm(directory, { recursive: true, force: true });
	}
});
