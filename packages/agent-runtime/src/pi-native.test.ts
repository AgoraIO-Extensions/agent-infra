import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@agent-infra/contracts/runtime";
import { expect, it, vi } from "vitest";
import type {
	RuntimeDriverOperationRecord,
	RuntimeExternalActionAuthorization,
} from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import {
	fixtureNow,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
import { openMessagesRuntimeDriverConformanceFixture } from "./messages-runtime-driver.test-support.js";
import { openPiRuntime } from "./pi-bootstrap.js";
import { RuntimeHost } from "./runtime-host.js";

const piProcess = vi.hoisted(() => ({
	capture: false,
	child: undefined as ChildProcess | undefined,
}));
vi.mock("./native-process.js", async (importOriginal) => {
	const native = await importOriginal<typeof import("./native-process.js")>();
	return {
		...native,
		spawnNativeProcess: async (
			...args: Parameters<typeof native.spawnNativeProcess>
		) => {
			const owned = await native.spawnNativeProcess(...args);
			if (piProcess.capture) piProcess.child = owned.child;
			return owned;
		},
	};
});

it("preserves an unconfirmed model request after the native turn fails on HTTP 503", async () => {
	const path = await mkdtemp(join(tmpdir(), "pi-native-503-"));
	const fixture = await openMessagesRuntimeDriverConformanceFixture(
		path,
		false,
		"pi",
		503,
	);
	try {
		const command = {
			schemaVersion: 2 as const,
			kind: "submit-turn" as const,
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-503",
			turnId: "turn-503",
			operationId: "operation-503",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "model-option-primary",
				reasoningLevel: "high",
			},
		};
		const record = await fixture.driver.execute(command);
		await vi.waitFor(async () =>
			expect(
				await fixture.driver.getStatus(
					record.nativeSessionRef,
					command.executionId,
				),
			).toBe("unknown"),
		);
		const events = await fixture.driver.replayEvents(
			record.nativeSessionRef,
			command.executionId,
		);
		const facts = events.flatMap((event) =>
			event.type === "operation" && event.payload.kind === "model"
				? [event.payload.phase]
				: [],
		);
		expect(facts).toEqual(["intent", "started", "unknown"]);
		expect(
			(
				await fixture.driver.execute({
					...command,
					nativeSessionRef: record.nativeSessionRef,
					executionId: "execution-after-503",
					turnId: "turn-after-503",
					operationId: "operation-after-503",
				})
			).result,
		).toEqual({ outcome: "busy" });
		await fixture.restart();
		expect(
			await fixture.driver.getStatus(
				record.nativeSessionRef,
				command.executionId,
			),
		).toBe("unknown");
		expect(
			await fixture.driver.replayEvents(
				record.nativeSessionRef,
				command.executionId,
			),
		).toEqual(events);
		expect(await fixture.createdTurnCount()).toBe(1);
	} finally {
		await fixture.close();
		await rm(path, { recursive: true, force: true });
	}
}, 30_000);

it("keeps an in-flight model request unknown after the pinned Pi process dies", async () => {
	const path = await mkdtemp(join(tmpdir(), "pi-native-in-flight-exit-"));
	const fixture = await openMessagesRuntimeDriverConformanceFixture(
		path,
		false,
		"pi",
	);
	piProcess.capture = true;
	try {
		const command = {
			schemaVersion: 2 as const,
			kind: "submit-turn" as const,
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-in-flight",
			turnId: "turn-in-flight",
			operationId: "operation-in-flight",
			input: { text: "synthetic input", attachments: [] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "model-option-primary",
				reasoningLevel: "high",
			},
		};
		const accepted = await fixture.driver.execute(command);
		expect(accepted.result.outcome).toBe("accepted");
		expect(await fixture.createdTurnCount()).toBe(1);
		await vi.waitFor(async () =>
			expect(
				await fixture.driver.getStatus(
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toBe("running"),
		);
		await vi.waitFor(async () =>
			expect(
				(
					await fixture.driver.replayEvents(
						accepted.nativeSessionRef,
						command.executionId,
					)
				).flatMap((event) =>
					event.type === "operation" && event.payload.kind === "model"
						? [event.payload.phase]
						: [],
				),
			).toEqual(["intent", "started"]),
		);
		const child = piProcess.child;
		if (!child) throw new Error("Pi process was not captured");
		expect(child.exitCode).toBeNull();
		expect(child.signalCode).toBeNull();
		expect(child.kill("SIGKILL")).toBe(true);
		await vi.waitFor(() => expect(child.signalCode).toBe("SIGKILL"));
		await vi.waitFor(
			async () =>
				expect(
					await fixture.driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("unknown"),
			{ timeout: 10_000 },
		);
		const events = await fixture.driver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(
			events.flatMap((event) =>
				event.type === "operation" && event.payload.kind === "model"
					? [event.payload.phase]
					: [],
			),
		).toEqual(["intent", "started", "unknown"]);
		expect(await fixture.driver.execute(command)).toEqual(accepted);
		await fixture.restart();
		expect(await fixture.driver.execute(command)).toEqual(accepted);
		expect(
			await fixture.driver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			),
		).toBe("unknown");
		expect(
			await fixture.driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			),
		).toEqual(events);
		const blocked = await fixture.driver.execute({
			...command,
			nativeSessionRef: accepted.nativeSessionRef,
			executionId: "execution-after-exit",
			turnId: "turn-after-exit",
			operationId: "operation-after-exit",
		});
		expect(blocked.result).toEqual({ outcome: "busy" });
		expect(blocked.nativeSessionRef).toBe(accepted.nativeSessionRef);
		expect(await fixture.createdTurnCount()).toBe(1);
	} finally {
		await fixture.close();
		await rm(path, { recursive: true, force: true });
		piProcess.capture = false;
		piProcess.child = undefined;
	}
}, 30_000);

it("runs the pinned Pi CLI against Messages and persists the confirmed result", async () => {
	const path = await mkdtemp(join(tmpdir(), "pi-native-"));
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
		const modelFacts = before.flatMap((event) =>
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
			usage: { inputTokens: 10, outputTokens: 2 },
		});
		expect(modelFacts.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
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
}, 30_000);

type NativeTool = { id: string; name: string; input: Record<string, unknown> };
async function nativeToolsFixture(
	tools: NativeTool[],
	guard?: (action: RuntimeExternalActionAuthorization) => Promise<void>,
	hostClock?: { now: number },
) {
	const path = await mkdtemp(join(tmpdir(), "pi-native-tools-"));
	const first = Promise.withResolvers<ServerResponse>();
	const requests: { messages: unknown[] }[] = [];
	let next = 0;
	function reply(response: ServerResponse, tool?: NativeTool) {
		for (const event of [
			{
				type: "content_block_start",
				index: 0,
				content_block: tool
					? { type: "tool_use", id: tool.id, name: tool.name, input: {} }
					: { type: "text", text: "" },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: tool
					? {
							type: "input_json_delta",
							partial_json: JSON.stringify(tool.input),
						}
					: { type: "text_delta", text: "synthetic completion" },
			},
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: {
					stop_reason: tool ? "tool_use" : "end_turn",
					stop_sequence: null,
				},
				usage: { output_tokens: 2 },
			},
			{ type: "message_stop" },
		])
			response.write(`data: ${JSON.stringify(event)}\n\n`);
		response.end();
	}
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		requests.push(body);
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(
			`data: ${JSON.stringify({
				type: "message_start",
				message: {
					id: `msg_${requests.length}`,
					type: "message",
					role: "assistant",
					model: body.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			})}\n\n`,
		);
		if (requests.length === 1) first.resolve(response);
		else reply(response, tools[next++]);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	let host: RuntimeHost | undefined;
	const runtimeOptions: Parameters<typeof openPiRuntime>[0] = {
		path,
		configVersion: "pi-tools-test",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		authorizeExternalAction: async (action) => {
			if (action.kind === "model") {
				if (hostClock) {
					if (!host) throw new Error("Missing real Host model authority");
					await host.authorizeExternalAction(action);
				} else {
					// Direct native tool cases validate model journal admission separately from tool policy.
					await driver.validateExternalAction(action);
				}
			} else {
				if (!guard) throw new Error("Missing tool business authority");
				await guard(action);
			}
		},
		modelOptions: [
			{
				modelOptionId: "primary",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				endpoint: `http://127.0.0.1:${address.port}`,
				credential: "synthetic-model-credential",
				authentication: "bearer",
			},
		],
	};
	let driver = await openPiRuntime(runtimeOptions);
	const command = {
		schemaVersion: 2 as const,
		kind: "submit-turn" as const,
		agentId: "agent-a",
		conversationId: "conversation-a",
		sessionGeneration: 1,
		executionId: "execution-a",
		turnId: "turn-a",
		operationId: "execution-a",
		input: { text: "synthetic input", attachments: [] },
		selection: {
			schemaVersion: 1 as const,
			modelOptionId: "primary",
			reasoningLevel: "high",
		},
	};
	let record: RuntimeDriverOperationRecord;
	if (hostClock) {
		host = await RuntimeHost.open({
			driver,
			store: await FileRuntimeStore.open(join(path, "host.json")),
			grantValidation: { expectedIssuer: "agent-platform" },
			grantValidationV2: {
				expectedIssuer: "platform-fixture",
				expectedWorkerId: "worker-fixture",
				now: () => hostClock.now,
			},
		});
		const request = signV3Fixture(
			{
				...submitV3Fixture(),
				agentId: command.agentId,
				conversationId: command.conversationId,
				executionId: command.executionId,
				turnId: command.turnId,
				operation: {
					kind: "execution" as const,
					id: command.operationId,
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
				input: command.input,
				selection: command.selection,
			},
			"turn.submit",
			{ now: hostClock.now },
		);
		await host.submitTurnV3(request, verifyRuntimeV2Fixture(request.grant));
		const lookup = await driver.lookupOperation(command);
		if (lookup.state !== "found")
			throw new Error("Missing real Host acceptance");
		record = lookup.record;
	} else record = await driver.execute(command);
	const workspace = join(path, record.nativeSessionRef, "workspace");
	return {
		get driver() {
			return driver;
		},
		host,
		record,
		workspace,
		requests,
		async start() {
			reply(await first.promise, tools[next++]);
		},
		async complete(outcome: "completed" | "blocked" = "completed") {
			await vi.waitFor(
				async () => {
					const status = await driver.getStatus(
						record.nativeSessionRef,
						command.executionId,
					);
					if (outcome === "completed") expect(status).toBe("completed");
					else expect(["failed", "unknown"]).toContain(status);
				},
				{ timeout: 10_000 },
			);
		},
		facts: () =>
			driver.replayEvents(record.nativeSessionRef, command.executionId),
		async reopen() {
			await driver.close();
			driver = await openPiRuntime(runtimeOptions);
			return driver.execute(command);
		},
		async close() {
			await host?.close();
			await driver.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(path, { recursive: true, force: true });
		},
	};
}

it("gates actual pinned Pi read/write/edit and rejects re-execution of a completed native call", async () => {
	const waiting = Promise.withResolvers<void>();
	const admitted = Promise.withResolvers<void>();
	const permit = vi.fn(async (action: RuntimeExternalActionAuthorization) => {
		await fixture.driver.validateExternalAction(action);
		if (permit.mock.calls.length === 4)
			throw new Error("SYNTHETIC_AUTHORIZATION_REVOKED");
		if (permit.mock.calls.length === 1) {
			for (const field of [
				"nativeSessionRef",
				"executionId",
				"runtimeOperationId",
				"operationRef",
				"attemptRef",
			])
				await expect(
					fixture.driver.validateExternalAction({
						...action,
						[field]: "forged-reference",
					}),
				).rejects.toThrow();
			admitted.resolve();
			await waiting.promise;
		}
	});
	const fixture = await nativeToolsFixture(
		[
			{ id: "read-1", name: "read", input: { path: "owner.txt" } },
			{
				id: "write-1",
				name: "write",
				input: { path: "nested/new.txt", content: "first write" },
			},
			{
				id: "edit-1",
				name: "edit",
				input: {
					path: "owner.txt",
					edits: [{ oldText: "prefix", newText: "changed" }],
				},
			},
			{
				id: "write-1",
				name: "write",
				input: { path: "nested/new.txt", content: "forbidden repeat" },
			},
			{
				id: "write-2",
				name: "write",
				input: { path: "nested/new.txt", content: "forbidden after revoke" },
			},
		],
		permit,
	);
	try {
		await writeFile(
			join(fixture.workspace, "owner.txt"),
			"prefix SYNTHETIC_OWNER_CANARY",
		);
		await fixture.start();
		await admitted.promise;
		expect(JSON.stringify(fixture.requests)).not.toContain(
			"SYNTHETIC_OWNER_CANARY",
		);
		await expect(
			readFile(join(fixture.workspace, "nested/new.txt")),
		).rejects.toMatchObject({ code: "ENOENT" });
		const intent = (await fixture.facts()).flatMap((event) =>
			event.type === "operation" && event.payload.kind === "tool"
				? [event.payload]
				: [],
		);
		expect(intent.map((fact) => fact.phase)).toEqual(["intent"]);
		waiting.resolve();
		await fixture.complete();
		expect(
			await readFile(join(fixture.workspace, "nested/new.txt"), "utf8"),
		).toBe("first write");
		expect(await readFile(join(fixture.workspace, "owner.txt"), "utf8")).toBe(
			"changed SYNTHETIC_OWNER_CANARY",
		);
		expect(JSON.stringify(fixture.requests)).toContain(
			"SYNTHETIC_OWNER_CANARY",
		);
		expect(permit).toHaveBeenCalledTimes(4);
		expect(
			new Set(permit.mock.calls.map(([action]) => action.attemptRef)).size,
		).toBe(4);
		const facts = (await fixture.facts()).flatMap((event) =>
			event.type === "operation" && event.payload.kind === "tool"
				? [event.payload]
				: [],
		);
		expect(facts.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"completed",
			"intent",
			"started",
			"completed",
			"intent",
			"started",
			"completed",
			"intent",
			"failed",
		]);
		for (const fact of facts.filter((fact) => fact.phase === "completed")) {
			expect(fact.startedAt).toEqual(expect.any(String));
			expect(fact.finishedAt).toEqual(expect.any(String));
			expect(fact.durationMs).toBeGreaterThanOrEqual(0);
		}
		const originalAction = permit.mock.calls[0]?.[0];
		if (!originalAction) throw new Error("Missing tool permit");
		await expect(
			fixture.driver.validateExternalAction(originalAction),
		).rejects.toThrow();
	} finally {
		waiting.resolve();
		await fixture.close();
	}
}, 30_000);

it.each(["write", "edit"])(
	"keeps the real Host final authorization after queued Driver reads before actual Pi %s",
	async (name) => {
		vi.setSystemTime(fixtureNow);
		const clock = { now: fixtureNow };
		let insideHostAuthorization = false;
		const authorizationResults: string[] = [];
		const fixture = await nativeToolsFixture(
			[
				{
					id: "queued-action",
					name,
					input: {
						path: "owner.txt",
						content: "forbidden write",
						edits: [{ oldText: "prefix", newText: "forbidden" }],
					},
				},
			],
			async (action) => {
				const host = fixture.host;
				if (!host) throw new Error("Missing real Host");
				insideHostAuthorization = true;
				try {
					await host.authorizeExternalAction(action);
					authorizationResults.push("allowed");
				} catch (error) {
					authorizationResults.push(
						error instanceof Error && "code" in error
							? String(error.code)
							: "unexpected",
					);
					throw error;
				} finally {
					insideHostAuthorization = false;
				}
			},
			clock,
		);
		const queued = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let injected = false;
		let pendingWrite: Promise<unknown> | undefined;
		const original = DurableJsonFile.prototype.readCommitted;
		const reads = vi
			.spyOn(DurableJsonFile.prototype, "readCommitted")
			.mockImplementation(async function (this: DurableJsonFile<unknown>) {
				const state = this.read() as {
					turns?: {
						events?: {
							type: string;
							payload: { kind?: string; phase?: string };
						}[];
					}[];
				};
				if (
					!injected &&
					!insideHostAuthorization &&
					state.turns?.some((turn) =>
						turn.events?.some(
							(event) =>
								event.type === "operation" &&
								event.payload.kind === "tool" &&
								event.payload.phase === "intent",
						),
					)
				) {
					injected = true;
					// The actual durable queue is blocked, not the authorization result.
					// This targets the shared Driver validation outside Host's own ordered checks.
					pendingWrite = this.update(async () => {
						queued.resolve();
						await release.promise;
					});
				}
				return original.call(this);
			});
		try {
			await writeFile(
				join(fixture.workspace, "owner.txt"),
				"prefix SYNTHETIC_OWNER_CANARY",
			);
			await fixture.start();
			await queued.promise;
			clock.now += 30_001;
			release.resolve();
			await fixture.complete("blocked");
			expect(fixture.requests).toHaveLength(1);
			expect(await readFile(join(fixture.workspace, "owner.txt"), "utf8")).toBe(
				"prefix SYNTHETIC_OWNER_CANARY",
			);
			expect(authorizationResults).toEqual(["RUNTIME_GRANT_INVALID"]);
			const facts = (await fixture.facts()).flatMap((event) =>
				event.type === "operation" ? [event.payload] : [],
			);
			const models = facts.filter((fact) => fact.kind === "model");
			const intents = models.filter((fact) => fact.phase === "intent");
			expect(intents).toHaveLength(2);
			expect(intents[1]?.operationRef).toBe(intents[0]?.operationRef);
			expect(intents[1]?.attemptRef).not.toBe(intents[0]?.attemptRef);
			expect(models.filter((fact) => fact.phase === "started")).toHaveLength(1);
			expect(models).toContainEqual(
				expect.objectContaining({
					attemptRef: intents[0]?.attemptRef,
					phase: "completed",
				}),
			);
			expect(
				models
					.filter((fact) => fact.attemptRef === intents[1]?.attemptRef)
					.every((fact) => fact.startedAt === undefined),
			).toBe(true);
			expect(
				facts.filter((fact) => fact.kind === "tool").map((fact) => fact.phase),
			).toEqual(["intent", "failed"]);
		} finally {
			release.resolve();
			await pendingWrite;
			reads.mockRestore();
			await fixture.close();
			vi.useRealTimers();
		}
	},
	30_000,
);

it.each(["read", "write", "edit"] as const)(
	"waits for durable completion before delivering the actual Pi %s result",
	async (name) => {
		const blocked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fixture = await nativeToolsFixture(
			[
				{
					id: "held-result",
					name,
					input: {
						path: "owner.txt",
						content: "changed",
						edits: [{ oldText: "prefix", newText: "changed" }],
					},
				},
			],
			async (action) => fixture.driver.validateExternalAction(action),
		);
		const original = DurableJsonFile.prototype.update;
		const writes = vi
			.spyOn(DurableJsonFile.prototype, "update")
			.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
				return original.call(this, async (draft) => {
					const result = await change(draft);
					const state = draft as { turns?: { events?: RuntimeEvent[] }[] };
					if (
						state.turns?.some((turn) =>
							turn.events?.some(
								(event) =>
									event.type === "operation" &&
									event.payload.kind === "tool" &&
									event.payload.phase === "completed",
							),
						)
					) {
						blocked.resolve();
						await release.promise;
					}
					return result;
				});
			});
		try {
			await writeFile(
				join(fixture.workspace, "owner.txt"),
				"prefix SYNTHETIC_OWNER_CANARY",
			);
			await fixture.start();
			await blocked.promise;
			expect(fixture.requests).toHaveLength(1);
			expect(await readFile(join(fixture.workspace, "owner.txt"), "utf8")).toBe(
				name === "read"
					? "prefix SYNTHETIC_OWNER_CANARY"
					: name === "write"
						? "changed"
						: "changed SYNTHETIC_OWNER_CANARY",
			);
			release.resolve();
			await fixture.complete();
			expect(fixture.requests).toHaveLength(2);
		} finally {
			release.resolve();
			writes.mockRestore();
			await fixture.close();
		}
	},
	30_000,
);

it.each(
	(["read", "write", "edit"] as const).flatMap((name) =>
		(["before commit", "after commit"] as const).map(
			(failure) => [name, failure] as const,
		),
	),
)(
	"does not repeat actual Pi %s after a result acknowledgement fails %s",
	async (name, failure) => {
		const fixture = await nativeToolsFixture(
			[
				{
					id: "unconfirmed-result",
					name,
					input: {
						path: "owner.txt",
						content: "changed",
						edits: [{ oldText: "prefix", newText: "changed" }],
					},
				},
				{
					id: "must-not-execute",
					name: "write",
					input: { path: "owner.txt", content: "forbidden replay" },
				},
			],
			async (action) => fixture.driver.validateExternalAction(action),
		);
		let injected = false;
		const original = DurableJsonFile.prototype.update;
		const writes = vi
			.spyOn(DurableJsonFile.prototype, "update")
			.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
				let inject = false;
				const operation = original.call(this, async (draft) => {
					const result = await change(draft);
					const state = draft as { turns?: { events?: RuntimeEvent[] }[] };
					if (
						!injected &&
						state.turns?.some((turn) =>
							turn.events?.some(
								(event) =>
									event.type === "operation" &&
									event.payload.kind === "tool" &&
									event.payload.phase === "completed",
							),
						)
					) {
						injected = inject = true;
						if (failure === "before commit")
							throw new Error("SYNTHETIC_TOOL_RESULT_COMMIT_FAILURE");
					}
					return result;
				});
				return operation.then((result) => {
					if (inject) throw new Error("SYNTHETIC_TOOL_RESULT_ACK_LOST");
					return result;
				});
			});
		try {
			await writeFile(
				join(fixture.workspace, "owner.txt"),
				"prefix SYNTHETIC_OWNER_CANARY",
			);
			await fixture.start();
			await fixture.complete("blocked");
			expect(injected).toBe(true);
			expect(fixture.requests).toHaveLength(1);
			const facts = (await fixture.facts()).flatMap((event) =>
				event.type === "operation" && event.payload.kind === "tool"
					? [event.payload]
					: [],
			);
			expect(facts.map((fact) => fact.phase)).toEqual([
				"intent",
				"started",
				failure === "before commit" ? "unknown" : "completed",
			]);
			expect(new Set(facts.map((fact) => fact.attemptRef)).size).toBe(1);
			expect(facts.at(-1)?.startedAt).toEqual(expect.any(String));
			writes.mockRestore();
			const recovered = await fixture.reopen();
			expect(recovered.nativeSessionRef).toBe(fixture.record.nativeSessionRef);
			expect(
				(await fixture.facts()).flatMap((event) =>
					event.type === "operation" && event.payload.kind === "tool"
						? [event.payload]
						: [],
				),
			).toEqual(facts);
			expect(fixture.requests).toHaveLength(1);
			expect(await readFile(join(fixture.workspace, "owner.txt"), "utf8")).toBe(
				name === "read"
					? "prefix SYNTHETIC_OWNER_CANARY"
					: name === "write"
						? "changed"
						: "changed SYNTHETIC_OWNER_CANARY",
			);
		} finally {
			writes.mockRestore();
			await fixture.close();
		}
	},
	30_000,
);

it.each(["read", "write", "edit"])(
	"blocks actual pinned Pi %s when current authorization denies",
	async (name) => {
		const permit = vi.fn(async () => {
			throw new Error("SYNTHETIC_AUTHORIZATION_DENIED");
		});
		const fixture = await nativeToolsFixture(
			[
				{
					id: "denied-1",
					name,
					input: {
						path: "owner.txt",
						content: "forbidden write",
						edits: [{ oldText: "prefix", newText: "forbidden" }],
					},
				},
			],
			permit,
		);
		try {
			await writeFile(
				join(fixture.workspace, "owner.txt"),
				"prefix SYNTHETIC_OWNER_CANARY",
			);
			await fixture.start();
			await fixture.complete();
			expect(await readFile(join(fixture.workspace, "owner.txt"), "utf8")).toBe(
				"prefix SYNTHETIC_OWNER_CANARY",
			);
			expect(JSON.stringify(fixture.requests)).not.toContain(
				"SYNTHETIC_OWNER_CANARY",
			);
			expect(permit).toHaveBeenCalledOnce();
			const facts = (await fixture.facts()).flatMap((event) =>
				event.type === "operation" && event.payload.kind === "tool"
					? [event.payload]
					: [],
			);
			expect(facts.map((fact) => fact.phase)).toEqual(["intent", "failed"]);
			for (const fact of facts) expect(fact).not.toHaveProperty("startedAt");
		} finally {
			await fixture.close();
		}
	},
	30_000,
);

it("fails closed for a pinned Pi tool with no business authorization callback", async () => {
	const fixture = await nativeToolsFixture([
		{
			id: "unguarded",
			name: "write",
			input: { path: "missing/new.txt", content: "forbidden" },
		},
	]);
	try {
		await fixture.start();
		await fixture.complete();
		await expect(
			readFile(join(fixture.workspace, "missing/new.txt")),
		).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await fixture.close();
	}
}, 30_000);

it.each(["read", "write", "edit"])(
	"blocks actual pinned Pi %s when durable tool intent cannot commit",
	async (name) => {
		const permit = vi.fn(async () => {});
		const fixture = await nativeToolsFixture(
			[
				{
					id: "failed-intent",
					name,
					input: {
						path: "owner.txt",
						content: "forbidden write",
						edits: [{ oldText: "prefix", newText: "forbidden" }],
					},
				},
			],
			permit,
		);
		const original = DurableJsonFile.prototype.update;
		const writes = vi
			.spyOn(DurableJsonFile.prototype, "update")
			.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
				return original.call(this, async (draft) => {
					const result = await change(draft);
					const state = draft as {
						turns?: {
							events?: { type: string; payload: { kind?: string } }[];
						}[];
					};
					if (
						state.turns?.some((turn) =>
							turn.events?.some(
								(event) =>
									event.type === "operation" && event.payload.kind === "tool",
							),
						)
					)
						throw new Error("SYNTHETIC_TOOL_INTENT_COMMIT_FAILURE");
					return result;
				});
			});
		try {
			await writeFile(
				join(fixture.workspace, "owner.txt"),
				"prefix SYNTHETIC_OWNER_CANARY",
			);
			await fixture.start();
			await fixture.complete();
			expect(await readFile(join(fixture.workspace, "owner.txt"), "utf8")).toBe(
				"prefix SYNTHETIC_OWNER_CANARY",
			);
			expect(JSON.stringify(fixture.requests)).not.toContain(
				"SYNTHETIC_OWNER_CANARY",
			);
			expect(permit).not.toHaveBeenCalled();
		} finally {
			writes.mockRestore();
			await fixture.close();
		}
	},
	30_000,
);

it("excludes a delayed durable start acknowledgement from actual pinned Pi tool timing", async () => {
	const blocked = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const fixture = await nativeToolsFixture(
		[
			{
				id: "delayed-start",
				name: "write",
				input: { path: "owner.txt", content: "changed" },
			},
		],
		async (action) => fixture.driver.validateExternalAction(action),
	);
	const original = DurableJsonFile.prototype.update;
	let injected = false;
	const writes = vi
		.spyOn(DurableJsonFile.prototype, "update")
		.mockImplementation(function (this: DurableJsonFile<unknown>, change) {
			let hold = false;
			return original
				.call(this, async (draft) => {
					const result = await change(draft);
					const state = draft as { turns?: { events?: RuntimeEvent[] }[] };
					if (
						!injected &&
						state.turns?.some((turn) =>
							turn.events?.some(
								(event) =>
									event.type === "operation" &&
									event.payload.kind === "tool" &&
									event.payload.phase === "started",
							),
						)
					)
						injected = hold = true;
					return result;
				})
				.then(async (result) => {
					if (hold) {
						blocked.resolve();
						await release.promise;
					}
					return result;
				});
		});
	try {
		await fixture.start();
		await blocked.promise;
		await vi.waitFor(async () =>
			expect(await readFile(join(fixture.workspace, "owner.txt"), "utf8")).toBe(
				"changed",
			),
		);
		await new Promise<void>((done) => setTimeout(done, 100));
		expect(fixture.requests).toHaveLength(1);
		const acknowledgedAt = Date.now();
		release.resolve();
		await fixture.complete();
		const facts = (await fixture.facts()).flatMap((event) =>
			event.type === "operation" && event.payload.kind === "tool"
				? [event.payload]
				: [],
		);
		expect(facts.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"completed",
		]);
		const result = facts.at(-1);
		expect(Date.parse(result?.finishedAt ?? "")).toBeLessThan(acknowledgedAt);
		expect(result?.durationMs).toBeLessThan(
			acknowledgedAt - Date.parse(result?.startedAt ?? ""),
		);
	} finally {
		release.resolve();
		writes.mockRestore();
		await fixture.close();
	}
}, 30_000);
