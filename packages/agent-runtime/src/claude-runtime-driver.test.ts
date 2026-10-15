import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	type ClaudeNativeCommandReadContext,
	ClaudeRuntimeDriver,
	claudeNativeSkillLaunchOptions,
	normalizeClaudeUncertainConnectionOperations,
	parseClaudeNativeCommands,
} from "./claude-runtime-driver.js";
import type {
	RuntimeExternalActionAuthorization,
	RuntimeNativeMetadataReadContextV1,
	RuntimeNativeSkillCommandV1,
} from "./driver.js";
import type { RuntimeFileBridgePortV1 } from "./runtime-file-bridge.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

const commandRead = (
	nativeSessionRef = "missing",
): ClaudeNativeCommandReadContext => ({
	nativeSessionRef,
	signal: new AbortController().signal,
	expiresAt: Date.now() + 10_000,
	assertCurrent: () => {},
	revalidate: async () => {},
});

const metadataRead = (
	nativeSessionRef: string,
): RuntimeNativeMetadataReadContextV1 => ({
	nativeSessionRef,
	signal: new AbortController().signal,
	expiresAt: Date.now() + 10_000,
	assertCurrent: () => ({
		principal: { kind: "user", id: "reader-1" },
		scope: {
			agentId: "agent-a",
			conversationId: "conversation-a",
			executionId: "execution-a",
			sessionGeneration: 1,
		},
	}),
	revalidate: async () => ({
		principal: { kind: "user", id: "reader-1" },
		scope: {
			agentId: "agent-a",
			conversationId: "conversation-a",
			executionId: "execution-a",
			sessionGeneration: 1,
		},
	}),
});

const attachmentCommand = {
	schemaVersion: 2 as const,
	kind: "submit-turn" as const,
	agentId: "agent-file",
	conversationId: "conversation-file",
	sessionGeneration: 1,
	executionId: "execution-file",
	turnId: "turn-file",
	operationId: "operation-file",
	selection: {
		schemaVersion: 1 as const,
		modelOptionId: "primary",
		reasoningLevel: "high",
	},
	input: { text: "inspect", attachments: ["file-1"] },
};

const nativeSkillCommand = (
	overrides: Partial<RuntimeNativeSkillCommandV1> = {},
): RuntimeNativeSkillCommandV1 => ({
	schemaVersion: 1,
	kind: "native-capability",
	operationId: "operation-skill",
	agentId: "agent-skill",
	conversationId: "conversation-skill",
	executionId: "execution-skill",
	turnId: "turn-skill",
	sessionGeneration: 1,
	nativeSessionRef: "native-skill",
	capabilityId: "a".repeat(64),
	directoryRevision: "b".repeat(64),
	parameters: "summarize files",
	parametersDigest: "c".repeat(64),
	capabilityName: "workspace-summary",
	capabilitySourceVersion: "1.0.0",
	...overrides,
});

it("keeps Claude native Skill loading disabled without a verified Applied root", () => {
	const metadataOnly: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		findSkills: () => [],
		readSkill: async () => new Uint8Array(),
	};
	const disabled = { extraArgs: { "disable-slash-commands": null } };
	expect(claudeNativeSkillLaunchOptions()).toEqual(disabled);
	expect(claudeNativeSkillLaunchOptions(metadataOnly)).toEqual(disabled);
});

it("enables Claude native Skill loading only after the Applied root verifies", async () => {
	const root = await mkdtemp(join(tmpdir(), "claude-applied-skills-"));
	const skillPath = join(root, ".agents/skills/workspace-summary/SKILL.md");
	await mkdir(dirname(skillPath), { recursive: true });
	await writeFile(skillPath, "# workspace summary\n");
	const nativeSkillPaths = vi.fn(() => [skillPath]);
	const directory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		nativeRoot: root,
		nativeSkillPaths,
		findSkills: () => [
			{
				schemaVersion: 1,
				name: "workspace-summary",
				version: "1.0.0",
				packageDigest: "b".repeat(64),
				manifestDigest: "c".repeat(64),
				targetPath: ".agents/skills/workspace-summary",
				readOnly: true,
			},
		],
		readSkill: async () => new Uint8Array(),
	};

	try {
		expect(claudeNativeSkillLaunchOptions(directory)).toEqual({
			additionalDirectories: [root],
			skills: ["workspace-summary"],
		});
		expect(nativeSkillPaths).toHaveBeenCalledOnce();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("fails closed when the Applied root cannot be revalidated", () => {
	const directory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		nativeRoot: "/opt/agent-infra-skill-hub",
		nativeSkillPaths: () => {
			throw new Error("stale Applied root");
		},
		findSkills: () => [],
		readSkill: async () => new Uint8Array(),
	};

	expect(() => claudeNativeSkillLaunchOptions(directory)).toThrow(
		"Runtime Skill directory is unavailable",
	);
});

it("fails closed when verified files do not match Applied Skill metadata", () => {
	const directory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		nativeRoot: "/opt/agent-infra-skill-hub",
		nativeSkillPaths: () => [
			"/opt/agent-infra-skill-hub/.agents/skills/other/SKILL.md",
		],
		findSkills: () => [
			{
				schemaVersion: 1,
				name: "workspace-summary",
				version: "1.0.0",
				packageDigest: "b".repeat(64),
				manifestDigest: "c".repeat(64),
				targetPath: ".agents/skills/workspace-summary",
				readOnly: true,
			},
		],
		readSkill: async () => new Uint8Array(),
	};

	expect(() => claudeNativeSkillLaunchOptions(directory)).toThrow(
		"Runtime Skill directory is unavailable",
	);
});

async function appliedSkillRoot() {
	const root = await mkdtemp(join(tmpdir(), "claude-applied-containment-"));
	const skillPath = join(root, ".agents/skills/workspace-summary/SKILL.md");
	await mkdir(dirname(skillPath), { recursive: true });
	await writeFile(skillPath, "# workspace summary\n");
	return { root, skillPath };
}

it.each(["../outside", "/outside"])(
	"rejects an Applied target path replacement: %s",
	async (targetPath) => {
		const { root, skillPath } = await appliedSkillRoot();
		const directory: RuntimeFilesystemSkillDirectoryV1 = {
			generationId: "a".repeat(64),
			nativeRoot: root,
			nativeSkillPaths: () => [skillPath],
			findSkills: () => [
				{
					schemaVersion: 1,
					name: "workspace-summary",
					version: "1.0.0",
					packageDigest: "b".repeat(64),
					manifestDigest: "c".repeat(64),
					targetPath,
					readOnly: true,
				},
			],
			readSkill: async () => new Uint8Array(),
		};
		try {
			expect(() => claudeNativeSkillLaunchOptions(directory)).toThrow(
				"Runtime Skill directory is unavailable",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

it("rejects duplicate and root-prefix-confusing native Skill paths", async () => {
	const { root, skillPath } = await appliedSkillRoot();
	const outsideRoot = await mkdtemp(`${root}-evil-`);
	const outsidePath = join(
		outsideRoot,
		".agents/skills/workspace-summary/SKILL.md",
	);
	await mkdir(dirname(outsidePath), { recursive: true });
	await writeFile(outsidePath, "outside\n");
	const entry = {
		schemaVersion: 1 as const,
		name: "workspace-summary",
		version: "1.0.0",
		packageDigest: "b".repeat(64),
		manifestDigest: "c".repeat(64),
		targetPath: ".agents/skills/workspace-summary",
		readOnly: true as const,
	};
	try {
		for (const nativeSkillPaths of [[skillPath, skillPath], [outsidePath]]) {
			const directory: RuntimeFilesystemSkillDirectoryV1 = {
				generationId: "a".repeat(64),
				nativeRoot: root,
				nativeSkillPaths: () => nativeSkillPaths,
				findSkills: () => [entry],
				readSkill: async () => new Uint8Array(),
			};
			expect(() => claudeNativeSkillLaunchOptions(directory)).toThrow(
				"Runtime Skill directory is unavailable",
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outsideRoot, { recursive: true, force: true });
	}
});

async function openSkillExecutionDriver(
	skillDirectory?: RuntimeFilesystemSkillDirectoryV1,
) {
	const path = await mkdtemp(join(tmpdir(), "claude-native-skill-command-"));
	const driver = await ClaudeRuntimeDriver.open({
		path,
		configVersion: "configuration-skill",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				authentication: "bearer",
				endpoint: "http://127.0.0.1:1",
				credential: "synthetic-model-credential",
			},
		],
		...(skillDirectory ? { skillDirectory } : {}),
	});
	return { driver, path };
}

it("creates a Claude Applied Skill submit command from the verified root", async () => {
	const { root, skillPath } = await appliedSkillRoot();
	const directory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		nativeRoot: root,
		nativeSkillPaths: () => [skillPath],
		findSkills: () => [
			{
				schemaVersion: 1,
				name: "workspace-summary",
				version: "1.0.0",
				packageDigest: "b".repeat(64),
				manifestDigest: "c".repeat(64),
				targetPath: ".agents/skills/workspace-summary",
				readOnly: true,
			},
		],
		readSkill: async () => new Uint8Array(),
	};
	const { driver, path } = await openSkillExecutionDriver(directory);
	try {
		expect(driver.createNativeSkillCommand(nativeSkillCommand())).toMatchObject(
			{
				kind: "submit-turn",
				operationId: "operation-skill",
				nativeSessionRef: "native-skill",
				input: {
					text: "/workspace-summary summarize files",
					attachments: [],
				},
			},
		);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});

it.each([
	"missing-root",
	"unknown-skill",
	"version-mismatch",
	"stale-native-paths",
])("fails closed for Claude native Skill %s", async (failure) => {
	const rootAndPath =
		failure === "missing-root" ? undefined : await appliedSkillRoot();
	const directory = rootAndPath
		? ({
				generationId: "a".repeat(64),
				nativeRoot: rootAndPath.root,
				nativeSkillPaths: () => {
					if (failure === "stale-native-paths")
						throw new Error("stale Applied root");
					return [rootAndPath.skillPath];
				},
				findSkills: () => [
					{
						schemaVersion: 1 as const,
						name: "workspace-summary",
						version: "1.0.0",
						packageDigest: "b".repeat(64),
						manifestDigest: "c".repeat(64),
						targetPath: ".agents/skills/workspace-summary",
						readOnly: true as const,
					},
				],
				readSkill: async () => new Uint8Array(),
			} satisfies RuntimeFilesystemSkillDirectoryV1)
		: undefined;
	const { driver, path } = await openSkillExecutionDriver(directory);
	try {
		const command =
			failure === "unknown-skill"
				? nativeSkillCommand({ capabilityName: "unknown-skill" })
				: failure === "version-mismatch"
					? nativeSkillCommand({ capabilitySourceVersion: "9.9.9" })
					: nativeSkillCommand();
		expect(() => driver.createNativeSkillCommand(command)).toThrow(
			"Runtime Skill directory is unavailable",
		);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
		if (rootAndPath)
			await rm(rootAndPath.root, { recursive: true, force: true });
	}
});

it("rejects malformed and oversized Claude native Skill parameters", async () => {
	const { root, skillPath } = await appliedSkillRoot();
	const directory: RuntimeFilesystemSkillDirectoryV1 = {
		nativeRoot: root,
		nativeSkillPaths: () => [skillPath],
		generationId: "a".repeat(64),
		findSkills: () => [
			{
				schemaVersion: 1,
				name: "workspace-summary",
				version: "1.0.0",
				packageDigest: "b".repeat(64),
				manifestDigest: "c".repeat(64),
				targetPath: ".agents/skills/workspace-summary",
				readOnly: true,
			},
		],
		readSkill: async () => new Uint8Array(),
	};
	const { driver, path } = await openSkillExecutionDriver(directory);
	try {
		for (const parameters of ["\ud800", "x".repeat(16 * 1024)]) {
			let failure: unknown;
			try {
				driver.createNativeSkillCommand(nativeSkillCommand({ parameters }));
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({
				code: "RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
			});
		}
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});

it("keeps uncertain Claude Connection operations held across restart", () => {
	const turn: Parameters<
		typeof normalizeClaudeUncertainConnectionOperations
	>[0] = {
		connectionOperations: [
			{
				callId: "11111111-1111-4111-8111-111111111111",
				alias: "mcp_abc",
				name: "connection.write",
				phase: "started" as const,
				rpcRequestId: 7,
				requestDigest: "a".repeat(64),
				consumerId: "consumer-a",
				instanceRef: "instance-a",
				credentialRevision: "revision-a",
			},
		],
	};
	normalizeClaudeUncertainConnectionOperations(turn);
	expect(turn.unknownHold).toBe(true);
	expect(turn.connectionOperations?.[0]?.phase).toBe("unknown");
});

const openAttachmentDriver = (path: string) =>
	ClaudeRuntimeDriver.open({
		path,
		configVersion: "claude-files",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				authentication: "bearer",
				endpoint: "http://127.0.0.1:1",
				credential: "synthetic-model-credential",
			},
		],
	});

const attachmentBridge = (
	descriptor: { mediaType: string; sizeBytes: number; sha256: string },
	bytes: Uint8Array,
	revalidate: () => void = () => {},
): RuntimeFileBridgePortV1 => ({
	readInput: async () => ({
		fileId: "file-1",
		descriptor: { name: "image.png", ...descriptor },
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	}),
	writeResult: async () => {
		throw new Error("unused");
	},
	revalidate,
});

it("bounds and normalizes Claude native command metadata", async () => {
	expect(
		parseClaudeNativeCommands([
			{
				name: "compact",
				description: "Compact the current session",
				argumentHint: "",
				aliases: ["shrink"],
			},
		]),
	).toEqual([
		{
			name: "compact",
			description: "Compact the current session",
			argumentHint: "",
			aliases: ["shrink"],
		},
	]);
	for (const value of [
		[
			{
				name: "compact",
				description: "",
				argumentHint: "",
			},
		],
		[
			{
				name: "compact",
				description: "one",
				argumentHint: "",
			},
			{
				name: "compact",
				description: "two",
				argumentHint: "",
			},
		],
		[
			{
				name: "compact",
				description: "one",
				argumentHint: "",
				aliases: ["\u0000"],
			},
		],
		[
			{
				name: "compact",
				description: "one",
				argumentHint: "",
				aliases: ["shrink", "shrink"],
			},
		],
		Array.from({ length: 151 }, (_, index) => ({
			name: `command-${index}`,
			description: "bounded",
			argumentHint: "",
		})),
	] as const)
		await expect(
			Promise.resolve().then(() => parseClaudeNativeCommands(value)),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_COMMANDS_INVALID" });
});

it("rejects discovery for a missing Claude native session", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-discovery-"));
	const driver = await ClaudeRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				authentication: "bearer",
				endpoint: "http://127.0.0.1:1",
				credential: "synthetic-model-credential",
			},
		],
	});
	try {
		await expect(
			driver.discoverNativeCommands(commandRead()),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("rejects a credential-free option without Host key delivery", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-v4-invalid-"));
	try {
		await expect(
			ClaudeRuntimeDriver.open({
				path,
				configVersion: "configuration-v4",
				defaultModelOptionId: "primary",
				defaultReasoningLevel: "high",
				modelOptions: [
					{
						modelOptionId: "primary",
						model: "claude-opus-5",
						reasoningLevels: ["high"],
						authentication: "bearer",
						endpoint: "https://relay.example.test/v1",
					},
				],
			}),
		).rejects.toThrow("RUNTIME_CONFIGURATION_INVALID");
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it("runs a native Claude Turn, durably replays its result and resumes the original Session", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-conformance-"));
	let calls = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (b) => {
			body += b;
		});
		req.on("end", () => {
			const value = JSON.parse(body);
			expect(value.model).toBe("claude-opus-5");
			expect(value.output_config.effort).toBe("high");
			calls++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [
				{
					type: "message_start",
					message: {
						id: `msg_${calls}`,
						type: "message",
						role: "assistant",
						model: value.model,
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
					delta: { type: "text_delta", text: `OK-${calls}` },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 2 },
				},
				{ type: "message_stop" },
			])
				res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	const skillDirectory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		findSkills: () => [
			{
				schemaVersion: 1,
				name: "workspace-summary",
				version: "1.0.0",
				packageDigest: "b".repeat(64),
				manifestDigest: "c".repeat(64),
				targetPath: ".agents/skills/workspace-summary",
				readOnly: true,
			},
		],
		readSkill: async () => new Uint8Array([1, 2, 3]),
	};
	const options = {
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				authentication: "bearer" as const,
				endpoint: `http://127.0.0.1:${address.port}`,
				credential: "synthetic-model-credential",
			},
		],
		skillDirectory,
	};
	let driver = await ClaudeRuntimeDriver.open(options);
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
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
			input: { text: "Reply with OK.", attachments: [] },
		};
		const accepted = await driver.execute(command);
		expect(accepted.result).toEqual({ outcome: "accepted", status: "running" });
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			{ timeout: 10000 },
		);
		const persisted = JSON.parse(
			await readFile(
				join(path, accepted.nativeSessionRef, "state.json"),
				"utf8",
			),
		) as {
			turns: {
				operationFacts?: {
					kind: string;
					phase: string;
					model?: Record<string, unknown>;
				}[];
			}[];
		};
		expect(
			persisted.turns[0]?.operationFacts?.map((fact) => fact.phase),
		).toEqual(["intent", "started", "completed"]);
		expect(
			persisted.turns[0]?.operationFacts?.every((fact) => !fact.model?.text),
		).toBe(true);
		const commands = await driver.discoverNativeCommands(
			commandRead(accepted.nativeSessionRef),
		);
		expect(commands).toEqual([]);
		expect(
			await driver.discoverNativeSkills(commandRead(accepted.nativeSessionRef)),
		).toEqual({
			generationId: skillDirectory.generationId,
			entries: skillDirectory.findSkills(),
		});
		expect(
			await driver.readNativeMetadataV1(
				"commands",
				metadataRead(accepted.nativeSessionRef),
			),
		).toMatchObject({ selector: "commands", capabilities: [] });
		expect(
			await driver.readNativeMetadataV1(
				"skills",
				metadataRead(accepted.nativeSessionRef),
			),
		).toMatchObject({
			selector: "skills",
			capabilities: [{ name: "workspace-summary" }],
		});
		expect(
			await driver.readNativeSkill(
				commandRead(accepted.nativeSessionRef),
				"workspace-summary",
				"SKILL.md",
			),
		).toEqual(new Uint8Array([1, 2, 3]));
		expect(await driver.getCapabilities()).toMatchObject({
			skills: [
				{
					name: "workspace-summary",
					manifestSha256: "c".repeat(64),
					packageDigest: "b".repeat(64),
				},
			],
		});
		await expect(
			driver.discoverNativeCommands({
				...commandRead(accepted.nativeSessionRef),
				revalidate: async () => {
					throw new Error("revoked");
				},
			}),
		).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		const abort = new AbortController();
		const held = Promise.withResolvers<void>();
		const cancelled = driver.discoverNativeCommands({
			...commandRead(accepted.nativeSessionRef),
			signal: abort.signal,
			revalidate: () => held.promise,
		});
		abort.abort();
		await expect(cancelled).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
		const retiringHeld = Promise.withResolvers<void>();
		const retiringRead = driver.discoverNativeCommands({
			...commandRead(accepted.nativeSessionRef),
			revalidate: () => retiringHeld.promise,
		});
		await Promise.resolve();
		const closing = driver.close();
		retiringHeld.resolve();
		await expect(retiringRead).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
		await closing;
		expect(
			(
				await driver.replayEvents(
					accepted.nativeSessionRef,
					command.executionId,
				)
			)
				.filter((event) => event.type === "text")
				.map((event) => event.payload.delta)
				.join(""),
		).toBe("OK-1");
		await driver.close();
		driver = await ClaudeRuntimeDriver.open(options);
		expect(await driver.execute(command)).toEqual(accepted);
		const next = {
			...command,
			operationId: "operation-b",
			executionId: "execution-b",
			turnId: "turn-b",
			nativeSessionRef: accepted.nativeSessionRef,
		};
		const resumed = await driver.execute(next);
		expect(resumed.nativeSessionRef).toBe(accepted.nativeSessionRef);
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(resumed.nativeSessionRef, next.executionId),
				).toBe("completed"),
			{ timeout: 10000 },
		);
		expect(calls).toBe(2);
		await driver.close();
		await rm(join(path, accepted.nativeSessionRef, "state.json"));
		driver = await ClaudeRuntimeDriver.open(options);
		await expect(
			driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).rejects.toThrow("Runtime session could not be recovered");
		await expect(
			driver.execute({
				...next,
				operationId: "operation-c",
				executionId: "execution-c",
				turnId: "turn-c",
			}),
		).rejects.toThrow("Runtime session could not be recovered");
		expect(calls).toBe(2);
	} finally {
		await driver.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(path, { recursive: true, force: true });
	}
}, 30000);

it("keeps two Claude Session workspace and memory roots disjoint", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-isolation-"));
	let calls = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const value = JSON.parse(body);
			calls++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [
				{
					type: "message_start",
					message: {
						id: `msg_isolation_${calls}`,
						type: "message",
						role: "assistant",
						model: value.model,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 1, output_tokens: 0 },
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
					delta: { type: "text_delta", text: "OK" },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1 },
				},
				{ type: "message_stop" },
			])
				res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	const driver = await ClaudeRuntimeDriver.open({
		path,
		configVersion: "configuration-isolation",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				authentication: "bearer" as const,
				endpoint: `http://127.0.0.1:${address.port}`,
				credential: "synthetic-model-credential",
			},
		],
	});
	const command = (suffix: string) => ({
		schemaVersion: 2 as const,
		kind: "submit-turn" as const,
		agentId: "agent-a",
		conversationId: `conversation-${suffix}`,
		sessionGeneration: 1,
		executionId: `execution-${suffix}`,
		turnId: `turn-${suffix}`,
		operationId: `operation-${suffix}`,
		selection: {
			schemaVersion: 1 as const,
			modelOptionId: "primary",
			reasoningLevel: "high" as const,
		},
		input: { text: "Reply without private content.", attachments: [] },
	});
	try {
		const first = await driver.execute(command("first"));
		const second = await driver.execute(command("second"));
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(first.nativeSessionRef, "execution-first"),
				).toBe("completed"),
			{ timeout: 10000 },
		);
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(second.nativeSessionRef, "execution-second"),
				).toBe("completed"),
			{ timeout: 10000 },
		);
		expect(first.nativeSessionRef).not.toBe(second.nativeSessionRef);
		const canonicalPath = await realpath(path);
		const firstRoot = join(canonicalPath, first.nativeSessionRef);
		const secondRoot = join(canonicalPath, second.nativeSessionRef);
		expect(await realpath(join(firstRoot, "workspace"))).toBe(
			join(firstRoot, "workspace"),
		);
		expect(await realpath(join(secondRoot, "workspace"))).toBe(
			join(secondRoot, "workspace"),
		);
		expect(await realpath(join(firstRoot, "memory"))).toBe(
			join(firstRoot, "memory"),
		);
		expect(await realpath(join(secondRoot, "memory"))).toBe(
			join(secondRoot, "memory"),
		);
		await writeFile(join(firstRoot, "workspace", "first.txt"), "first");
		await writeFile(join(firstRoot, "memory", "MEMORY.md"), "first-memory");
		await writeFile(join(secondRoot, "workspace", "second.txt"), "second");
		await writeFile(join(secondRoot, "memory", "MEMORY.md"), "second-memory");
		await expect(
			access(join(secondRoot, "workspace", "first.txt")),
		).rejects.toThrow();
		await expect(
			access(join(firstRoot, "workspace", "second.txt")),
		).rejects.toThrow();
		expect(calls).toBe(2);
	} finally {
		await driver.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(path, { recursive: true, force: true });
	}
}, 30000);

it("maps an authorized image attachment into Claude native content", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-files-"));
	const bytes = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		"base64",
	);
	const encoded = bytes.toString("base64");
	let requestBody = "";
	const server = createServer((req, res) => {
		if (req.method !== "POST") {
			res.writeHead(404).end();
			return;
		}
		req.on("data", (chunk) => (requestBody += chunk));
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [
				{
					type: "message_start",
					message: {
						id: "msg-file",
						model: "claude-opus-5",
						content: [],
						usage: { input_tokens: 1, output_tokens: 0 },
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
					delta: { type: "text_delta", text: "OK" },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1 },
				},
				{ type: "message_stop" },
			])
				res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	const driver = await ClaudeRuntimeDriver.open({
		path,
		configVersion: "claude-files",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				authentication: "bearer",
				endpoint: `http://127.0.0.1:${address.port}`,
				credential: "synthetic-model-credential",
			},
		],
	});
	try {
		const command = {
			schemaVersion: 2 as const,
			kind: "submit-turn" as const,
			agentId: "agent-file",
			conversationId: "conversation-file",
			sessionGeneration: 1,
			executionId: "execution-file",
			turnId: "turn-file",
			operationId: "operation-file",
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
			input: { text: "inspect", attachments: ["file-1"] },
		};
		const fileBridge: RuntimeFileBridgePortV1 = {
			readInput: async () => ({
				fileId: "file-1",
				descriptor: {
					name: "image.png",
					mediaType: "image/png",
					sizeBytes: bytes.byteLength,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				},
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
			}),
			writeResult: async () => {
				throw new Error("unused");
			},
			revalidate: () => {},
		};
		const accepted = await driver.execute(command, { fileBridge });
		expect(accepted.result).toEqual({ outcome: "accepted", status: "running" });
		await vi.waitFor(() => expect(requestBody).toContain(encoded), {
			timeout: 10000,
		});
		expect(requestBody).toContain(encoded);
		expect(requestBody).toContain("image/png");
		expect(await driver.getCapabilities()).toMatchObject({ attachments: true });
	} finally {
		await driver.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(path, { recursive: true, force: true });
	}
}, 30000);

it("rejects an attachment outside the Claude image allowlist before native submission", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-files-media-"));
	const driver = await openAttachmentDriver(path);
	const bytes = new TextEncoder().encode("<svg></svg>");
	try {
		await expect(
			driver.execute(attachmentCommand, {
				fileBridge: attachmentBridge(
					{
						mediaType: "image/svg+xml",
						sizeBytes: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
					bytes,
				),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("rejects an attachment whose bytes do not match the admitted digest", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-files-digest-"));
	const driver = await openAttachmentDriver(path);
	const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	try {
		await expect(
			driver.execute(attachmentCommand, {
				fileBridge: attachmentBridge(
					{
						mediaType: "image/png",
						sizeBytes: bytes.byteLength,
						sha256: "a".repeat(64),
					},
					bytes,
				),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("refuses native submission when the file authority lapses after materialization", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-files-authority-"));
	const driver = await openAttachmentDriver(path);
	const bytes = new TextEncoder().encode("claude-lapsed-authority-probe-image");
	let revalidations = 0;
	try {
		await expect(
			driver.execute(attachmentCommand, {
				fileBridge: attachmentBridge(
					{
						mediaType: "image/png",
						sizeBytes: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
					bytes,
					() => {
						revalidations += 1;
						// The authority lapses after materialization but before the native request.
						if (revalidations > 1) {
							throw new Error("RUNTIME_FILE_BRIDGE_CONTEXT_STALE");
						}
					},
				),
			}),
		).rejects.toThrow("RUNTIME_FILE_BRIDGE_CONTEXT_STALE");
		// The last check runs at the native submission boundary.
		expect(revalidations).toBe(2);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("delivers a per-execution key for a credential-free Claude option", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-v4-"));
	const keys = new Map([
		["execution-a", "execution-key-a-0123456789"],
		["execution-b", "execution-key-b-0123456789"],
	]);
	const actions: RuntimeExternalActionAuthorization[] = [];
	const authorizationHeaders: string[] = [];
	let activeExecution = "";
	let calls = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const value = JSON.parse(body);
			expect(value.model).toBe("claude-opus-5");
			authorizationHeaders.push(req.headers.authorization ?? "");
			calls++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [
				{
					type: "message_start",
					message: {
						id: `msg_${calls}`,
						type: "message",
						role: "assistant",
						model: value.model,
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
					delta: { type: "text_delta", text: `OK-${calls}` },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 2 },
				},
				{ type: "message_stop" },
			])
				res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	const driver = await ClaudeRuntimeDriver.open({
		path,
		configVersion: "configuration-v4",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				authentication: "bearer",
				endpoint: `http://127.0.0.1:${address.port}`,
			},
		],
		authorizeModelAction: async (action) => {
			activeExecution = action.executionId;
			actions.push(action);
			return { relayKey: keys.get(action.executionId) };
		},
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
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
			input: { text: "Reply with OK.", attachments: [] },
		};
		const first = await driver.execute(command);
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(first.nativeSessionRef, command.executionId),
				).toBe("completed"),
			{ timeout: 10000 },
		);
		expect(activeExecution).toBe("execution-a");
		expect(authorizationHeaders.length).toBeGreaterThan(0);
		expect(new Set(authorizationHeaders)).toEqual(
			new Set([`Bearer ${keys.get("execution-a")}`]),
		);
		expect(actions).toHaveLength(authorizationHeaders.length);
		for (const action of actions) {
			expect(action.kind).toBe("model");
			expect(action.executionId).toBe("execution-a");
			expect(action.runtimeOperationId).toBe("execution-a");
			await driver.validateExternalAction?.(action);
		}

		const previousHeaders = authorizationHeaders.length;
		const next = {
			...command,
			operationId: "operation-b",
			executionId: "execution-b",
			turnId: "turn-b",
			nativeSessionRef: first.nativeSessionRef,
		};
		const second = await driver.execute(next);
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(second.nativeSessionRef, next.executionId),
				).toBe("completed"),
			{ timeout: 10000 },
		);
		expect(authorizationHeaders.slice(previousHeaders).length).toBeGreaterThan(
			0,
		);
		expect(new Set(authorizationHeaders.slice(previousHeaders))).toEqual(
			new Set([`Bearer ${keys.get("execution-b")}`]),
		);
		expect(
			actions
				.slice(previousHeaders)
				.every((action) => action.executionId === "execution-b"),
		).toBe(true);
	} finally {
		await driver.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(path, { recursive: true, force: true });
	}
}, 30000);
