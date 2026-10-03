import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { retireNativeProcess, spawnNativeProcess } from "./native-process.js";

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

it.runIf(process.platform === "linux").each([
	{ variable: "AGENT_INFRA_ACP_OWNER", reap: true },
	{ variable: "AGENT_INFRA_PI_OWNER", reap: true },
	{ variable: "AGENT_INFRA_ACP_OWNER", reap: false },
	{ variable: "AGENT_INFRA_PI_OWNER", reap: false },
] as const)(
	"requires an exited process to be reaped before recovery (%j)",
	async ({ variable, reap }) => {
		const directory = await mkdtemp(join(tmpdir(), "native-reaping-"));
		const token = randomUUID();
		// Stop the parent before it can reap its child, making the exit/reap
		// window deterministic without mocking the kernel's ownership evidence.
		const parent = spawn(
			process.execPath,
			[
				"-e",
				`
		const { spawn } = require('node:child_process');
		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			detached: true, stdio: 'ignore', env: { ${variable}: '${token}' }
		});
		child.on('spawn', () => {
			process.stdout.write(String(child.pid) + '\\n', () => process.kill(process.pid, 'SIGSTOP'));
		});
	`,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		const parentExit = once(parent, "exit");
		let pid: number | undefined;
		let resume: ReturnType<typeof setTimeout> | undefined;
		let reaperResumed = false;
		try {
			const [output] = await once(parent.stdout, "data");
			pid = Number(output.toString().trim());
			await vi.waitFor(async () =>
				expect(await readFile(`/proc/${parent.pid}/stat`, "utf8")).toMatch(
					/\) T /,
				),
			);
			await writeFile(
				join(directory, "process.json"),
				JSON.stringify({ owner: { pid, token } }),
			);
			process.kill(pid, "SIGKILL");
			await vi.waitFor(async () =>
				expect(await readFile(`/proc/${pid}/stat`, "utf8")).toMatch(/\) Z /),
			);
			// Root sees an empty environment; an unprivileged parent can instead
			// receive EACCES after exit. Neither supplies ownership evidence.
			const environment = await readFile(`/proc/${pid}/environ`).then(
				(value) => value.length,
				(error: NodeJS.ErrnoException) => error.code,
			);
			expect([0, "EACCES"]).toContain(environment);
			expect(() => process.kill(-Number(pid), 0)).not.toThrow();
			if (reap) {
				resume = setTimeout(() => {
					reaperResumed = true;
					parent.kill("SIGCONT");
				}, 150);
				await expect(
					retireNativeProcess(directory, variable),
				).resolves.toBeUndefined();
				expect(() => process.kill(-Number(pid), 0)).toThrow();
				await expect(
					retireNativeProcess(directory, variable),
				).resolves.toBeUndefined();
			} else {
				await expect(retireNativeProcess(directory, variable)).rejects.toThrow(
					"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
				);
				expect(
					JSON.parse(await readFile(join(directory, "process.json"), "utf8")),
				).toEqual({ owner: { pid, token } });
			}
		} finally {
			clearTimeout(resume);
			// A resumed parent can reap the child and release its PID for reuse.
			if (pid && !reaperResumed) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* Already reaped. */
				}
			}
			parent.kill("SIGCONT");
			await parentExit;
			await rm(directory, { recursive: true, force: true });
		}
	},
);

it.each(["AGENT_INFRA_ACP_OWNER", "AGENT_INFRA_PI_OWNER"] as const)(
	"preserves %s ownership when retirement cannot be confirmed",
	async (variable) => {
		const directory = await mkdtemp(join(tmpdir(), "native-refusal-"));
		const owned = await spawnNativeProcess(
			directory,
			directory,
			{
				command: process.execPath,
				args: [
					"-e",
					"process.stdout.write('ready'); setInterval(() => {}, 1000)",
				],
				env: {},
			},
			variable,
		);
		const originalKill = process.kill.bind(process);
		try {
			await once(owned.child.stdout, "data");
			const path = join(directory, "process.json");
			const original = await readFile(path, "utf8");
			// A live, unrelated PID in a stale record must never receive a signal.
			const mismatched = JSON.parse(original);
			mismatched.owner.token = randomUUID();
			await writeFile(path, JSON.stringify(mismatched));
			await expect(retireNativeProcess(directory, variable)).rejects.toThrow(
				"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
			);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual(mismatched);
			expect(() => originalKill(Number(owned.child.pid), 0)).not.toThrow();
			await writeFile(path, original);
			for (const failure of [
				"probe-denied",
				"signal-denied",
				"still-alive",
			] as const) {
				const kill = vi
					.spyOn(process, "kill")
					.mockImplementation((pid, signal) => {
						if (pid === -Number(owned.child.pid)) {
							if (
								(failure === "probe-denied" && signal === 0) ||
								(failure === "signal-denied" && signal === "SIGKILL")
							)
								throw Object.assign(new Error("synthetic permission denial"), {
									code: "EPERM",
								});
							if (failure === "still-alive" && signal === "SIGKILL")
								return true;
						}
						return originalKill(pid, signal);
					});
				try {
					await expect(
						retireNativeProcess(directory, variable),
					).rejects.toThrow("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
					expect(await readFile(path, "utf8")).toBe(original);
					expect(() => originalKill(Number(owned.child.pid), 0)).not.toThrow();
				} finally {
					kill.mockRestore();
				}
			}
			await owned.close();
			await owned.close();
			await expect(
				retireNativeProcess(directory, variable),
			).resolves.toBeUndefined();
		} finally {
			await owned.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
	10_000,
);
