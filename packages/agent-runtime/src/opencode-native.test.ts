import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeExternalActionAuthorization } from "./driver.js";
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
				authorizeExternalAction: async (
					action: RuntimeExternalActionAuthorization,
				) => {
					await driver.validateExternalAction(action);
				},
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
				const modelFacts = events.flatMap((event) =>
					event.type === "operation" && event.payload.kind === "model"
						? [event.payload]
						: [],
				);
				expect(modelFacts.map((fact) => fact.phase)).toEqual([
					"intent",
					"started",
					"completed",
				]);
				expect(modelFacts.at(-1)).toMatchObject({
					startedAt: expect.any(String),
					finishedAt: expect.any(String),
					usage: { inputTokens: 10, outputTokens: 5 },
				});
				expect(modelFacts.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
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
				const persistedIntentsAtSend: number[] = [];
				let ownerRef: string | undefined;
				let target = "owner.txt";
				let sequence = 0;
				const server = createServer(async (req, res) => {
					let body = "";
					for await (const chunk of req) body += chunk;
					const request = JSON.parse(body);
					if (ownerRef) {
						const persisted = JSON.parse(
							await readFile(
								join(path, "driver", ownerRef, "state.json"),
								"utf8",
							),
						) as { turns: { events: RuntimeEvent[] }[] };
						persistedIntentsAtSend.push(
							persisted.turns
								.flatMap((turn) => turn.events)
								.filter(
									(event) =>
										event.type === "operation" &&
										event.payload.kind === "model" &&
										event.payload.phase === "intent",
								).length,
						);
					}
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
					// This source/path fixture checks durable attempts for both native Drivers.
					// Real Host current-authority negatives remain in pi-native.test.ts.
					authorizeExternalAction: async (
						action: RuntimeExternalActionAuthorization,
					) => {
						await driver.validateExternalAction(action);
					},
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
					ownerRef = binding.nativeSessionRef;
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
					const ownerEvents = await driver.replayEvents(
						accepted.nativeSessionRef,
						"execution-a",
					);
					const firstModelCompleted = ownerEvents.findIndex(
						(event) =>
							event.type === "operation" &&
							event.payload.kind === "model" &&
							event.payload.phase === "completed",
					);
					const firstToolIntent = ownerEvents.findIndex(
						(event) =>
							event.type === "operation" &&
							event.payload.kind === "tool" &&
							event.payload.phase === "intent",
					);
					expect(firstModelCompleted).toBeGreaterThanOrEqual(0);
					expect(firstModelCompleted).toBeLessThan(firstToolIntent);
					const modelFacts = ownerEvents.flatMap((event) =>
						event.type === "operation" && event.payload.kind === "model"
							? [event.payload]
							: [],
					);
					expect(modelFacts.map((fact) => fact.phase)).toEqual([
						"intent",
						"started",
						"completed",
						"intent",
						"started",
						"completed",
					]);
					expect(persistedIntentsAtSend.slice(0, 2)).toEqual([1, 2]);
					expect(
						new Set(
							modelFacts
								.filter((fact) => fact.phase === "intent")
								.map((fact) => fact.attemptRef),
						).size,
					).toBe(2);
					expect(modelFacts[2]?.usage).toMatchObject({
						inputTokens: 10,
						outputTokens: 10,
					});
					expect(modelFacts[3]?.usage).toBeUndefined();
					expect(modelFacts[4]?.usage).toBeUndefined();
					const ownerToolFacts = ownerEvents.flatMap((event) =>
						event.type === "operation" && event.payload.kind === "tool"
							? [event.payload]
							: [],
					);
					expect(ownerToolFacts.map((fact) => fact.phase)).toEqual([
						"intent",
						"completed",
					]);
					expect(ownerToolFacts.at(-1)?.startedAt).toBeUndefined();
					expect(ownerToolFacts.at(-1)?.durationMs).toBeUndefined();
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
					const escapeToolFacts = escapeEvents.flatMap((event) =>
						event.type === "operation" && event.payload.kind === "tool"
							? [event.payload]
							: [],
					);
					expect(escapeToolFacts.at(-1)?.phase).toBe("failed");
					expect(escapeToolFacts.at(-1)?.failureCode).toBe(
						runtime === "OpenCode"
							? "authorization_denied"
							: "operation_failed",
					);
					expect(escapeToolFacts[0]?.phase).toBe("intent");
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
