// Adapted from Paseo claude/query.ts at d1b705a0cd91617a5707fae25d80cb0be3057950.
// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see THIRD_PARTY_NOTICES.md.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
	type Options,
	query,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export function claudeQuery(options: Options, message: SDKUserMessage) {
	let child: ChildProcessWithoutNullStreams | undefined;
	let finishInput: () => void = () => {};
	const inputEnded = new Promise<void>((resolve) => {
		finishInput = resolve;
	});
	let finishExit: () => void = () => {};
	let childClosed = false;
	const exited = new Promise<void>((resolve) => {
		finishExit = resolve;
	});
	const native = query({
		prompt: (async function* () {
			yield message;
			await inputEnded;
		})(),
		options: {
			...options,
			spawnClaudeCodeProcess: (spawnOptions) => {
				const command =
					spawnOptions.command === "node" || spawnOptions.command === "bun"
						? process.execPath
						: spawnOptions.command;
				child = spawn(command, spawnOptions.args, {
					cwd: spawnOptions.cwd,
					env: spawnOptions.env,
					stdio: ["pipe", "pipe", "pipe"],
					shell: false,
					detached: true,
				});
				child.stderr.resume();
				child.once("close", () => {
					childClosed = true;
					finishExit();
				});
				child.on("error", () => {});
				return child;
			},
			stderr: () => {},
		},
	});
	let closing: Promise<void> | undefined;
	return {
		query: native,
		exited,
		close() {
			closing ??= (async () => {
				finishInput();
				native.close();
				if (!child) return;
				const pid = child.pid;
				if (!pid) throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
				for (const signal of ["SIGTERM", "SIGKILL"] as const) {
					try {
						process.kill(-pid, signal);
					} catch (error) {
						// Darwin may report EPERM for an SDK-killed, not-yet-reaped child.
						if (
							!["ESRCH", "EPERM"].includes(
								(error as NodeJS.ErrnoException).code ?? "",
							)
						)
							throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
					}
					const deadline = Date.now() + 2000;
					do {
						let groupGone = false;
						try {
							process.kill(-pid, 0);
						} catch (error) {
							const code = (error as NodeJS.ErrnoException).code;
							if (code === "ESRCH") groupGone = true;
							else if (code !== "EPERM")
								throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
						}
						if (childClosed && groupGone) return;
						await delay(25);
					} while (Date.now() < deadline);
				}
				throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
			})();
			return closing;
		},
	};
}
