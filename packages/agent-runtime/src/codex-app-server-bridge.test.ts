import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	CodexAppServerBridge,
} from "./codex-app-server-bridge.js";

const directories: string[] = [];
const originalPath = process.env.PATH;
const originalMode = process.env.CODEX_APP_SERVER_BRIDGE_MODE;
const originalCapturePath = process.env.CODEX_APP_SERVER_BRIDGE_CAPTURE_PATH;
const childPids: number[] = [];

async function installFakeCodex(mode: string) {
	const directory = await mkdtemp(
		join(tmpdir(), "agent-runtime-codex-bridge-"),
	);
	directories.push(directory);
	const executable = join(directory, "codex");
	const capturePath = join(directory, "captured-arguments.json");
	await writeFile(
		executable,
		`#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.CODEX_APP_SERVER_BRIDGE_MODE;
if (args[0] === "--version") {
  if (mode === "version-hangs") setInterval(() => {}, 1_000);
  if (mode === "version-mismatch") process.stdout.write("codex-cli 0.0.0\\n");
  else process.stdout.write("codex-cli 0.153.0\\n");
  if (mode !== "version-hangs") process.exit(0);
}
if (process.env.CODEX_APP_SERVER_BRIDGE_CAPTURE_PATH) {
  writeFileSync(process.env.CODEX_APP_SERVER_BRIDGE_CAPTURE_PATH, JSON.stringify({ args, pid: process.pid }));
}
if (mode === "startup-exit") process.exit(9);
if (mode === "malformed-frame") process.stdout.write("not-json\\n");
if (mode === "oversized-frame") process.stdout.write("x".repeat(65_537) + "\\n");
if (mode === "stderr-exit") {
  process.stderr.write("redacted-child-output\\n");
  process.exit(9);
}
if (mode === "shutdown-hangs") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
  process.stdin.resume();
} else {
  process.stdin.on("data", (chunk) => process.stdout.write(chunk));
  process.stdin.on("end", () => process.exit(0));
}
`,
	);
	await chmod(executable, 0o755);
	process.env.PATH = `${directory}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
	process.env.CODEX_APP_SERVER_BRIDGE_MODE = mode;
	process.env.CODEX_APP_SERVER_BRIDGE_CAPTURE_PATH = capturePath;
	return { capturePath };
}

function options(overrides: Record<string, unknown> = {}) {
	return {
		model: "gpt-5.3-codex",
		reasoningEffort: "high",
		provenance: CODEX_APP_SERVER_V2_PROVENANCE,
		startupTimeoutMs: 5_000,
		shutdownTimeoutMs: 1_000,
		...overrides,
	};
}

async function readCapture(path: string) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			return JSON.parse(await readFile(path, "utf8")) as {
				args: string[];
				pid: number;
			};
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error("fake Codex did not record its launch");
}

afterEach(async () => {
	for (const pid of childPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The test already confirmed this child exited.
		}
	}
	process.env.PATH = originalPath;
	if (originalMode === undefined)
		delete process.env.CODEX_APP_SERVER_BRIDGE_MODE;
	else process.env.CODEX_APP_SERVER_BRIDGE_MODE = originalMode;
	if (originalCapturePath === undefined) {
		delete process.env.CODEX_APP_SERVER_BRIDGE_CAPTURE_PATH;
	} else {
		process.env.CODEX_APP_SERVER_BRIDGE_CAPTURE_PATH = originalCapturePath;
	}
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true })),
	);
});

describe.sequential("Codex app-server v2 bridge", () => {
	it("starts only with the supported pinned argv and bounded active model configuration", async () => {
		const { capturePath } = await installFakeCodex("echo");
		const bridge = await CodexAppServerBridge.open(options());
		const iterator = bridge.frames()[Symbol.asyncIterator]();
		await bridge.send({ id: 1, method: "synthetic/request" });
		await iterator.next();
		expect(bridge).not.toHaveProperty("process");
		const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
			args: string[];
			pid: number;
		};
		expect(captured.args).toEqual([
			"app-server",
			"--stdio",
			"--strict-config",
			"--config",
			'model="gpt-5.3-codex"',
			"--config",
			'model_reasoning_effort="high"',
		]);
		expect(captured.args).not.toContain("--session-source");
		expect(bridge.provenance()).toEqual(CODEX_APP_SERVER_V2_PROVENANCE);
		await bridge.close();
	});

	it("rejects unpinned provenance and unsafe launch configuration before spawning", async () => {
		const { capturePath } = await installFakeCodex("echo");
		await expect(
			CodexAppServerBridge.open(
				options({
					provenance: {
						...CODEX_APP_SERVER_V2_PROVENANCE,
						schemaSha256: `sha256:${"0".repeat(64)}`,
					},
				}),
			),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_PROVENANCE_MISMATCH" });
		await expect(
			CodexAppServerBridge.open(options({ model: "model\nunsafe" })),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_CONFIGURATION_INVALID" });
		await expect(readFile(capturePath, "utf8")).rejects.toThrow();
	});

	it("fails closed when the executable version differs from the pin without leaking stderr", async () => {
		await installFakeCodex("version-mismatch");
		await expect(CodexAppServerBridge.open(options())).rejects.toEqual(
			expect.objectContaining({
				code: "CODEX_APP_SERVER_PROVENANCE_MISMATCH",
				message:
					"Codex app-server provenance does not match the pinned release",
			}),
		);
		await installFakeCodex("stderr-exit");
		const bridge = await CodexAppServerBridge.open(options());
		const error = await bridge
			.frames()
			[Symbol.asyncIterator]()
			.next()
			.catch((value: unknown) => value);
		expect(error).toEqual(
			expect.objectContaining({ code: "CODEX_APP_SERVER_EXITED" }),
		);
		expect(error).not.toMatchObject({
			message: expect.stringContaining("redacted-child-output"),
		});
		await bridge.close();
	});

	it("frames JSONL without exposing the child process", async () => {
		await installFakeCodex("echo");
		const bridge = await CodexAppServerBridge.open(options());
		const iterator = bridge.frames()[Symbol.asyncIterator]();
		await bridge.send({ id: 7, method: "synthetic/request" });
		expect(await iterator.next()).toEqual({
			done: false,
			value: { id: 7, method: "synthetic/request" },
		});
		await bridge.close();
		await expect(
			bridge.send({ id: 8, method: "synthetic/request" }),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_CLOSED" });
	});

	it.each([
		["malformed-frame", "CODEX_APP_SERVER_FRAME_INVALID"],
		["oversized-frame", "CODEX_APP_SERVER_FRAME_INVALID"],
		["startup-exit", "CODEX_APP_SERVER_EXITED"],
	] as const)("returns a stable redacted error for %s", async (mode, code) => {
		await installFakeCodex(mode);
		const bridge = await CodexAppServerBridge.open(options());
		const iterator = bridge.frames()[Symbol.asyncIterator]();
		await expect(iterator.next()).rejects.toEqual(
			expect.objectContaining({ code }),
		);
		await bridge.close();
	});

	it("bounds a hanging provenance probe", async () => {
		await installFakeCodex("version-hangs");
		await expect(
			CodexAppServerBridge.open(options({ startupTimeoutMs: 25 })),
		).rejects.toMatchObject({ code: "CODEX_APP_SERVER_TIMEOUT" });
	});

	it("kills a bridge process that ignores graceful shutdown", async () => {
		const { capturePath } = await installFakeCodex("shutdown-hangs");
		const bridge = await CodexAppServerBridge.open(
			options({ shutdownTimeoutMs: 25 }),
		);
		const { pid } = await readCapture(capturePath);
		childPids.push(pid);
		await expect(bridge.close()).rejects.toMatchObject({
			code: "CODEX_APP_SERVER_TIMEOUT",
		});
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
