import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserHandoffControllerV1 } from "./browser-handoff.js";
import { ClaudeRuntimeDriver } from "./claude-runtime-driver.js";
import type {
	RuntimeBrowserHandoffRequestV1,
	RuntimeBrowserSideEffectConfirmationRequestV1,
	RuntimeDriverExecutionContextV1,
} from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { PiRuntimeDriver } from "./pi-runtime-driver.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";

const binding = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	sessionGeneration: 1,
	resourceFence: 2,
	workloadRevision: 3,
	imageDigest: `sha256:${"a".repeat(64)}`,
};

const runtime = {
	browserAlive: true,
	authorized: true,
	subjectId: "subject-1",
	...binding,
	executionId: "execution-1",
	capabilityVersion: 3,
	pageRevision: 2,
};

const handoffRequest: RuntimeBrowserHandoffRequestV1 = {
	kind: "request",
	reason: "mfa",
	runtime,
};

const sideEffectRequest: RuntimeBrowserSideEffectConfirmationRequestV1 = {
	command: "confirm",
	binding: {
		actionId: "action-1",
		confirmationId: "confirmation-1",
		operationRef: "operation-1",
		attemptRef: "attempt-1",
		...binding,
		executionId: "execution-1",
		capabilityVersion: 3,
		pageRevision: 2,
	},
};

const controller = {
	assertAgentAccess: () => {},
	assertBinding: () => {},
	request: () => ({ status: "requested" }),
	takeOver: () => ({ status: "active" }),
	returnToAgent: () => ({ status: "completed" }),
	revoke: () => ({ status: "revoked" }),
	markBrowserCrashed: () => ({ status: "crashed" }),
} as unknown as BrowserHandoffControllerV1;

async function fixture(
	Driver: typeof ClaudeRuntimeDriver | typeof SessionRuntimeDriver,
) {
	const path = await mkdtemp(join(tmpdir(), "browser-driver-controls-"));
	const ref = "11111111-1111-4111-8111-111111111111";
	const index = await DurableJsonFile.open(join(path, "index.json"), {
		schemaVersion: 1,
		sessions: [{ ref, ...binding }],
	});
	const state = {
		schemaVersion: 1,
		binding: { ref, ...binding },
		nativeId: "native-1",
		started: true,
		cancelled: false,
		sequence: 0,
		operations: [],
		turns: [
			{
				executionId: "execution-1",
				turnId: "turn-1",
				operationKey: "operation-1",
				userMessageId: "message-1",
				configVersion: "config-1",
				selection: {
					schemaVersion: 1,
					modelOptionId: "model-1",
					reasoningLevel: "high",
				},
				status: "running",
				events: [],
			},
		],
	};
	const driver = Object.assign(Object.create(Driver.prototype), {
		options: { path, configVersion: "config-1" },
		index,
		files: new Map(),
		locks: new Map(),
		handles: new Map(),
		waiters: new Map(),
		closed: false,
		pending: new Set(),
		file: async () => ({ read: () => state }),
	});
	return { driver, path, ref, state };
}

async function piFixture() {
	const path = await mkdtemp(join(tmpdir(), "pi-browser-driver-controls-"));
	const ref = "22222222-2222-4222-8222-222222222222";
	const sessionBinding = { ref, ...binding };
	const operationKey = JSON.stringify(["submit-turn", "operation-1"]);
	const state = {
		schemaVersion: 1,
		binding: sessionBinding,
		cancelled: false,
		sequence: 0,
		operations: [{ key: operationKey, digest: "a".repeat(64) }],
		turns: [
			{
				kind: "submit-turn" as const,
				executionId: "execution-1",
				turnId: "turn-1",
				operationKey,
				configVersion: "config-1",
				selection: {
					schemaVersion: 1 as const,
					modelOptionId: "model-1",
					reasoningLevel: "high",
				},
				status: "running" as const,
				events: [],
			},
		],
	};
	await mkdir(join(path, ref), { recursive: true, mode: 0o700 });
	await writeFile(
		join(path, "index.json"),
		`${JSON.stringify({ schemaVersion: 1, sessions: [sessionBinding] })}\n`,
	);
	await writeFile(join(path, ref, "state.json"), `${JSON.stringify(state)}\n`);
	const driver = await PiRuntimeDriver.open({
		path,
		configVersion: "config-1",
		defaultModelOptionId: "model-1",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "model-1",
				nativeModelId: "native-model-1",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => {
			throw new Error("unexpected Pi native launch");
		},
	});
	const files = (
		driver as unknown as {
			files: Map<string, Promise<{ read: () => typeof state }>>;
		}
	).files;
	files.set(ref, Promise.resolve({ read: () => state }));
	return { driver, path, ref };
}

describe.each([
	["Claude", ClaudeRuntimeDriver],
	["Session/OpenCode/ACP", SessionRuntimeDriver],
] as const)("%s Browser control Driver", (_name, Driver) => {
	it("delegates handoff and side-effect controls after validating the Session binding", async () => {
		const { driver, path, ref } = await fixture(Driver);
		const executeSideEffect = async () => ({
			actionId: "action-1",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			phase: "completed" as const,
		});
		const browser = {
			capabilityVersion: 3,
			binding,
			handoff: { controller },
			executeSideEffect,
		};
		const context = { browser } as RuntimeDriverExecutionContextV1;
		try {
			await expect(
				driver.executeBrowserHandoff(
					ref,
					"execution-1",
					handoffRequest,
					context,
				),
			).resolves.toMatchObject({ status: "requested" });
			await expect(
				driver.executeBrowserSideEffect(
					ref,
					"execution-1",
					sideEffectRequest,
					context,
				),
			).resolves.toMatchObject({ phase: "completed" });
		} finally {
			await rm(path, { recursive: true, force: true });
		}
	});

	it("fails closed before controller I/O for a foreign side-effect binding", async () => {
		const { driver, path, ref } = await fixture(Driver);
		let calls = 0;
		const context = {
			browser: {
				capabilityVersion: 3,
				binding,
				executeSideEffect: async () => {
					calls++;
					return {
						actionId: "action-1",
						operationRef: "operation-1",
						attemptRef: "attempt-1",
						phase: "completed" as const,
					};
				},
			},
		} as unknown as RuntimeDriverExecutionContextV1;
		try {
			await expect(
				driver.executeBrowserSideEffect(
					ref,
					"execution-1",
					{
						...sideEffectRequest,
						binding: {
							...sideEffectRequest.binding,
							conversationId: "foreign-conversation",
						},
					},
					context,
				),
			).rejects.toThrow();
			await expect(
				driver.executeBrowserHandoff(
					ref,
					"execution-1",
					handoffRequest,
					{} as RuntimeDriverExecutionContextV1,
				),
			).rejects.toThrow();
			expect(calls).toBe(0);
		} finally {
			await rm(path, { recursive: true, force: true });
		}
	});

	it("fails closed before controller I/O for stale handoff runtime or inactive execution", async () => {
		const { driver, path, ref, state } = await fixture(Driver);
		let calls = 0;
		const context = {
			browser: {
				capabilityVersion: 3,
				binding,
				handoff: {
					controller: {
						...controller,
						request: () => {
							calls++;
							return { status: "requested" };
						},
					},
				},
			},
		} as unknown as RuntimeDriverExecutionContextV1;
		try {
			await expect(
				driver.executeBrowserHandoff(
					ref,
					"execution-1",
					{
						...handoffRequest,
						runtime: { ...runtime, resourceFence: 9 },
					},
					context,
				),
			).rejects.toThrow();
			const turn = state.turns[0];
			if (!turn) throw new Error("missing fixture turn");
			turn.status = "completed";
			await expect(
				driver.executeBrowserHandoff(
					ref,
					"execution-1",
					handoffRequest,
					context,
				),
			).rejects.toThrow();
			expect(calls).toBe(0);
		} finally {
			await rm(path, { recursive: true, force: true });
		}
	});
});

describe("Pi Browser control Driver", () => {
	it("uses the Session control seam for handoff and side-effect confirmation", async () => {
		const { driver, path, ref } = await piFixture();
		const executeSideEffect = async () => ({
			actionId: "action-1",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			phase: "completed" as const,
		});
		const context = {
			browser: {
				capabilityVersion: 3,
				binding,
				handoff: { controller },
				executeSideEffect,
			},
		} as RuntimeDriverExecutionContextV1;
		try {
			await expect(
				driver.executeBrowserHandoff(
					ref,
					"execution-1",
					handoffRequest,
					context,
				),
			).resolves.toMatchObject({ status: "requested" });
			await expect(
				driver.executeBrowserHandoff(
					ref,
					"execution-1",
					{
						kind: "take-over",
						handoffId: "handoff-1",
						operatorId: "operator-1",
						subjectId: "subject-1",
						runtime,
					},
					context,
				),
			).resolves.toMatchObject({ status: "active" });
			await expect(
				driver.executeBrowserHandoff(
					ref,
					"execution-1",
					{
						kind: "return-to-agent",
						handoffId: "handoff-1",
						operatorId: "operator-1",
						runtime,
					},
					context,
				),
			).resolves.toMatchObject({ status: "completed" });
			await expect(
				driver.executeBrowserHandoff(
					ref,
					"execution-1",
					{
						kind: "revoke",
						runtime,
						reason: "BROWSER_HANDOFF_REVOKED",
					},
					context,
				),
			).resolves.toMatchObject({ status: "revoked" });
			await expect(
				driver.executeBrowserSideEffect(
					ref,
					"execution-1",
					sideEffectRequest,
					context,
				),
			).resolves.toMatchObject({ phase: "completed" });
		} finally {
			await driver.close();
			await rm(path, { recursive: true, force: true });
		}
	});

	it("fails closed before controller I/O for a foreign Browser binding", async () => {
		const { driver, path, ref } = await piFixture();
		let calls = 0;
		const context = {
			browser: {
				capabilityVersion: 3,
				binding,
				handoff: {
					controller: {
						...controller,
						request: () => {
							calls++;
							return { status: "requested" as const };
						},
					},
				},
				executeSideEffect: async () => {
					calls++;
					return {
						actionId: "action-1",
						operationRef: "operation-1",
						attemptRef: "attempt-1",
						phase: "completed" as const,
					};
				},
			},
		} as unknown as RuntimeDriverExecutionContextV1;
		try {
			await expect(
				driver.executeBrowserHandoff(
					ref,
					"execution-1",
					{
						...handoffRequest,
						runtime: { ...runtime, resourceFence: 9 },
					},
					context,
				),
			).rejects.toThrow();
			await expect(
				driver.executeBrowserSideEffect(
					ref,
					"execution-1",
					{
						...sideEffectRequest,
						binding: {
							...sideEffectRequest.binding,
							conversationId: "foreign-conversation",
						},
					},
					context,
				),
			).rejects.toThrow();
			expect(calls).toBe(0);
		} finally {
			await driver.close();
			await rm(path, { recursive: true, force: true });
		}
	});
});
