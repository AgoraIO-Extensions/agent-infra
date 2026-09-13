// Adapted from Paseo claude/query.ts at d1b705a0cd91617a5707fae25d80cb0be3057950.
// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see THIRD_PARTY_NOTICES.md.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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
				child.once("close", finishExit);
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
				const kill = (signal: NodeJS.Signals) => {
					if (child?.pid) {
						try {
							process.kill(-child.pid, signal);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ESRCH")
								throw error;
						}
					}
				};
				try {
					kill("SIGTERM");
				} catch (error) {
					// Darwin can report EPERM while the SDK-killed child is a zombie.
					// Require both reaping and absence of the entire group before continuing.
					if ((error as NodeJS.ErrnoException).code !== "EPERM")
						throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
					let deadline: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([
							exited,
							new Promise<never>((_, reject) => {
								deadline = setTimeout(
									() => reject(new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE")),
									2000,
								);
							}),
						]);
						if (!child.pid) throw new Error();
						try {
							process.kill(-child.pid, 0);
						} catch (probeError) {
							if ((probeError as NodeJS.ErrnoException).code === "ESRCH")
								return;
							throw probeError;
						}
						throw new Error();
					} catch {
						throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
					} finally {
						clearTimeout(deadline);
					}
				}
				const timer = setTimeout(() => {
					try {
						kill("SIGKILL");
					} catch {}
				}, 2000);
				try {
					await exited;
				} finally {
					clearTimeout(timer);
				}
			})();
			return closing;
		},
	};
}
