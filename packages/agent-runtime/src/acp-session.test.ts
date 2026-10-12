import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { openAcpSession } from "./acp-session.js";

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
