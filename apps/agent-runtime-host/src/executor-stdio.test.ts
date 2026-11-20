import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { openPrivateExecutorV1 } from "./executor-stdio.js";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: vi.fn(),
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
	if (originalPlatform)
		Object.defineProperty(process, "platform", originalPlatform);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function native(result: (read: number) => Record<string, unknown>) {
	Object.defineProperty(process, "platform", {
		value: "linux",
		configurable: true,
	});
	vi.spyOn(process, "getuid").mockReturnValue(1000);
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		pid: 12345,
		stdin,
		stdout,
		kill() {
			child.emit("exit");
			return true;
		},
	});
	const requests: { id: number; method: string; params: unknown }[] = [];
	let reads = 0;
	stdin.on("data", (data) => {
		const frame = JSON.parse(String(data));
		requests.push(frame);
		const response = frame.method === "process/read" ? result(++reads) : {};
		queueMicrotask(() =>
			stdout.write(JSON.stringify({ id: frame.id, result: response }) + "\n"),
		);
	});
	vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
	return {
		executor: openPrivateExecutorV1("/workspace/synthetic", "/tmp/synthetic"),
		requests,
	};
}

it("waits for the original isolation probe pipes to close after successful exit", async () => {
	const f = native((read) => ({
		exited: true,
		exitCode: 0,
		closed: read > 1,
		nextSeq: read,
	}));
	try {
		await f.executor.requireLaunchIsolation();
		expect(
			f.requests.filter((frame) => frame.method === "process/start"),
		).toHaveLength(1);
		expect(
			f.requests.filter((frame) => frame.method === "process/read"),
		).toHaveLength(2);
	} finally {
		f.executor.close();
	}
});

it("does not accept an isolation probe whose exit failed", async () => {
	const f = native(() => ({ exited: true, exitCode: 1, closed: true }));
	await expect(f.executor.requireLaunchIsolation()).rejects.toThrow(
		"CODEX_EXECUTOR_LAUNCH_NOT_ISOLATED",
	);
	expect(
		f.requests.filter((frame) => frame.method === "process/start"),
	).toHaveLength(1);
	f.executor.close();
});

it("bounds waiting for isolation probe pipe closure without starting another probe", async () => {
	vi.useFakeTimers();
	const f = native(() => ({
		exited: true,
		exitCode: 0,
		closed: false,
		nextSeq: 2,
	}));
	const rejected = expect(f.executor.requireLaunchIsolation()).rejects.toThrow(
		"CODEX_EXECUTOR_LAUNCH_NOT_ISOLATED",
	);
	await vi.runAllTimersAsync();
	await rejected;
	expect(
		f.requests.filter((frame) => frame.method === "process/start"),
	).toHaveLength(1);
	f.executor.close();
});
