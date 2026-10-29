import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
	access,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type OpenCodeRuntimeOptions,
	openOpenCodeRuntime,
} from "./opencode-bootstrap.js";
import { openPiRuntime } from "./pi-bootstrap.js";

describe.each(["Pi", ...(process.env.OPENCODE_EXECUTABLE ? ["OpenCode"] : [])])(
	"%s native Messages",
	(runtime) => {
		const openNative = (options: OpenCodeRuntimeOptions) =>
			runtime === "Pi" ? openPiRuntime(options) : openOpenCodeRuntime(options);
		it.each(["http", "content-type", "stream"] as const)(
			"persists trusted Messages diagnostics from the real native caller: %s",
			async (failure) => {
				const path = await mkdtemp(
					join(tmpdir(), "messages-caller-diagnostic-"),
				);
				let calls = 0;
				const server = createServer(async (request, response) => {
					for await (const _chunk of request) {
						// Consume the real native request without retaining its contents.
					}
					calls++;
					response.writeHead(failure === "http" ? 502 : 200, {
						"content-type":
							failure === "stream" ? "text/event-stream" : "application/json",
					});
					response.end(
						failure === "stream"
							? 'event: error\ndata: {"type":"error","error":{"message":"synthetic private upstream failure"}}\n\n'
							: JSON.stringify({ error: "synthetic private upstream failure" }),
					);
				});
				await new Promise<void>((resolve) =>
					server.listen(0, "127.0.0.1", resolve),
				);
				const address = server.address();
				if (!address || typeof address === "string") throw new Error();
				const driver = await openNative({
					path,
					executable: process.env.OPENCODE_EXECUTABLE ?? "",
					configVersion: "diagnostic-configuration",
					defaultModelOptionId: "primary",
					defaultReasoningLevel: "high",
					modelOptions: [
						{
							modelOptionId: "primary",
							model: "claude-opus-4-6",
							reasoningLevels: ["high"],
							endpoint: `http://127.0.0.1:${address.port}`,
							credential: "synthetic-native-credential",
							authentication: "bearer",
						},
					],
				});
				try {
					const result = await driver.execute({
						schemaVersion: 2,
						kind: "submit-turn",
						agentId: "agent-diagnostic",
						conversationId: "conversation-diagnostic",
						sessionGeneration: 1,
						executionId: "execution-diagnostic",
						turnId: "turn-diagnostic",
						operationId: "operation-diagnostic",
						input: { text: "Return a short answer", attachments: [] },
						selection: {
							schemaVersion: 1,
							modelOptionId: "primary",
							reasoningLevel: "high",
						},
					});
					expect(result.result.outcome).toBe("accepted");
					await vi.waitFor(
						async () => {
							expect(["failed", "unknown"]).toContain(
								await driver.getStatus(
									result.nativeSessionRef,
									"execution-diagnostic",
								),
							);
						},
						{ timeout: 20_000 },
					);
					expect(calls).toBe(1);
					const state = JSON.parse(
						await readFile(
							join(path, result.nativeSessionRef, "state.json"),
							"utf8",
						),
					);
					const facts = state.turns[0].operationFacts.filter(
						(fact: { kind: string }) => fact.kind === "model",
					);
					expect(facts.map((fact: { phase: string }) => fact.phase)).toEqual([
						"intent",
						"started",
						runtime === "Pi" ? "failed" : "unknown",
					]);
					await vi.waitFor(async () => {
						const diagnostics = JSON.parse(
							await readFile(
								join(
									path,
									result.nativeSessionRef,
									"messages-diagnostics.json",
								),
								"utf8",
							),
						);
						expect(JSON.stringify(diagnostics)).not.toMatch(
							/synthetic-native-credential|synthetic private upstream failure|127\.0\.0\.1/,
						);
						expect(diagnostics.entries).toContainEqual(
							expect.objectContaining({
								executionId: "execution-diagnostic",
								operationRef: facts[0].operationRef,
								attemptRef: facts[0].attemptRef,
								diagnostic: expect.objectContaining({
									stage:
										failure === "http"
											? "upstream_http"
											: failure === "content-type"
												? "upstream_content_type"
												: "stream_validation",
									...(failure === "http"
										? { statusCode: 502, statusClass: "5xx" }
										: {}),
									sent: true,
								}),
							}),
						);
					});
				} finally {
					await driver.close();
					server.closeAllConnections();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					await rm(path, { recursive: true, force: true });
				}
			},
			30_000,
		);
		it("uses the selected Messages model and effort through the unmodified Runtime and resumes confirmed history", async () => {
			const path = await mkdtemp(join(tmpdir(), "opencode-native-"));
			const calls: {
				model: string;
				effort: string;
				authentication: string | undefined;
			}[] = [];
			const server = createServer(async (req, res) => {
				let body = "";
				for await (const chunk of req) body += chunk;
				const request = JSON.parse(body);
				calls.push({
					model: request.model,
					effort: request.output_config?.effort,
					authentication: req.headers.authorization,
				});
				res.writeHead(200, { "content-type": "text/event-stream" });
				for (const event of [
					{
						type: "message_start",
						message: {
							id: "msg_synthetic",
							type: "message",
							role: "assistant",
							model: request.model,
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 10, output_tokens: 0 },
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "synthetic native result" },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: { output_tokens: 5 },
					},
					{ type: "message_stop" },
				])
					res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
				res.end();
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const address = server.address();
			if (!address || typeof address === "string") throw new Error();
			const options = {
				path,
				executable: process.env.OPENCODE_EXECUTABLE ?? "",
				configVersion: "configuration-a",
				defaultModelOptionId: "primary",
				defaultReasoningLevel: "high",
				modelOptions: [
					{
						modelOptionId: "primary",
						model: "claude-opus-4-6",
						reasoningLevels: ["high"],
						endpoint: `http://127.0.0.1:${address.port}`,
						credential: "synthetic-native-credential",
						authentication: "bearer" as const,
					},
				],
			};
			let driver = await openNative(options);
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
					input: { text: "Return a short answer", attachments: [] },
					selection: {
						schemaVersion: 1 as const,
						modelOptionId: "primary",
						reasoningLevel: "high",
					},
				};
				const accepted = await driver.execute(command);
				expect(accepted.result.outcome).toBe("accepted");
				await vi.waitFor(
					async () =>
						expect(
							await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
						).toBe("completed"),
					{ timeout: 20_000 },
				);
				const events = await driver.replayEvents(
					accepted.nativeSessionRef,
					"execution-a",
				);
				expect(
					events
						.filter((e) => e.type === "text")
						.map((e) => e.payload.delta)
						.join(""),
				).toBe("synthetic native result");
				expect(calls).toEqual([
					{
						model: "claude-opus-4-6",
						effort: "high",
						authentication: "Bearer synthetic-native-credential",
					},
				]);
				if (runtime === "OpenCode") {
					await expect(
						access(
							join(path, accepted.nativeSessionRef, "config/opencode"),
							constants.W_OK,
						),
					).rejects.toMatchObject({ code: "EACCES" });
					await expect(
						access(join(path, accepted.nativeSessionRef, "home/.npm/_cacache")),
					).rejects.toMatchObject({ code: "ENOENT" });
				}
				await driver.close();
				driver = await openNative(options);
				expect(await driver.execute(command)).toEqual(accepted);
				expect(
					await driver.replayEvents(accepted.nativeSessionRef, "execution-a"),
				).toEqual(events);
				const next = await driver.execute({
					...command,
					nativeSessionRef: accepted.nativeSessionRef,
					operationId: "operation-b",
					executionId: "execution-b",
					turnId: "turn-b",
				});
				await vi.waitFor(
					async () =>
						expect(
							await driver.getStatus(next.nativeSessionRef, "execution-b"),
						).toBe("completed"),
					{ timeout: 20_000 },
				);
				expect(calls).toHaveLength(2);
				await driver.execute({
					...command,
					nativeSessionRef: accepted.nativeSessionRef,
					operationId: "operation-c",
					executionId: "execution-c",
					turnId: "turn-c",
				});
				await vi.waitFor(
					async () =>
						expect(
							await driver.getStatus(accepted.nativeSessionRef, "execution-c"),
						).toBe("completed"),
					{ timeout: 20_000 },
				);
				expect(calls).toHaveLength(3);
				await vi.waitFor(async () => {
					const diagnostics = JSON.parse(
						await readFile(
							join(
								path,
								accepted.nativeSessionRef,
								"messages-diagnostics.json",
							),
							"utf8",
						),
					);
					const journal = JSON.parse(
						await readFile(
							join(path, accepted.nativeSessionRef, "state.json"),
							"utf8",
						),
					);
					expect(
						diagnostics.entries.map(
							(entry: { executionId: string }) => entry.executionId,
						),
					).toEqual(["execution-a", "execution-b", "execution-c"]);
					for (const [index, entry] of diagnostics.entries.entries()) {
						expect(entry.state).toBe("completed");
						expect(journal.turns[index].operationFacts).toContainEqual(
							expect.objectContaining({
								kind: "model",
								operationRef: entry.operationRef,
								attemptRef: entry.attemptRef,
							}),
						);
					}
				});
			} finally {
				await driver.close();
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await rm(path, { recursive: true, force: true });
			}
		}, 60_000);

		it.each(["read", "write", "edit"])(
			"allows owner %s and denies foreign paths and symlink escapes through native permission",
			async (toolName) => {
				const path = await mkdtemp(join(tmpdir(), "opencode-tools-"));
				const calls: string[] = [];
				let target = "owner.txt";
				let sequence = 0;
				const server = createServer(async (req, res) => {
					let body = "";
					for await (const chunk of req) body += chunk;
					const request = JSON.parse(body);
					calls.push(body);
					sequence++;
					const isToolResult = calls.length > 1;
					res.writeHead(200, { "content-type": "text/event-stream" });
					const emit = (value: { type: string; [key: string]: unknown }) =>
						res.write(
							`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
						);
					emit({
						type: "message_start",
						message: {
							id: `msg_${sequence}`,
							type: "message",
							role: "assistant",
							model: request.model,
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 10, output_tokens: 0 },
						},
					});
					if (!isToolResult) {
						emit({
							type: "content_block_start",
							index: 0,
							content_block: {
								type: "tool_use",
								id: `tool_${sequence}`,
								name: toolName,
								input: {},
							},
						});
						emit({
							type: "content_block_delta",
							index: 0,
							delta: {
								type: "input_json_delta",
								partial_json: JSON.stringify({
									[runtime === "Pi" ? "path" : "filePath"]: target,
									...(toolName === "write"
										? { content: "synthetic replacement" }
										: toolName === "edit"
											? {
													[runtime === "Pi" ? "oldText" : "oldString"]:
														"prefix",
													[runtime === "Pi" ? "newText" : "newString"]:
														"changed",
												}
											: {}),
								}),
							},
						});
					} else {
						emit({
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "" },
						});
						emit({
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "synthetic tool done" },
						});
					}
					emit({ type: "content_block_stop", index: 0 });
					emit({
						type: "message_delta",
						delta: {
							stop_reason: isToolResult ? "end_turn" : "tool_use",
							stop_sequence: null,
						},
						usage: { output_tokens: 10 },
					});
					emit({ type: "message_stop" });
					res.end();
				});
				await new Promise<void>((resolve) =>
					server.listen(0, "127.0.0.1", resolve),
				);
				const address = server.address();
				if (!address || typeof address === "string") throw new Error();
				const driver = await openNative({
					path: join(path, "driver"),
					executable: process.env.OPENCODE_EXECUTABLE ?? "",
					configVersion: "configuration-a",
					defaultModelOptionId: "primary",
					defaultReasoningLevel: "high",
					modelOptions: [
						{
							modelOptionId: "primary",
							model: "claude-opus-4-6",
							reasoningLevels: ["high"],
							endpoint: `http://127.0.0.1:${address.port}`,
							credential: "synthetic-native-credential",
							authentication: "bearer",
						},
					],
				});
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
						input: { text: "Read the requested file", attachments: [] },
						selection: {
							schemaVersion: 1 as const,
							modelOptionId: "primary",
							reasoningLevel: "high",
						},
					};
					// A rejected selection creates the public binding without executing a Turn.
					const binding = await driver.execute({
						...command,
						operationId: "prepare",
						selection: { ...command.selection, modelOptionId: "missing" },
					});
					const workspace = join(
						path,
						"driver",
						binding.nativeSessionRef,
						"workspace",
					);
					const { mkdir } = await import("node:fs/promises");
					await mkdir(workspace);
					await writeFile(
						join(workspace, "owner.txt"),
						"prefix\nSYNTHETIC_OWNER_CANARY",
					);
					await writeFile(
						join(path, "foreign.txt"),
						"prefix\nSYNTHETIC_FOREIGN_CANARY",
					);
					const accepted = await driver.execute(command);
					await vi.waitFor(
						async () =>
							expect(
								await driver.getStatus(
									accepted.nativeSessionRef,
									"execution-a",
								),
							).toBe("completed"),
						{ timeout: 20_000 },
					);
					if (toolName === "read")
						expect(calls.at(-1)).toContain("SYNTHETIC_OWNER_CANARY");
					expect(await readFile(join(workspace, "owner.txt"), "utf8")).toBe(
						toolName === "write"
							? "synthetic replacement"
							: toolName === "edit"
								? "changed\nSYNTHETIC_OWNER_CANARY"
								: "prefix\nSYNTHETIC_OWNER_CANARY",
					);
					expect(
						(
							await driver.replayEvents(
								accepted.nativeSessionRef,
								"execution-a",
							)
						).filter((e) => e.type === "tool"),
					).toContainEqual(
						expect.objectContaining({
							payload: expect.objectContaining({ phase: "completed" }),
						}),
					);
					calls.length = 0;
					target = join(path, "foreign.txt");
					const foreign = await driver.execute({
						...command,
						conversationId: "conversation-b",
						operationId: "foreign",
						executionId: "execution-b",
						turnId: "turn-b",
					});
					await vi.waitFor(
						async () =>
							expect(
								await driver.getStatus(foreign.nativeSessionRef, "execution-b"),
							).toBe("completed"),
						{ timeout: 20_000 },
					);
					expect(calls).toHaveLength(2);
					expect(calls.at(-1)).not.toContain("SYNTHETIC_FOREIGN_CANARY");
					expect(
						(
							await driver.replayEvents(foreign.nativeSessionRef, "execution-b")
						).filter((e) => e.type === "tool"),
					).toContainEqual(
						expect.objectContaining({
							payload: expect.objectContaining({ phase: "failed" }),
						}),
					);
					calls.length = 0;
					const foreignWorkspace = join(
						path,
						"driver",
						foreign.nativeSessionRef,
						"workspace",
					);
					await symlink(
						join(path, "foreign.txt"),
						join(foreignWorkspace, "escape.txt"),
					);
					target = "escape.txt";
					const escaped = await driver.execute({
						...command,
						conversationId: "conversation-b",
						nativeSessionRef: foreign.nativeSessionRef,
						executionId: "execution-escape",
						turnId: "turn-escape",
						operationId: "escape",
					});
					await vi.waitFor(
						async () =>
							expect(
								await driver.getStatus(
									escaped.nativeSessionRef,
									"execution-escape",
								),
							).toBe("completed"),
						{ timeout: 20_000 },
					);
					// OpenCode may finish the prompt immediately after a denied ACP permission.
					// Check the actual persisted native tool result even when there is no next model call.
					expect(calls.length).toBeGreaterThan(0);
					const directory = join(path, "driver", escaped.nativeSessionRef);
					const saved = JSON.parse(
						await readFile(join(directory, "state.json"), "utf8"),
					);
					if (runtime === "Pi") {
						const entries = (
							await readFile(join(directory, "native/session.jsonl"), "utf8")
						)
							.trim()
							.split("\n")
							.map((line) => JSON.parse(line));
						expect(entries[0].id).toBe(saved.nativeId);
						expect(JSON.stringify(entries)).not.toContain(
							"SYNTHETIC_FOREIGN_CANARY",
						);
						const messages = entries
							.filter((entry) => entry.type === "message")
							.map((entry) => entry.message);
						const ids = new Set(
							messages
								.filter((message) => message.role === "assistant")
								.flatMap((message) => message.content)
								.filter(
									(part) =>
										part.type === "toolCall" &&
										part.name === toolName &&
										part.arguments?.path === "escape.txt",
								)
								.map((part) => part.id),
						);
						const results = messages.filter(
							(message) =>
								message.role === "toolResult" && ids.has(message.toolCallId),
						);
						expect(results.length).toBeGreaterThan(0);
						expect(results.every((message) => message.isError === true)).toBe(
							true,
						);
					} else {
						const history = JSON.parse(
							execFileSync(
								process.env.OPENCODE_EXECUTABLE ?? "",
								["export", saved.nativeId],
								{
									cwd: foreignWorkspace,
									env: {
										PATH: "/usr/bin:/bin",
										HOME: join(directory, "home"),
										XDG_CONFIG_HOME: join(directory, "config"),
										XDG_DATA_HOME: join(directory, "data"),
										XDG_STATE_HOME: join(directory, "state"),
										XDG_CACHE_HOME: join(directory, "cache"),
										TMPDIR: join(directory, "tmp"),
										OPENCODE_DISABLE_PROJECT_CONFIG: "true",
										OPENCODE_DISABLE_AUTOUPDATE: "true",
										OPENCODE_DISABLE_MODELS_FETCH: "true",
									},
									encoding: "utf8",
									timeout: 20_000,
									maxBuffer: 4_194_304,
									stdio: ["pipe", "pipe", "pipe"],
								},
							),
						);
						expect(history.info.id).toBe(saved.nativeId);
						expect(JSON.stringify(history)).not.toContain(
							"SYNTHETIC_FOREIGN_CANARY",
						);
						const nativeCalls = history.messages
							.flatMap((message: { parts: unknown[] }) => message.parts)
							.filter(
								(part: {
									type?: string;
									tool?: string;
									state?: { input?: { filePath?: string } };
								}) =>
									part.type === "tool" &&
									part.tool === toolName &&
									part.state?.input?.filePath === "escape.txt",
							);
						expect(nativeCalls).toContainEqual(
							expect.objectContaining({
								state: expect.objectContaining({ status: "error" }),
							}),
						);
						expect(
							nativeCalls.every(
								(part: { state: { status: string } }) =>
									part.state.status === "error",
							),
						).toBe(true);
					}
					expect(calls.at(-1)).not.toContain("SYNTHETIC_FOREIGN_CANARY");
					const escapeEvents = await driver.replayEvents(
						escaped.nativeSessionRef,
						"execution-escape",
					);
					expect(escapeEvents.filter((e) => e.type === "tool")).toContainEqual(
						expect.objectContaining({
							payload: expect.objectContaining({ phase: "failed" }),
						}),
					);
					expect(JSON.stringify(escapeEvents)).not.toContain(
						"SYNTHETIC_FOREIGN_CANARY",
					);
					expect(await readFile(join(path, "foreign.txt"), "utf8")).toBe(
						"prefix\nSYNTHETIC_FOREIGN_CANARY",
					);
					calls.length = 0;
					target = "owner.txt";
					await writeFile(
						join(foreignWorkspace, target),
						"prefix\nSYNTHETIC_RECOVERY_CONTROL",
					);
					const afterDenial = await driver.execute({
						...command,
						conversationId: "conversation-b",
						nativeSessionRef: foreign.nativeSessionRef,
						executionId: "execution-after-denial",
						turnId: "turn-after-denial",
						operationId: "after-denial",
					});
					await vi.waitFor(
						async () =>
							expect(
								await driver.getStatus(
									afterDenial.nativeSessionRef,
									"execution-after-denial",
								),
							).toBe("completed"),
						{ timeout: 20_000 },
					);
					expect(calls).toHaveLength(2);
					expect(
						(
							await driver.replayEvents(
								afterDenial.nativeSessionRef,
								"execution-after-denial",
							)
						).filter((e) => e.type === "tool"),
					).toContainEqual(
						expect.objectContaining({
							payload: expect.objectContaining({ phase: "completed" }),
						}),
					);
				} finally {
					await driver.close();
					server.closeAllConnections();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					await rm(path, { recursive: true, force: true });
				}
			},
			60_000,
		);
	},
);

it.skipIf(process.env.AGENT_INFRA_NATIVE_SHELL_TEST !== "1")(
	"executes pinned OpenCode ACP Bash through the child boundary without exposing native configuration",
	async () => {
		const { openMessagesRuntimeDriverConformanceFixture } = await import(
			"./messages-runtime-driver.test-support.js"
		);
		const path = await mkdtemp(join(tmpdir(), "opencode-shell-boundary-"));
		const fixture = await openMessagesRuntimeDriverConformanceFixture(
			path,
			false,
			"opencode",
		);
		try {
			const marker = "synthetic-host-file-not-readable";
			const forbidden = join(path, "host-secret");
			await writeFile(forbidden, marker);
			const program = `const fs=require("node:fs");const denied=p=>{try{fs.readFileSync(p);return false}catch{return true}};fs.writeFileSync("shell-proof.json",JSON.stringify({env:!Object.hasOwn(process.env,"OPENCODE_CONFIG_CONTENT"),host:denied(${JSON.stringify(forbidden)}),proc:denied("/proc/self/environ"),native:denied("../process.json")}));process.stdout.write("isolated-opencode-shell");`;
			const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
			fixture.nextTool("bash", {
				command: `/usr/local/bin/node -e ${quote(program)}`,
				description: "Verify isolated shell",
				timeout: 5000,
			});
			const command = {
				schemaVersion: 2 as const,
				kind: "submit-turn" as const,
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "execution-shell",
				turnId: "turn-shell",
				operationId: "operation-shell",
				input: { text: "synthetic shell probe", attachments: [] },
				selection: {
					schemaVersion: 1 as const,
					modelOptionId: "model-option-primary",
					reasoningLevel: "high",
				},
			};
			const accepted = await fixture.driver.execute(command);
			expect(accepted.result.outcome).toBe("accepted");
			await vi.waitFor(() => expect(fixture.modelRequests()).toHaveLength(2), {
				timeout: 15_000,
			});
			const proof = JSON.parse(
				await readFile(
					join(path, accepted.nativeSessionRef, "workspace/shell-proof.json"),
					"utf8",
				),
			);
			expect(proof).toEqual({
				env: true,
				host: true,
				proc: true,
				native: true,
			});
			const messages = JSON.stringify(fixture.modelRequests()[1]?.messages);
			expect(messages).toContain("isolated-opencode-shell");
			expect(messages).not.toContain(marker);
			await fixture.completeStopAsCompleted();
			const events = await fixture.driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(
				events
					.filter(
						(event) => event.type === "tool" && event.payload.name === "Bash",
					)
					.map((event) => (event.type === "tool" ? event.payload.phase : "")),
			).toEqual(["started", "completed"]);
			const calls = await fixture.createdTurnCount();
			await fixture.restart();
			expect(
				await fixture.driver.getStatus(
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toBe("completed");
			expect(await fixture.driver.execute(command)).toEqual(accepted);
			expect(await fixture.createdTurnCount()).toBe(calls);
			expect(
				await fixture.driver.replayEvents(
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toEqual(events);
		} finally {
			await fixture.close();
			await rm(path, { recursive: true, force: true });
		}
	},
	45_000,
);

it.skipIf(!process.env.OPENCODE_EXECUTABLE)(
	"executes the native OpenCode fetch and todo catalog with stable tool identities",
	async () => {
		const { openMessagesRuntimeDriverConformanceFixture } = await import(
			"./messages-runtime-driver.test-support.js"
		);
		const path = await mkdtemp(join(tmpdir(), "opencode-network-catalog-"));
		let gets = 0;
		const server = createServer((_request, response) => {
			gets++;
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<html><body>Synthetic OpenCode web content.</body></html>");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw Error();
		const fixture = await openMessagesRuntimeDriverConformanceFixture(
			path,
			false,
			"opencode",
		);
		try {
			let ref: string | undefined;
			for (const [name, input, label] of [
				[
					"webfetch",
					{ url: `http://127.0.0.1:${address.port}/`, format: "text" },
					"WebFetch",
				],
				[
					"todowrite",
					{
						todos: [
							{
								content: "Synthetic todo",
								status: "completed",
								priority: "medium",
							},
						],
					},
					"TodoWrite",
				],
				["glob", { pattern: "*.missing" }, "Glob"],
				["grep", { pattern: "synthetic-absent" }, "Grep"],
			] as const) {
				fixture.nextTool(name, input);
				const command = {
					schemaVersion: 2 as const,
					kind: "submit-turn" as const,
					agentId: "agent-a",
					conversationId: "conversation-a",
					sessionGeneration: 1,
					executionId: `execution-${name}`,
					turnId: `turn-${name}`,
					operationId: `operation-${name}`,
					input: { text: "synthetic native catalog", attachments: [] },
					selection: {
						schemaVersion: 1 as const,
						modelOptionId: "model-option-primary",
						reasoningLevel: "high",
					},
					...(ref ? { nativeSessionRef: ref } : {}),
				};
				const before = fixture.modelRequests().length;
				const accepted = await fixture.driver.execute(command);
				ref = accepted.nativeSessionRef;
				await vi.waitFor(
					() => expect(fixture.modelRequests().length).toBe(before + 2),
					{ timeout: 15000 },
				);
				await fixture.completeStopAsCompleted();
				const events = await fixture.driver.replayEvents(
					ref,
					command.executionId,
				);
				expect(
					events
						.filter(
							(event) => event.type === "tool" && event.payload.name === label,
						)
						.map((event) => (event.type === "tool" ? event.payload.phase : "")),
				).toEqual(["started", "completed"]);
				await fixture.restart();
				expect(
					await fixture.driver.replayEvents(ref, command.executionId),
				).toEqual(events);
				expect(fixture.modelRequests()).toHaveLength(before + 2);
			}
			expect(gets).toBe(1);
		} finally {
			await fixture.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(path, { recursive: true, force: true });
		}
	},
	60000,
);

it.skipIf(!process.env.OPENCODE_EXECUTABLE)(
	"executes model-selected native apply_patch and rejects foreign destinations",
	async () => {
		const { openMessagesRuntimeDriverConformanceFixture } = await import(
			"./messages-runtime-driver.test-support.js"
		);
		const root = await mkdtemp(join(tmpdir(), "opencode-patch-native-"));
		const fixture = await openMessagesRuntimeDriverConformanceFixture(
			root,
			false,
			"opencode",
			undefined,
			"gpt-5",
		);
		try {
			let ref: string | undefined;
			for (const [index, target] of [
				"allowed.txt",
				"../../foreign-patch.txt",
			].entries()) {
				fixture.nextTool("apply_patch", {
					patchText: `*** Begin Patch\n*** Add File: ${target}\n+synthetic patch\n*** End Patch`,
				});
				const command = {
					schemaVersion: 2 as const,
					kind: "submit-turn" as const,
					agentId: "agent-a",
					conversationId: "conversation-a",
					sessionGeneration: 1,
					executionId: `patch-${index}`,
					turnId: `patch-turn-${index}`,
					operationId: `patch-operation-${index}`,
					input: { text: "synthetic native patch", attachments: [] },
					selection: {
						schemaVersion: 1 as const,
						modelOptionId: "model-option-primary",
						reasoningLevel: "high",
					},
					...(ref ? { nativeSessionRef: ref } : {}),
				};
				const before = fixture.modelRequests().length;
				const accepted = await fixture.driver.execute(command);
				ref = accepted.nativeSessionRef;
				await vi.waitFor(
					() => expect(fixture.modelRequests().length).toBe(before + 2),
					{ timeout: 15000 },
				);
				await fixture.completeStopAsCompleted();
				const events = await fixture.driver.replayEvents(
					ref,
					command.executionId,
				);
				expect(
					events
						.filter(
							(event) =>
								event.type === "tool" && event.payload.name === "ApplyPatch",
						)
						.map((event) => (event.type === "tool" ? event.payload.phase : "")),
				).toEqual(["started", index === 0 ? "completed" : "failed"]);
				if (index === 0)
					expect(
						await readFile(join(root, ref, "workspace/allowed.txt"), "utf8"),
					).toContain("synthetic patch");
				else
					await expect(
						readFile(join(root, "foreign-patch.txt")),
					).rejects.toThrow();
			}
		} finally {
			await fixture.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	45000,
);

it.skipIf(!process.env.OPENCODE_EXECUTABLE)(
	"executes fixed anonymous Exa search without forwarding native credentials",
	async () => {
		const { nativeNetworkFixture } = await import(
			"./native-network.test-support.js"
		);
		const processModule = await import("./acp-process.js");
		const { openMessagesRuntimeDriverConformanceFixture } = await import(
			"./messages-runtime-driver.test-support.js"
		);
		const network = await nativeNetworkFixture();
		const original = processModule.spawnAcpProcess;
		const spawn = vi
			.spyOn(processModule, "spawnAcpProcess")
			.mockImplementation((directory, cwd, launch) =>
				original(directory, cwd, {
					...launch,
					env: { ...launch.env, ...network.env },
				}),
			);
		const path = await mkdtemp(join(tmpdir(), "opencode-search-native-"));
		const fixture = await openMessagesRuntimeDriverConformanceFixture(
			path,
			false,
			"opencode",
		);
		try {
			fixture.nextTool("websearch", { query: "synthetic native search" });
			const command = {
				schemaVersion: 2 as const,
				kind: "submit-turn" as const,
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "search-execution",
				turnId: "search-turn",
				operationId: "search-operation",
				input: { text: "synthetic search", attachments: [] },
				selection: {
					schemaVersion: 1 as const,
					modelOptionId: "model-option-primary",
					reasoningLevel: "high",
				},
			};
			const accepted = await fixture.driver.execute(command);
			await vi.waitFor(() => expect(fixture.modelRequests()).toHaveLength(2), {
				timeout: 15000,
			});
			expect(JSON.stringify(fixture.modelRequests()[1]?.messages)).toContain(
				"Synthetic anonymous Exa search result",
			);
			await fixture.completeStopAsCompleted();
			expect(network.observed).toEqual([
				{ host: "mcp.exa.ai", domainCheck: false, credential: false },
			]);
			const events = await fixture.driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(
				events
					.filter(
						(event) =>
							event.type === "tool" && event.payload.name === "WebSearch",
					)
					.map((event) => (event.type === "tool" ? event.payload.phase : "")),
			).toEqual(["started", "completed"]);
		} finally {
			await fixture.close();
			spawn.mockRestore();
			await network.close();
			await rm(path, { recursive: true, force: true });
		}
	},
	30000,
);
