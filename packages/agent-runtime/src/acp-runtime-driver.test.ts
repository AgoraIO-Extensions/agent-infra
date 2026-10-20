import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeManifestV1Schema } from "@agent-infra/contracts/workload";
import { expect, it, vi } from "vitest";
import { GenericAcpRuntimeDriver } from "./acp-runtime-driver.js";
import type { RuntimeNativeSkillCommandV1 } from "./driver.js";
import { createRuntimeFileResultReceiptV1 } from "./runtime-file-bridge.js";
import {
	closeStandardMcpFixtures,
	reference,
	standardMcpFixture,
} from "./standard-mcp.fixture.js";

// Controlled fixture for #2648; it is development evidence, not real Registry/ACP acceptance.
it("runs a controlled custom ACP peer through the platform-adapter contract", async () => {
	const manifest = RuntimeManifestV1Schema.parse({
		schemaVersion: 1,
		interactionMode: "platform-adapter",
		protocol: "acp",
		service: { port: 3003 },
		health: { path: "/healthz" },
		capabilities: { modelSelection: true },
	});
	expect(manifest.interactionMode).toBe("platform-adapter");
	if (manifest.interactionMode !== "platform-adapter") throw new Error();
	expect(manifest.protocol).toBe("acp");
	const path = await mkdtemp(join(tmpdir(), "controlled-custom-acp-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "controlled-custom-acp-v1",
		defaultModelOptionId: "custom-primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "custom-primary",
				nativeModelId: "fixture/custom-model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "custom-acp", NATIVE_PEER_KEEP_ALIVE: "true" },
		}),
	});
	try {
		const accepted = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "custom-agent-fixture",
			conversationId: "custom-conversation",
			sessionGeneration: 1,
			executionId: "custom-execution",
			turnId: "custom-turn",
			operationId: "custom-operation",
			input: { text: "controlled fixture prompt", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "custom-primary",
				reasoningLevel: "high",
			},
		});
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(accepted.nativeSessionRef, "custom-execution"),
			).toBe("completed"),
		);
		expect(
			(await driver.replayEvents(accepted.nativeSessionRef, "custom-execution"))
				.filter((event) => event.type === "text")
				.map((event) => event.payload.delta)
				.join(""),
		).toContain("controlled custom ACP result");
		expect(
			await driver.getModelDirectory(accepted.nativeSessionRef),
		).toMatchObject({
			current: { modelOptionId: "custom-primary", reasoningLevel: "high" },
		});
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("forwards the controlled native Skill prompt through the Generic ACP driver", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-native-skill-prompt-"));
	const nativeSkillPrompt = vi.fn(
		(name: string, parameters: string) =>
			`/${name}${parameters.length > 0 ? ` ${parameters}` : ""}`,
	);
	const skillDirectory = {
		generationId: "a".repeat(64),
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
	};
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		skillDirectory,
		nativeSkillPrompt,
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: {},
		}),
	});
	try {
		const command = driver.createNativeSkillCommand({
			schemaVersion: 1,
			kind: "native-capability",
			operationId: "operation-a",
			agentId: "agent-a",
			conversationId: "conversation-a",
			executionId: "execution-a",
			turnId: "turn-a",
			sessionGeneration: 1,
			nativeSessionRef: "native-a",
			capabilityId: "d".repeat(64),
			directoryRevision: "e".repeat(64),
			packageDigest: "b".repeat(64),
			manifestDigest: "c".repeat(64),
			parameters: "summarize files",
			parametersDigest: "f".repeat(64),
			capabilityName: "workspace-summary",
			capabilitySourceVersion: "1.0.0",
		} satisfies RuntimeNativeSkillCommandV1);
		expect(nativeSkillPrompt).toHaveBeenCalledWith(
			"workspace-summary",
			"summarize files",
		);
		expect(command.input).toEqual({
			text: "/workspace-summary summarize files",
			attachments: [],
		});
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("passes only a local bearer to an ACP protected MCP session", async () => {
	const fixture = await standardMcpFixture();
	const path = await mkdtemp(join(tmpdir(), "acp-connection-bridge-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		standardConnectionClient: {
			target: fixture.target,
			resolveInput: async () => fixture.input,
			fetch: fixture.fetch,
		},
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "mcp-servers" },
		}),
	});
	try {
		expect(await driver.getCapabilities()).toMatchObject({ connection: true });
		const accepted = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: reference.agentId,
			conversationId: reference.conversationId,
			sessionGeneration: reference.sessionGeneration,
			executionId: reference.executionId,
			turnId: "turn-connection",
			operationId: "operation-connection",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(
					accepted.nativeSessionRef,
					reference.executionId,
				),
			).toBe("completed"),
		);
		const session = JSON.parse(
			await readFile(
				join(path, accepted.nativeSessionRef, "workspace", "session.json"),
				"utf8",
			),
		) as { mcpServers: { url: string; headers?: unknown }[] };
		expect(session.mcpServers).toHaveLength(1);
		expect(session.mcpServers[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
		expect(JSON.stringify(session)).not.toContain(fixture.input.token);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
		await closeStandardMcpFixtures();
	}
});

it("persists the first ACP Diff as a confirmed result file event", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-result-file-"));
	const writeResult = vi.fn(
		async (descriptor: {
			name: string;
			mediaType: string;
			sizeBytes: number;
			sha256: string;
		}) =>
			createRuntimeFileResultReceiptV1(
				{
					actorId: "actor-a",
					channelId: "web",
					agentId: "agent-a",
					conversationId: "conversation-a",
					executionId: "execution-a",
					sessionGeneration: 1,
					grantId: "grant-a",
					expiresAt: Date.now() + 60_000,
					inputFileIds: [],
				},
				{
					schemaVersion: 1,
					fileId: "result-file-acp",
					kind: "result",
					descriptor,
					status: "available",
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
			),
	);
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "result-file" },
		}),
	});
	try {
		const accepted = await driver.execute(
			{
				schemaVersion: 2,
				kind: "submit-turn",
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "execution-a",
				turnId: "turn-a",
				operationId: "operation-a",
				input: { text: "synthetic input", attachments: [] },
				selection: {
					schemaVersion: 1,
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
			},
			{
				fileBridge: {
					readInput: async () => {
						throw new Error("unused");
					},
					writeResult,
					revalidate: () => {},
				},
			},
		);
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
			).toBe("completed"),
		);
		expect(writeResult).toHaveBeenCalledOnce();
		expect(
			(await driver.replayEvents(accepted.nativeSessionRef, "execution-a"))
				.filter((event) => event.type === "file")
				.map((event) => event.payload),
		).toEqual([
			{
				fileId: "result-file-acp",
				name: "acp-result.txt",
				mimeType: "text/plain",
				sizeBytes: "ACP result file".length,
			},
		]);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("persists a confirmed ACP result and events, then resumes the same session without resubmitting", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-driver-"));
	const options = {
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: {},
		}),
	};
	let driver = await GenericAcpRuntimeDriver.open(options);
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
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		};
		const result = await driver.execute(command);
		expect(result.result.outcome).toBe("accepted");
		await expect(
			driver.getModelDirectory(result.nativeSessionRef),
		).resolves.toEqual({
			options: [
				{
					modelOptionId: "primary",
					modelId: "provider/model",
					displayName: "provider/model",
					reasoningLevels: ["high"],
				},
			],
			current: { modelOptionId: "primary", reasoningLevel: "high" },
		});
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("completed"),
		);
		const state = JSON.parse(
			await readFile(join(path, result.nativeSessionRef, "state.json"), "utf8"),
		) as {
			turns: {
				operationFacts?: { phase: string; model?: { modelId: string } }[];
			}[];
		};
		expect(state.turns[0]?.operationFacts?.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"completed",
		]);
		expect(state.turns[0]?.operationFacts?.[0]?.model?.modelId).toBe(
			"provider_model",
		);
		const events = await driver.replayEvents(
			result.nativeSessionRef,
			command.executionId,
		);
		expect(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.payload.delta)
				.join(""),
		).toBe("synthetic result 1");
		await driver.close();
		driver = await GenericAcpRuntimeDriver.open(options);
		expect(await driver.execute(command)).toEqual(result);
		expect(
			await driver.getStatus(result.nativeSessionRef, command.executionId),
		).toBe("completed");
		expect(
			await driver.replayEvents(result.nativeSessionRef, command.executionId),
		).toEqual(events);
		const next = await driver.execute({
			...command,
			nativeSessionRef: result.nativeSessionRef,
			operationId: "operation-b",
			executionId: "execution-b",
			turnId: "turn-b",
		});
		await vi.waitFor(async () =>
			expect(await driver.getStatus(next.nativeSessionRef, "execution-b")).toBe(
				"completed",
			),
		);
		expect(
			(await driver.replayEvents(next.nativeSessionRef, "execution-b"))
				.filter((event) => event.type === "text")
				.map((event) => event.payload.delta)
				.join(""),
		).toBe("synthetic result 2");
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("refreshes the V4 authorization resolver on a reused ACP session", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-reuse-"));
	let launches = 0;
	let begins = 0;
	let resolveCredential: (() => Promise<string>) | undefined;
	const actions: string[] = [];
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-v4",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		reuseNativeSession: true,
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		authorizeModelAction: async (action) => {
			actions.push(action.executionId);
			return { relayKey: `synthetic-key-${action.executionId}` };
		},
		launch: async (_directory, _selection, _admit, resolver) => {
			launches++;
			resolveCredential = resolver;
			return {
				command: process.execPath,
				args: [
					fileURLToPath(
						new URL("./acp-peer.test-support.mjs", import.meta.url),
					),
				],
				env: { ACP_TEST_MODE: "hold" },
				beginTurn: () => {
					begins++;
				},
				reusable: () => true,
			};
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
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		};
		const first = await driver.execute(command);
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(first.nativeSessionRef, "execution-a"),
			).toBe("running"),
		);
		expect(await resolveCredential?.()).toBe("synthetic-key-execution-a");
		const stop = (
			nativeSessionRef: string,
			executionId: string,
			turnId: string,
		) =>
			driver.execute({
				schemaVersion: 1,
				kind: "stop",
				agentId: command.agentId,
				conversationId: command.conversationId,
				sessionGeneration: 1,
				nativeSessionRef,
				executionId,
				turnId,
				operationId: `stop-${executionId}`,
			});
		await stop(first.nativeSessionRef, "execution-a", "turn-a");
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(first.nativeSessionRef, "execution-a"),
			).toBe("cancelled"),
		);
		await expect(resolveCredential?.()).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
		const next = await driver.execute({
			...command,
			nativeSessionRef: first.nativeSessionRef,
			executionId: "execution-b",
			turnId: "turn-b",
			operationId: "operation-b",
		});
		await vi.waitFor(async () =>
			expect(await driver.getStatus(next.nativeSessionRef, "execution-b")).toBe(
				"running",
			),
		);
		expect(launches).toBe(1);
		expect(begins).toBe(1);
		expect(resolveCredential).toBeDefined();
		expect(await resolveCredential?.()).toBe("synthetic-key-execution-b");
		expect(actions).toEqual(["execution-a", "execution-b"]);
		await stop(next.nativeSessionRef, "execution-b", "turn-b");
		await vi.waitFor(async () =>
			expect(await driver.getStatus(next.nativeSessionRef, "execution-b")).toBe(
				"cancelled",
			),
		);
		await expect(resolveCredential?.()).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("keeps a lost active turn unknown after restart and blocks another turn without quarantining its session", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-unknown-"));
	const options = {
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "hold" },
		}),
	};
	let driver = await GenericAcpRuntimeDriver.open(options);
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
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		};
		const accepted = await driver.execute(command);
		expect(accepted.result.outcome).toBe("accepted");
		expect(
			await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
		).toBe("running");
		await driver.close();
		driver = await GenericAcpRuntimeDriver.open(options);
		expect(
			await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
		).toBe("unknown");
		expect(await driver.execute(command)).toEqual(accepted);
		expect(await driver.lookupOperation(command)).toEqual({
			state: "found",
			record: accepted,
		});
		const next = {
			...command,
			nativeSessionRef: accepted.nativeSessionRef,
			executionId: "execution-b",
			turnId: "turn-b",
			operationId: "operation-b",
		};
		expect((await driver.execute(next)).result.outcome).toBe("busy");
		expect(
			(
				await driver.replayEvents(accepted.nativeSessionRef, "execution-a")
			).filter((e) => e.type === "completed"),
		).toEqual([]);
		const other = await driver.execute({
			...command,
			conversationId: "conversation-b",
		});
		expect(other.result.outcome).toBe("accepted");
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("does not log raw malformed frames, notification parameters or unsolicited response IDs", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-redaction-"));
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "malformed" },
		}),
	});
	try {
		const accepted = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
			).toBe("completed"),
		);
		expect(logged).not.toHaveBeenCalled();
	} finally {
		await driver.close();
		logged.mockRestore();
		await rm(path, { recursive: true, force: true });
	}
});

it("rejects a model changed by the peer while setting effort before any prompt", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-selection-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "changed-model" },
		}),
	});
	try {
		const rejected = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		expect(rejected.result).toMatchObject({
			outcome: "rejected",
			code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
		});
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it.each(["ignore-cancel", "delayed-cancel"])(
	"keeps %s unknown until a reliable stop result arrives",
	async (mode) => {
		const path = await mkdtemp(join(tmpdir(), "acp-cancel-unknown-"));
		const driver = await GenericAcpRuntimeDriver.open({
			path,
			configVersion: "configuration-a",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					nativeModelId: "provider/model",
					reasoningLevels: ["high"],
				},
			],
			launch: async () => ({
				command: process.execPath,
				args: [
					fileURLToPath(
						new URL("./acp-peer.test-support.mjs", import.meta.url),
					),
				],
				env: { ACP_TEST_MODE: mode },
			}),
		});
		try {
			const accepted = await driver.execute({
				schemaVersion: 2,
				kind: "submit-turn",
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "execution-a",
				turnId: "turn-a",
				operationId: "operation-a",
				input: { text: "synthetic input", attachments: [] },
				selection: {
					schemaVersion: 1,
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
			});
			const stopCommand = {
				schemaVersion: 1,
				kind: "stop",
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "execution-a",
				turnId: "turn-a",
				operationId: "stop-a",
				nativeSessionRef: accepted.nativeSessionRef,
			} as const;
			const stop = await driver.execute(stopCommand);
			expect(stop.result.outcome).toBe("unknown");
			expect(
				(
					await driver.replayEvents(accepted.nativeSessionRef, "execution-a")
				).some((e) => e.type === "completed"),
			).toBe(false);
			if (mode === "delayed-cancel") {
				// peer 在收到 cancel 后延迟 2200ms 才返回 stopReason:"cancelled"，
				// 给 waitFor 设置足够的 timeout 避免 flaky 超时
				await vi.waitFor(
					async () =>
						expect(
							await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
						).toBe("cancelled"),
					{ timeout: 5000 },
				);
				expect(await driver.lookupOperation(stopCommand)).toMatchObject({
					state: "found",
					record: { result: { outcome: "accepted", status: "cancelled" } },
				});
			}
		} finally {
			await driver.close();
			await rm(path, { recursive: true, force: true });
		}
	},
);

it("probes ACP initialization and Session creation without prompting", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-readiness-"));
	let launches = 0;
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "grouped-models" },
			close: async () => {
				launches++;
			},
		}),
	});
	try {
		expect(await driver.getCapabilities()).toMatchObject({
			connection: false,
		});
		await expect(
			driver.probeReadiness?.(new AbortController().signal),
		).resolves.toMatchObject({
			modelSelection: true,
			attachments: false,
			resultFiles: true,
			connection: false,
			supplementaryInstruction: false,
		});
		expect(launches).toBe(1);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("advertises attachments only for an ACP peer that negotiates image input", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-readiness-image-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "image-prompt" },
		}),
	});
	try {
		await expect(
			driver.probeReadiness?.(new AbortController().signal),
		).resolves.toMatchObject({
			modelSelection: true,
			attachments: true,
			resultFiles: true,
			connection: false,
			supplementaryInstruction: false,
		});
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("rejects bridge attachments before reading bytes when image input is not negotiated", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-attachment-unsupported-"));
	const readInput = vi.fn();
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "grouped-models" },
		}),
	});
	try {
		await expect(
			driver.execute(
				{
					schemaVersion: 2 as const,
					kind: "submit-turn" as const,
					agentId: "agent-a",
					conversationId: "conversation-a",
					sessionGeneration: 1,
					executionId: "execution-a",
					turnId: "turn-a",
					operationId: "operation-a",
					input: { text: "inspect", attachments: ["file-1"] },
					selection: {
						schemaVersion: 1 as const,
						modelOptionId: "primary",
						reasoningLevel: "high",
					},
				},
				{
					fileBridge: {
						readInput,
						revalidate: () => {},
						writeResult: async () => {
							throw new Error("unused");
						},
					},
				},
			),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(readInput).not.toHaveBeenCalled();
		// The peer never ran session/new, so rejecting left no native side effect.
		const created = (await readdir(path, { recursive: true })).filter((entry) =>
			entry.endsWith("session.json"),
		);
		expect(created).toEqual([]);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("reads bridge attachments once the peer negotiated image input", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-attachment-negotiated-"));
	const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	const readInput = vi.fn(async (fileId: string) => ({
		fileId,
		descriptor: {
			name: "screen.png",
			mediaType: "image/png",
			sizeBytes: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		},
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	}));
	const revalidate = vi.fn();
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "image-prompt" },
		}),
	});
	try {
		// Initialization negotiates image input before any Session exists, and the
		// probe records that answer for the following attachment request.
		await expect(
			driver.probeReadiness?.(new AbortController().signal),
		).resolves.toMatchObject({ attachments: true });
		const accepted = await driver.execute(
			{
				schemaVersion: 2 as const,
				kind: "submit-turn" as const,
				agentId: "agent-a",
				conversationId: "conversation-a",
				sessionGeneration: 1,
				executionId: "execution-a",
				turnId: "turn-a",
				operationId: "operation-a",
				input: { text: "inspect", attachments: ["file-1"] },
				selection: {
					schemaVersion: 1 as const,
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
			},
			{
				fileBridge: {
					readInput,
					revalidate,
					writeResult: async () => {
						throw new Error("unused");
					},
				},
			},
		);
		expect(accepted.result).toMatchObject({ outcome: "accepted" });
		expect(readInput).toHaveBeenCalledWith("file-1");
		expect(revalidate).toHaveBeenCalled();
		// The image prompt reached the Session that was created for this request.
		const sessions = (await readdir(path, { recursive: true })).filter(
			(entry) => entry.endsWith("session.json"),
		);
		expect(sessions).toHaveLength(1);
		expect(
			JSON.parse(await readFile(join(path, sessions[0] ?? ""), "utf8")),
		).toMatchObject({ count: 1 });
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("fails the ACP readiness probe closed when loadSession is not advertised", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-readiness-fail-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "no-load-session" },
		}),
	});
	try {
		await expect(
			driver.probeReadiness?.(new AbortController().signal),
		).rejects.toThrow("RUNTIME_READINESS_UNAVAILABLE");
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("does not advertise model selection from a current value without selectable values", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-readiness-current-only-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "current-model-only" },
		}),
	});
	try {
		await expect(
			driver.probeReadiness?.(new AbortController().signal),
		).resolves.toMatchObject({
			modelSelection: false,
			attachments: false,
			resultFiles: true,
			connection: false,
			supplementaryInstruction: false,
		});
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("projects the current native model and reasoning choices", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-model-directory-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high", "low"],
			},
			{
				modelOptionId: "secondary",
				nativeModelId: "provider/other",
				reasoningLevels: ["high", "low"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "grouped-models" },
		}),
	});
	try {
		const result = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "secondary",
				reasoningLevel: "high",
			},
		});
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(result.nativeSessionRef, "execution-a"),
			).toBe("completed"),
		);
		expect(await driver.getModelDirectory(result.nativeSessionRef)).toEqual({
			options: [
				{
					modelOptionId: "secondary",
					modelId: "provider/other",
					displayName: "provider/other",
					reasoningLevels: ["high"],
				},
			],
			current: { modelOptionId: "secondary", reasoningLevel: "high" },
		});
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it("normalizes a native execution limit to a redacted error and failed terminal event", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-limit-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "limit" },
		}),
	});
	try {
		const accepted = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		await vi.waitFor(async () =>
			expect(
				await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
			).toBe("failed"),
		);
		expect(
			(await driver.replayEvents(accepted.nativeSessionRef, "execution-a"))
				.filter((e) => e.type === "error")
				.map((e) => e.payload),
		).toEqual([
			{
				code: "RUNTIME_EXECUTION_FAILED",
				message: "Runtime execution failed",
				retryable: false,
			},
		]);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});

it.each(["native-session", "durable-state"])(
	"isolates %s recovery failure and durably cancels the generation",
	async (damage) => {
		const path = await mkdtemp(join(tmpdir(), "acp-session-loss-"));
		const options = {
			path,
			configVersion: "configuration-a",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					nativeModelId: "provider/model",
					reasoningLevels: ["high"],
				},
			],
			launch: async () => ({
				command: process.execPath,
				args: [
					fileURLToPath(
						new URL("./acp-peer.test-support.mjs", import.meta.url),
					),
				],
				env: { ACP_TEST_MODE: "hold" },
			}),
		};
		let driver = await GenericAcpRuntimeDriver.open(options);
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
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
			};
			const accepted = await driver.execute(command);
			await driver.close();
			if (damage === "native-session")
				await rm(
					join(path, accepted.nativeSessionRef, "workspace/session.json"),
				);
			else
				await writeFile(
					join(path, accepted.nativeSessionRef, "state.json"),
					"{broken",
				);
			driver = await GenericAcpRuntimeDriver.open(options);
			await expect(
				driver.getStatus(accepted.nativeSessionRef, "execution-a"),
			).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
			const cancellation = {
				schemaVersion: 1 as const,
				kind: "generation-cancel" as const,
				agentId: command.agentId,
				conversationId: command.conversationId,
				sessionGeneration: 1,
				nativeSessionRef: accepted.nativeSessionRef,
				executionId: command.executionId,
				turnId: command.turnId,
				operationId: "tombstone-a",
			};
			expect(await driver.lookupOperation(cancellation)).toEqual({
				state: "missing",
			});
			const cancelled = await driver.execute(cancellation);
			expect(cancelled.result).toEqual({
				outcome: "accepted",
				status: "cancelled",
			});
			await driver.close();
			driver = await GenericAcpRuntimeDriver.open(options);
			expect(await driver.execute(cancellation)).toEqual(cancelled);
			expect(await driver.lookupOperation(cancellation)).toEqual({
				state: "found",
				record: cancelled,
			});
			await expect(
				driver.execute({ ...cancellation, executionId: "different" }),
			).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
			await expect(
				driver.execute({
					...command,
					nativeSessionRef: accepted.nativeSessionRef,
					executionId: "next",
					turnId: "next",
					operationId: "next",
				}),
			).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
			if (damage === "native-session") {
				expect(
					await driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("unknown");
				expect(
					(
						await driver.replayEvents(
							accepted.nativeSessionRef,
							command.executionId,
						)
					).filter((e) => e.type === "completed"),
				).toEqual([]);
			}
			const other = await driver.execute({
				...command,
				conversationId: "conversation-b",
			});
			expect(other.result.outcome).toBe("accepted");
		} finally {
			await driver.close();
			await rm(path, { recursive: true, force: true });
		}
	},
);

it("rejects cross-Agent, Conversation, generation, native-reference and execution commands", async () => {
	const path = await mkdtemp(join(tmpdir(), "acp-binding-"));
	const driver = await GenericAcpRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./acp-peer.test-support.mjs", import.meta.url)),
			],
			env: { ACP_TEST_MODE: "hold" },
		}),
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
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		};
		const accepted = await driver.execute(command);
		for (const mismatch of [
			{ agentId: "agent-b" },
			{ conversationId: "conversation-b" },
			{ sessionGeneration: 2 },
			{ nativeSessionRef: "unknown" },
		]) {
			const forged = {
				...command,
				nativeSessionRef: accepted.nativeSessionRef,
				...mismatch,
			};
			await expect(driver.execute(forged)).rejects.toMatchObject({
				code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
			});
			await expect(driver.lookupOperation(forged)).rejects.toMatchObject({
				code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
			});
			const cancellation = {
				schemaVersion: 1 as const,
				kind: "generation-cancel" as const,
				operationId: "forged-cancel",
				agentId: forged.agentId,
				conversationId: forged.conversationId,
				sessionGeneration: forged.sessionGeneration,
				nativeSessionRef: forged.nativeSessionRef,
				executionId: command.executionId,
				turnId: command.turnId,
			};
			await expect(driver.execute(cancellation)).rejects.toMatchObject({
				code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE",
			});
		}
		await expect(
			driver.getStatus(accepted.nativeSessionRef, "execution-b"),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		await expect(
			driver.replayEvents(accepted.nativeSessionRef, "execution-b"),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(await driver.execute(command)).toEqual(accepted);
		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("running");
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});
