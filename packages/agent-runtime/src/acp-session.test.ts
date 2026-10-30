import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { expect, it, vi } from "vitest";
import { openAcpSession } from "./acp-session.js";
import type { RuntimeNativeCommandCommandV1 } from "./driver.js";

it.each([
	"partial-input",
	"announced-input",
	"empty-request",
	"late-notification",
	"completed-during-wait",
	"reannounced-during-wait",
	"still-empty",
	"denied-input",
	"conflicting-input",
	"conflicting-kind",
	"unannounced",
	"foreign-session",
	"completed",
	"announced-metadata",
	"late-announced-metadata",
	"missing-announced-input",
	"completed-during-authorization",
	"conflicting-during-authorization",
	"same-input-during-authorization",
	"reannounced-during-authorization",
])(
	"authorizes only the current announced ACP tool with consistent complete arguments: %s",
	async (scenario) => {
		const cwd = await mkdtemp(join(tmpdir(), "acp-permission-input-"));
		await mkdir(join(cwd, "workspace"));
		let authorizing = false;
		const updateObserved = Promise.withResolvers<void>();
		const authorize = vi.fn(async (tool) => {
			const allowed =
				tool.title === "grep" &&
				tool.kind === "search" &&
				tool.rawInput?.pattern === "allowed";
			if (scenario.endsWith("-during-authorization")) {
				authorizing = true;
				await writeFile(
					join(cwd, "workspace", "authorization-entered"),
					"entered",
				);
				await updateObserved.promise;
			}
			return allowed;
		});
		const session = await openAcpSession({
			directory: cwd,
			cwd: join(cwd, "workspace"),
			launch: {
				command: process.execPath,
				args: [
					fileURLToPath(
						new URL("./acp-peer.test-support.mjs", import.meta.url),
					),
				],
				env: {
					ACP_TEST_MODE: "permission-input",
					ACP_TEST_PERMISSION_SCENARIO: scenario,
				},
				authorize,
				...(scenario.endsWith("announced-metadata") ||
				scenario === "missing-announced-input"
					? { permissionInputSource: "announced" as const }
					: {}),
			},
			update: async ({ update }) => {
				if (
					authorizing &&
					(update.sessionUpdate === "tool_call" ||
						update.sessionUpdate === "tool_call_update")
				)
					updateObserved.resolve();
			},
		});
		try {
			await session.prompt("synthetic permission ordering");
			const result = JSON.parse(
				await readFile(join(cwd, "workspace", "permission.json"), "utf8"),
			);
			expect(result).toEqual({
				outcome: {
					outcome: "selected",
					optionId: [
						"partial-input",
						"announced-input",
						"empty-request",
						"late-notification",
						"announced-metadata",
						"late-announced-metadata",
						"same-input-during-authorization",
					].includes(scenario)
						? "allow"
						: "reject",
				},
			});
			if (
				[
					"partial-input",
					"announced-input",
					"empty-request",
					"late-notification",
					"denied-input",
					"still-empty",
					"announced-metadata",
					"late-announced-metadata",
					"missing-announced-input",
					"completed-during-authorization",
					"conflicting-during-authorization",
					"same-input-during-authorization",
					"reannounced-during-authorization",
				].includes(scenario)
			) {
				expect(authorize).toHaveBeenCalledExactlyOnceWith({
					toolCallId: "catalog-tool",
					title: "grep",
					kind: "search",
					rawInput: ["still-empty", "missing-announced-input"].includes(
						scenario,
					)
						? {}
						: {
								pattern: scenario === "denied-input" ? "forbidden" : "allowed",
							},
				});
			} else expect(authorize).not.toHaveBeenCalled();
		} finally {
			updateObserved.resolve();
			await session.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

it("discovers grouped native models, reads the current choice, and rejects choices removed by the peer", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-models-"));
	await mkdir(join(cwd, "workspace"));
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "grouped-models" },
		},
		update: async () => {},
	});
	try {
		expect(session.modelSelection()).toMatchObject({
			models: ["provider/model", "provider/other"],
			currentModel: "provider/model",
			reasoningLevels: ["high"],
		});
		await session.select("provider/other", "high");
		expect(session.modelSelection()).toMatchObject({
			models: ["provider/other"],
			currentModel: "provider/other",
			currentReasoning: "high",
		});
		await expect(session.select("provider/model", "high")).rejects.toThrow(
			"RUNTIME_MODEL_SELECTION_UNSUPPORTED",
		);
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

it("passes trusted MCP servers through ACP session/new", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-mcp-servers-"));
	await mkdir(join(cwd, "workspace"));
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "mcp-servers" },
			mcpServers: [
				{
					type: "http",
					name: "agent-infra-browser",
					url: "http://127.0.0.1:12345/mcp",
					headers: [{ name: "Authorization", value: "Bearer test" }],
				},
			],
		},
		update: async () => {},
	});
	try {
		expect(
			JSON.parse(
				await readFile(join(cwd, "workspace", "session.json"), "utf8"),
			),
		).toMatchObject({
			mcpServers: [
				{
					name: "agent-infra-browser",
					url: "http://127.0.0.1:12345/mcp",
				},
			],
		});
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

it("captures bounded ACP available command updates for the live session", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-commands-"));
	await mkdir(join(cwd, "workspace"));
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "available-commands" },
		},
		update: async () => {},
	});
	try {
		await expect(
			session.discoverCommands?.({
				signal: new AbortController().signal,
				expiresAt: Date.now() + 5_000,
				allowedRoots: [],
			}),
		).resolves.toMatchObject({
			nativeId: session.nativeId,
			commands: [
				{
					name: "compact",
					description: "Compact the current session",
					source: "acp",
				},
				{
					name: "research_codebase",
					argumentHint: "topic",
					source: "acp",
				},
			],
		});
		await expect(
			session.executeNativeCommand?.({
				schemaVersion: 1,
				kind: "native-command",
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "execution-a",
				turnId: "turn-a",
				operationId: "operation-a",
				nativeSessionRef: session.nativeId,
				capabilityId: "a".repeat(64),
				directoryRevision: "b".repeat(64),
				capabilityName: "compact",
				capabilitySourceVersion: "1.4.0",
				parameters: "",
				parametersDigest: "c".repeat(64),
			} satisfies RuntimeNativeCommandCommandV1),
		).resolves.toMatchObject({ stopReason: "end_turn" });
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

it("fails closed when the ACP session is retired", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-command-retire-"));
	await mkdir(join(cwd, "workspace"));
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "available-commands" },
		},
		update: async () => {},
	});
	await session.close();
	try {
		await expect(
			session.discoverCommands?.({
				signal: new AbortController().signal,
				expiresAt: Date.now() + 5_000,
				allowedRoots: [],
			}),
		).rejects.toThrow("RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

it("filters foreign-session text and tool notifications before the Driver callback", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-session-binding-"));
	await mkdir(join(cwd, "workspace"));
	const update = vi.fn().mockResolvedValue(undefined);
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "foreign-notifications" },
		},
		update,
	});
	try {
		expect(await session.prompt("synthetic input")).toEqual({
			stopReason: "end_turn",
		});
		expect(update).toHaveBeenCalledExactlyOnceWith({
			sessionId: session.nativeId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "synthetic result 1" },
			},
		});
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

it("drains a bounded text burst across ordering barriers before confirming cancellation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "acp-text-burst-"));
	const cwd = join(directory, "workspace");
	await mkdir(cwd);
	const entered = Promise.withResolvers<void>();
	const commit = Promise.withResolvers<void>();
	const notifications: SessionNotification[] = [];
	const facts: RuntimeOperationFactV2[] = [];
	let callbacks = 0;
	let finished = false;
	const session = await openAcpSession({
		directory,
		cwd,
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "burst-cancel" },
		},
		update: async (notification) => {
			if (++callbacks > 8) throw new Error("ACP_TEXT_COMMIT_BUDGET_EXCEEDED");
			if (callbacks === 1) {
				entered.resolve();
				await commit.promise;
			}
			notifications.push(notification);
		},
		modelFact: () => ({
			configVersion: "burst-fixture",
			modelOptionId: "primary",
			modelId: "fixture-model",
		}),
		recordOperationFact: async (fact) => {
			facts.push(fact);
		},
	});
	const prompt = session.prompt("synthetic burst").finally(() => {
		finished = true;
	});
	void prompt.catch(() => {});
	try {
		await entered.promise;
		await writeFile(join(cwd, "burst-start"), "start");
		await vi.waitFor(async () =>
			expect(await readFile(join(cwd, "burst-ready"), "utf8")).toBe("ready"),
		);
		await session.cancel();
		await vi.waitFor(async () =>
			expect(await readFile(join(cwd, "cancel-seen.json"), "utf8")).toBe(
				"true",
			),
		);
		expect(finished).toBe(false);
		expect(facts.map((fact) => fact.phase)).toEqual(["intent", "started"]);
		expect(notifications).toHaveLength(0);
		commit.resolve();
		await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
		const text = (values: SessionNotification[]) =>
			values.flatMap(({ update }) =>
				update.sessionUpdate === "agent_message_chunk" &&
				update.content.type === "text"
					? [update.content.text]
					: [],
			);
		const boundary = notifications.findIndex(
			({ update }) => update.sessionUpdate === "tool_call",
		);
		expect(text(notifications.slice(0, boundary)).join("")).toBe(
			`burst-prefix|${"😀0123456789".repeat(4 * 500)}`,
		);
		expect(notifications[boundary + 1]?.update).toEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "metadata|" },
		});
		expect(
			JSON.parse(await readFile(join(cwd, "burst-permission.json"), "utf8")),
		).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
		expect(text(notifications.slice(boundary + 1)).join("")).toBe(
			`metadata|${"😀0123456789".repeat(4 * 500)}cancel-tail|`,
		);
		expect(
			text(notifications).every(
				(value) => Buffer.byteLength(value, "utf8") <= 16 * 1024,
			),
		).toBe(true);
		expect(callbacks).toBeLessThanOrEqual(8);
		expect(facts.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"completed",
		]);
		expect(facts[2]).toMatchObject({
			operationRef: facts[1]?.operationRef,
			attemptRef: facts[1]?.attemptRef,
			startedAt: facts[1]?.startedAt,
		});
	} finally {
		commit.resolve();
		await session.close();
		await prompt.catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});

it("accepts structured image content in an ACP prompt", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-image-prompt-"));
	await mkdir(join(cwd, "workspace"));
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "image-prompt" },
		},
		update: async () => {},
	});
	try {
		await expect(
			session.prompt([
				{ type: "text", text: "inspect" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			]),
		).resolves.toMatchObject({ stopReason: "end_turn" });
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

it("rejects structured image content when the ACP peer does not negotiate image input", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-image-unsupported-"));
	await mkdir(join(cwd, "workspace"));
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "grouped-models" },
		},
		update: async () => {},
	});
	try {
		expect(session.supportsImagePrompt).toBe(false);
		await expect(
			session.prompt([
				{ type: "text", text: "inspect" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			]),
		).rejects.toThrow("RUNTIME_FILE_INPUT_UNAVAILABLE");
		await expect(
			session.prompt("plain text still works"),
		).resolves.toMatchObject({ stopReason: "end_turn" });
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

it("bounds a hanging ACP prompt and retires the native process", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-prompt-timeout-"));
	await mkdir(join(cwd, "workspace"));
	const facts: RuntimeOperationFactV2[] = [];
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "ignore-cancel" },
			promptTimeoutMs: 25,
		},
		update: async () => {},
		modelFact: () => ({
			configVersion: "timeout-fixture",
			modelOptionId: "primary",
			modelId: "fixture-model",
		}),
		recordOperationFact: async (fact) => {
			facts.push(fact);
		},
	});
	try {
		await expect(session.prompt("hang")).rejects.toThrow(
			"RUNTIME_ACP_PROMPT_TIMEOUT",
		);
		await expect(session.exited).resolves.toBeNull();
		expect(facts.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"unknown",
		]);
		expect(facts[1]?.startedAt).toEqual(expect.any(String));
		expect(facts[2]).toMatchObject({
			operationRef: facts[1]?.operationRef,
			attemptRef: facts[1]?.attemptRef,
			startedAt: facts[1]?.startedAt,
		});
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

it("clears the ACP prompt deadline after a normal response", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-prompt-deadline-"));
	await mkdir(join(cwd, "workspace"));
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "custom-acp" },
			promptTimeoutMs: 1_000,
		},
		update: async () => {},
	});
	try {
		await expect(session.prompt("complete")).resolves.toMatchObject({
			stopReason: "end_turn",
		});
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
