import { spawnSync } from "node:child_process";
import { RuntimeHostError } from "@agent-infra/agent-runtime";
import { describe, expect, it } from "vitest";
import { runtimeHostStartupFailureLineV1 } from "./index.js";
import {
	codexExecutorStartupFailureLineV1,
	codexExecutorStartupReasonsV1,
	runtimeHostStartupReasonsV1,
} from "./startup-diagnostics.js";

const canary = "synthetic-secret-detail /workspace/runtime/private.key";
const executorLine = (reason: string) =>
	JSON.stringify({
		service: "codex-session-executor",
		code: "CODEX_EXECUTOR_STARTUP_FAILED",
		reason,
	});
const hostLine = (code: string, reason?: string) =>
	JSON.stringify({
		service: "agent-runtime-host",
		code,
		...(reason === undefined ? {} : { reason }),
	});

describe("Session executor startup failure reason (#3054)", () => {
	it.each([...codexExecutorStartupReasonsV1])(
		"names the fixed internal code %s",
		(code) => {
			expect(codexExecutorStartupFailureLineV1(new Error(code))).toBe(
				executorLine(code),
			);
		},
	);

	it.each([
		["an unknown message", new Error(canary)],
		[
			"a code with extra text",
			new Error(`CODEX_SESSION_EXECUTOR_INVALID ${canary}`),
		],
		[
			"a system error code",
			Object.assign(new Error(canary), { code: "EEXIST" }),
		],
		["a thrown string", "CODEX_SESSION_EXECUTOR_INVALID"],
		["a Host-only code", new Error("CODEX_EXECUTOR_CONTROL_REJECTED")],
		[
			"a process protection failure",
			new RuntimeHostError("RUNTIME_PROCESS_PROTECTION_INVALID", canary, 503),
		],
		["nothing", undefined],
	])("reports %s as unclassified without its message", (_name, error) => {
		const line = codexExecutorStartupFailureLineV1(error);
		expect(line).toBe(executorLine("unclassified"));
		expect(line).not.toContain("synthetic");
	});

	it("prints the reason from the runner entry and keeps the failed exit", () => {
		// Under the test loader the runner fails its own process protection first.
		const result = spawnSync(
			process.execPath,
			[
				"--disable-sigusr1",
				"--import",
				"tsx",
				"src/session-executor-runner.ts",
				"run",
			],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toBe(`${executorLine("unclassified")}\n`);
	});
});

describe("Runtime Host startup failure reason (#3054)", () => {
	it.each([...runtimeHostStartupReasonsV1])(
		"names the fixed internal code %s",
		(code) => {
			expect(runtimeHostStartupFailureLineV1(new Error(code))).toBe(
				hostLine("RUNTIME_STARTUP_FAILED", code),
			);
		},
	);

	it.each([
		["an unknown message", new Error(canary)],
		[
			"a code with extra text",
			new Error(`CODEX_EXECUTOR_STILL_DRAINING ${canary}`),
		],
		[
			"a system error code",
			Object.assign(new Error(canary), { code: "EADDRINUSE" }),
		],
		["a thrown string", "CODEX_SESSION_EXECUTOR_INVALID"],
		["nothing", undefined],
	])("reports %s as unclassified without its message", (_name, error) => {
		const line = runtimeHostStartupFailureLineV1(error);
		expect(line).toBe(hostLine("RUNTIME_STARTUP_FAILED", "unclassified"));
		expect(line).not.toContain("synthetic");
	});

	it.each([
		"RUNTIME_CONFIGURATION_INVALID",
		"RUNTIME_CODEX_PROVENANCE_MISMATCH",
		"RUNTIME_FILE_EXCHANGE_CONFIGURATION_INVALID",
	])("keeps the passed-through code %s without a reason", (code) => {
		expect(runtimeHostStartupFailureLineV1(new Error(code))).toBe(
			hostLine(code),
		);
	});

	it("keeps a RuntimeHostError code without a reason or its message", () => {
		const line = runtimeHostStartupFailureLineV1(
			new RuntimeHostError("RUNTIME_PROCESS_PROTECTION_INVALID", canary, 503),
		);
		expect(line).toBe(hostLine("RUNTIME_PROCESS_PROTECTION_INVALID"));
	});
});
