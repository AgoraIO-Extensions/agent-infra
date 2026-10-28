import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import type { RuntimeExternalActionAuthorization } from "./driver.js";
import { openMessagesRuntimeDriverConformanceFixture } from "./messages-runtime-driver.test-support.js";

it.each([false, true])(
	"runs the pinned Pi CLI and recovers without replaying model calls (keyless: %s)",
	async (keyless) => {
		const path = await mkdtemp(join(tmpdir(), "pi-native-"));
		const authorizeModelAction = vi.fn(
			async (action: RuntimeExternalActionAuthorization) => ({
				relayKey: `synthetic-${action.executionId === "execution-b" ? "alternate" : "primary"}-credential`,
			}),
		);
		const fixture = await openMessagesRuntimeDriverConformanceFixture(
			path,
			false,
			"pi",
			keyless ? authorizeModelAction : undefined,
		);
		try {
			const command = {
				schemaVersion: 2 as const,
				kind: "submit-turn" as const,
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "execution-a",
				turnId: "turn-a",
				operationId: "operation-a",
				input: { text: "synthetic input", attachments: [] },
				selection: {
					schemaVersion: 1 as const,
					modelOptionId: "model-option-primary",
					reasoningLevel: "high",
				},
			};
			const record = await fixture.driver.execute(command);
			expect(record.result.outcome).toBe("accepted");
			await fixture.completeStopAsCompleted();
			expect(
				await fixture.driver.getStatus(
					record.nativeSessionRef,
					command.executionId,
				),
			).toBe("completed");
			const before = await fixture.driver.replayEvents(
				record.nativeSessionRef,
				command.executionId,
			);
			await fixture.driver.close();
			// Crash after native persistence but before the Driver commits the terminal event.
			const file = join(path, record.nativeSessionRef, "state.json");
			const state = JSON.parse(await readFile(file, "utf8"));
			state.turns[0].events.pop();
			state.sequence--;
			state.turns[0].status = "unknown";
			delete state.turns[0].nativeStopReason;
			delete state.operations[0].record;
			await writeFile(file, JSON.stringify(state));
			const keyReadsBeforeRecovery = authorizeModelAction.mock.calls.length;
			await fixture.restart();
			expect(
				await fixture.driver.getStatus(
					record.nativeSessionRef,
					command.executionId,
				),
			).toBe("completed");
			expect(
				(
					await fixture.driver.replayEvents(
						record.nativeSessionRef,
						command.executionId,
					)
				).filter((event) => event.type === "text"),
			).toEqual(before.filter((event) => event.type === "text"));
			expect(await fixture.driver.lookupOperation(command)).toEqual({
				state: "found",
				record,
			});
			expect(await fixture.driver.execute(command)).toEqual(record);
			expect(await fixture.createdTurnCount()).toBe(1);
			expect(authorizeModelAction).toHaveBeenCalledTimes(
				keyReadsBeforeRecovery,
			);
			// Writable project configuration cannot load an extension or override the selection.
			const workspace = join(path, record.nativeSessionRef, "workspace");
			await mkdir(join(workspace, ".pi"));
			const marker = join(path, "untrusted-extension-ran");
			await writeFile(
				join(workspace, ".pi/untrusted.mjs"),
				`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unexpected"); export default function() {}`,
			);
			await writeFile(
				join(workspace, ".pi/settings.json"),
				JSON.stringify({
					extensions: ["./untrusted.mjs"],
					defaultProvider: "untrusted",
					defaultModel: "wrong-model",
				}),
			);
			const next = await fixture.driver.execute({
				...command,
				nativeSessionRef: record.nativeSessionRef,
				executionId: "execution-b",
				turnId: "turn-b",
				operationId: "operation-b",
				selection: {
					...command.selection,
					modelOptionId: "model-option-alternate",
					reasoningLevel: "low",
				},
			});
			await fixture.completeStopAsCompleted();
			expect(next.result.outcome).toBe("accepted");
			expect(JSON.parse(await readFile(file, "utf8")).nativeId).toBe(
				state.nativeId,
			);
			expect(fixture.turnSelections()).toEqual([
				command.selection,
				{
					...command.selection,
					modelOptionId: "model-option-alternate",
					reasoningLevel: "low",
				},
			]);
			await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
			const keyReadsBeforeIdleRecovery = authorizeModelAction.mock.calls.length;
			await fixture.restart();
			expect(
				await fixture.driver.getStatus(record.nativeSessionRef, "execution-b"),
			).toBe("completed");
			expect(authorizeModelAction).toHaveBeenCalledTimes(
				keyReadsBeforeIdleRecovery,
			);
			expect(await fixture.createdTurnCount()).toBe(2);
			await fixture.driver.close();
			const nativeFile = join(
				path,
				record.nativeSessionRef,
				"native/session.jsonl",
			);
			const header = (await readFile(nativeFile, "utf8")).split("\n")[0];
			await writeFile(nativeFile, `${header}\n`);
			await fixture.restart();
			await expect(
				fixture.driver.getStatus(record.nativeSessionRef, "execution-b"),
			).rejects.toThrow("Runtime session could not be recovered");
			await expect(
				fixture.driver.execute({
					...command,
					nativeSessionRef: record.nativeSessionRef,
					executionId: "execution-c",
					turnId: "turn-c",
					operationId: "operation-c",
				}),
			).rejects.toThrow("Runtime session could not be recovered");
			expect(await readFile(nativeFile, "utf8")).toBe(`${header}\n`);
			expect(await fixture.createdTurnCount()).toBe(2);
		} finally {
			await fixture.close();
			await rm(path, { recursive: true, force: true });
		}
	},
	30_000,
);

it.skipIf(process.env.AGENT_INFRA_NATIVE_SHELL_TEST !== "1")(
	"isolates the pinned Pi Bash tool child from native secrets, files, proc and inherited descriptors",
	async () => {
		const { createBashToolDefinition } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const { verifyPiInstallation } = await import("./pi-installation.js");
		const { nativeShellEnvironment } = await import("./native-shell.js");
		const { realpath, open, symlink } = await import("node:fs/promises");
		const { spawn, spawnSync } = await import("node:child_process");
		await verifyPiInstallation();
		expect(process.platform).toBe("linux");
		expect(process.getuid?.()).toBe(1000);
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "pi-shell-boundary-")),
		);
		const workspace = join(root, "session/workspace");
		const native = join(root, "session/native");
		const sibling = join(root, "sibling/workspace");
		const launcher = "/opt/agent-infra/native-shell.mjs";
		const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
		const secret = "synthetic-native-secret-never-in-tool-output";
		const tokenKeys = [
			"AGENT_INFRA_PI_MODEL_TOKEN",
			"AGENT_INFRA_PI_CONNECTION_MCP_TOKEN",
			"AGENT_INFRA_PI_BROWSER_MCP_TOKEN",
			"ANTHROPIC_AUTH_TOKEN",
			"PLATFORM_SERVICE_TOKEN",
		];
		for (const path of [workspace, native, sibling])
			await mkdir(path, { recursive: true });
		const denied = [
			join(root, "host-state.json"),
			join(root, "session/state.json"),
			join(native, "session.jsonl"),
			join(sibling, "private.txt"),
		];
		for (const path of denied) await writeFile(path, secret);
		const startupMarker = join(workspace, "startup-ran");
		const startup = join(root, "malicious-startup");
		await writeFile(startup, `touch ${startupMarker}`);
		await writeFile(join(workspace, ".bashrc"), `touch ${startupMarker}`);
		await symlink(denied[0] as string, join(workspace, "escape"));
		const environment = {
			...nativeShellEnvironment(workspace),
			AGENT_INFRA_NATIVE_SHELL_WORKSPACE: workspace,
			...Object.fromEntries(tokenKeys.map((key) => [key, secret])),
			BASH_ENV: startup,
			NODE_OPTIONS: "",
		};
		const tool = createBashToolDefinition(workspace, {
			shellPath: launcher,
			spawnHook: ({ command }) => ({
				command,
				cwd: workspace,
				env: environment,
			}),
			exposeSessionEnvironment: false,
		});
		try {
			const program = `
const fs = require("node:fs");
const denied = ${JSON.stringify([...denied, join(workspace, "escape"), "/proc/self/environ", `/proc/${process.pid}/environ`, `/proc/${process.pid}/mem`, `/proc/${process.pid}/fd/0`])};
const rejected = p => { try { fs.readFileSync(p); return false; } catch { return true; } };
const keys = ${JSON.stringify(tokenKeys)};
fs.writeFileSync("allowed.txt", "allowed");
process.stdout.write(JSON.stringify({workspace:fs.readFileSync("allowed.txt","utf8")==="allowed",environment:keys.every(k=>!Object.hasOwn(process.env,k)),files:denied.every(rejected),startup:!fs.existsSync(${JSON.stringify(startupMarker)})}));
`;
			const context = { cwd: workspace } as ExtensionToolContext;
			// Rejected launcher inputs must not reach even a local marker write.
			for (const invalid of [
				{
					args: ["-c", "touch invalid-input-ran"],
					cwd: sibling,
					env: environment,
				},
				{
					args: ["-c", "touch invalid-input-ran"],
					cwd: workspace,
					env: { ...environment, AGENT_INFRA_NATIVE_SHELL_WORKSPACE: root },
				},
				{
					args: ["--rcfile", startup, "-c", "touch invalid-input-ran"],
					cwd: workspace,
					env: environment,
				},
			]) {
				const rejected = spawnSync(launcher, invalid.args, {
					cwd: invalid.cwd,
					env: invalid.env,
					encoding: "utf8",
					timeout: 5000,
				});
				expect(rejected.status).toBe(1);
				expect(rejected.stderr).toBe("RUNTIME_NATIVE_SHELL_UNAVAILABLE\n");
			}
			await expect(
				readFile(join(workspace, "invalid-input-ran")),
			).rejects.toMatchObject({ code: "ENOENT" });
			await expect(
				readFile(join(sibling, "invalid-input-ran")),
			).rejects.toMatchObject({ code: "ENOENT" });
			const result = await tool.execute(
				"synthetic-bash",
				{
					command: `/usr/local/bin/node -e ${quote(program)}`,
					timeout: 10,
				},
				undefined,
				undefined,
				context,
			);
			const output = result.content
				.map((item) => (item.type === "text" ? item.text : ""))
				.join("");
			expect(output).not.toContain(secret);
			expect(result.structuredContent, output).toMatchObject({ exit_code: 0 });
			expect(JSON.parse(output)).toEqual({
				workspace: true,
				environment: true,
				files: true,
				startup: true,
			});
			// Exercise an actually inherited secret FD, not just a proc pathname.
			const descriptor = await open(denied[0] as string, "r");
			try {
				const output = await new Promise<string>((accept, reject) => {
					const fdProbe =
						'const fs=require("node:fs");let value="closed";try{value=fs.readFileSync(3,"utf8")}catch{};process.stdout.write(value)';
					const child = spawn(
						launcher,
						["-c", `/usr/local/bin/node -e ${quote(fdProbe)}`],
						{
							cwd: workspace,
							env: environment,
							stdio: ["ignore", "pipe", "pipe", descriptor.fd],
						},
					);
					let text = "";
					const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
					child.stdout?.on("data", (data) => {
						text += data;
					});
					child.stderr?.resume();
					child.once("error", (error) => {
						clearTimeout(timeout);
						reject(error);
					});
					child.once("close", (code) => {
						clearTimeout(timeout);
						return code === 0
							? accept(text)
							: reject(new Error("Shell boundary failed"));
					});
				});
				expect(output).toBe("closed");
			} finally {
				await descriptor.close();
			}
			const abort = new AbortController();
			const pending = tool.execute(
				"synthetic-stop",
				{
					command: "touch shell-started; sleep 30; touch stopped-side-effect",
					timeout: 10,
				},
				abort.signal,
				undefined,
				context,
			);
			for (let attempt = 0; attempt < 100; attempt++) {
				if (
					await readFile(join(workspace, "shell-started")).then(
						() => true,
						() => false,
					)
				)
					break;
				await new Promise((accept) => setTimeout(accept, 20));
			}
			await expect(
				readFile(join(workspace, "shell-started")),
			).resolves.toBeDefined();
			abort.abort();
			await expect(pending).rejects.toThrow();
			await expect(
				readFile(join(workspace, "stopped-side-effect")),
			).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);

it.skipIf(process.env.AGENT_INFRA_NATIVE_SHELL_TEST !== "1")(
	"executes the isolated Bash capability through the pinned Pi CLI and restores its tool facts without replay",
	async () => {
		const path = await mkdtemp(join(tmpdir(), "pi-cli-shell-"));
		const fixture = await openMessagesRuntimeDriverConformanceFixture(
			path,
			false,
			"pi",
		);
		try {
			const command = {
				schemaVersion: 2 as const,
				kind: "submit-turn" as const,
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "execution-shell",
				turnId: "turn-shell",
				operationId: "operation-shell",
				input: { text: "synthetic shell capability", attachments: [] },
				selection: {
					schemaVersion: 1 as const,
					modelOptionId: "model-option-primary",
					reasoningLevel: "high",
				},
			};
			fixture.nextTool("sandbox_bash", {
				command:
					"printf 'isolated-native-bash' > native-shell-result.txt; cat native-shell-result.txt",
				timeout: 5,
			});
			const accepted = await fixture.driver.execute(command);
			expect(accepted.result.outcome).toBe("accepted");
			await vi.waitFor(() => expect(fixture.modelRequests()).toHaveLength(2), {
				timeout: 10_000,
			});
			const tools = fixture.modelRequests()[0]?.tools as { name: string }[];
			expect(tools.map((tool) => tool.name)).toContain("sandbox_bash");
			expect(tools.map((tool) => tool.name)).not.toContain("bash");
			await expect(
				readFile(
					join(
						path,
						accepted.nativeSessionRef,
						"workspace/native-shell-result.txt",
					),
					"utf8",
				),
			).resolves.toBe("isolated-native-bash");
			expect(JSON.stringify(fixture.modelRequests()[1]?.messages)).toContain(
				"isolated-native-bash",
			);
			await fixture.completeStopAsCompleted();
			const events = await fixture.driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "tool",
						payload: expect.objectContaining({
							name: "Bash",
							phase: "started",
						}),
					}),
					expect.objectContaining({
						type: "tool",
						payload: expect.objectContaining({
							name: "Bash",
							phase: "completed",
						}),
					}),
				]),
			);
			const calls = await fixture.createdTurnCount();
			const installed = await (
				await import("./pi-installation.js")
			).verifyPiInstallation();
			const { spawn } = await import("node:child_process");
			const { nativeShellEnvironment } = await import("./native-shell.js");
			const workspace = join(path, accepted.nativeSessionRef, "workspace");
			const missingExtension = await new Promise<{
				code: number | null;
				output: string;
			}>((accept, reject) => {
				const child = spawn(
					installed.executable,
					[
						installed.cli,
						"--no-extensions",
						"--no-skills",
						"--no-prompt-templates",
						"--no-themes",
						"--no-context-files",
						"--no-session",
						"--mode",
						"rpc",
						"--tools",
						"sandbox_bash",
						"--extension",
						join(path, "missing-policy.mjs"),
					],
					{
						cwd: workspace,
						env: {
							...nativeShellEnvironment(workspace),
							PI_CODING_AGENT_DIR: join(
								path,
								accepted.nativeSessionRef,
								"config",
							),
						},
						stdio: ["pipe", "pipe", "pipe"],
					},
				);
				let output = "";
				child.stdout.on("data", (data) => {
					output += data;
				});
				child.stderr.on("data", (data) => {
					output += data;
				});
				child.stdin.end();
				const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
				child.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.once("close", (code) => {
					clearTimeout(timer);
					accept({ code, output });
				});
			});
			expect(missingExtension.code).not.toBeNull();
			expect(missingExtension.code).not.toBe(0);
			expect(missingExtension.output).toMatch(/sandbox_bash|missing-policy/);
			await fixture.restart();
			expect(
				await fixture.driver.getStatus(
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toBe("completed");
			expect(
				await fixture.driver.replayEvents(
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toEqual(events);
			expect(await fixture.driver.execute(command)).toEqual(accepted);
			expect(await fixture.createdTurnCount()).toBe(calls);
		} finally {
			await fixture.close();
			await rm(path, { recursive: true, force: true });
		}
	},
	30_000,
);
