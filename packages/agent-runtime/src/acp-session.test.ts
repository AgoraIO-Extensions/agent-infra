import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

it("rejects a foreign-session permission request without recording a tool intent", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-foreign-permission-"));
	await mkdir(join(cwd, "workspace"));
	const authorize = vi.fn().mockResolvedValue(true);
	const toolRequestStarted = vi.fn().mockResolvedValue(undefined);
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "foreign-permission" },
			authorize,
		},
		toolRequestStarted,
		update: async () => {},
	});
	try {
		expect(await session.prompt("synthetic input")).toEqual({
			stopReason: "end_turn",
		});
		expect(authorize).not.toHaveBeenCalled();
		expect(toolRequestStarted).not.toHaveBeenCalled();
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

it("waits for an in-flight permission fact before close returns", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "acp-permission-close-"));
	await mkdir(join(cwd, "workspace"));
	let enterPermission: () => void = () => {};
	const permissionEntered = new Promise<void>((resolve) => {
		enterPermission = resolve;
	});
	let releaseFact: () => void = () => {};
	const factRelease = new Promise<void>((resolve) => {
		releaseFact = resolve;
	});
	let closeLaunch: () => void = () => {};
	const launchClosed = new Promise<void>((resolve) => {
		closeLaunch = resolve;
	});
	const order: string[] = [];
	const session = await openAcpSession({
		directory: cwd,
		cwd: join(cwd, "workspace"),
		launch: {
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "tool-permission-hold" },
			authorize: async () => true,
			close: async () => closeLaunch(),
		},
		update: async () => {},
		toolRequestStarted: async () => {
			enterPermission();
			await factRelease;
			await writeFile(join(cwd, "permission-fact"), "recorded");
			order.push("fact");
		},
	});
	try {
		const prompt = session.prompt("synthetic input").catch(() => {});
		await permissionEntered;
		const closing = session.close().then(() => order.push("closed"));
		await launchClosed;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(order).toEqual([]);
		releaseFact();
		await closing;
		await prompt;
		expect(order).toEqual(["fact", "closed"]);
	} finally {
		releaseFact();
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
