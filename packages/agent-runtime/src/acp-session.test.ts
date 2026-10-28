import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { openAcpSession } from "./acp-session.js";
import type { RuntimeNativeCommandCommandV1 } from "./driver.js";

it.each([
	"partial-input",
	"announced-input",
	"empty-request",
	"late-notification",
	"completed-during-wait",
	"still-empty",
	"denied-input",
	"conflicting-input",
	"conflicting-kind",
	"unannounced",
	"foreign-session",
	"completed",
])(
	"authorizes only the current announced ACP tool with consistent complete arguments: %s",
	async (scenario) => {
		const cwd = await mkdtemp(join(tmpdir(), "acp-permission-input-"));
		await mkdir(join(cwd, "workspace"));
		const authorize = vi.fn(
			async (tool) =>
				tool.title === "grep" &&
				tool.kind === "search" &&
				tool.rawInput?.pattern === "allowed",
		);
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
			},
			update: async () => {},
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
				].includes(scenario)
			) {
				expect(authorize).toHaveBeenCalledExactlyOnceWith({
					toolCallId: "catalog-tool",
					title: "grep",
					kind: "search",
					rawInput:
						scenario === "still-empty"
							? {}
							: {
									pattern:
										scenario === "denied-input" ? "forbidden" : "allowed",
								},
				});
			} else expect(authorize).not.toHaveBeenCalled();
		} finally {
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
