import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	maximumRuntimeEventReplayPageBytesV4,
	type RuntimeBusinessGrantClaimsV4,
	RuntimeBusinessGrantClaimsV4Schema,
	type RuntimeBusinessRequestV4,
	RuntimeEventAckRequestV4Schema,
	RuntimeEventReadRequestV4Schema,
	RuntimeExecutionGrantClaimsV2Schema,
	RuntimeNativeCapabilityRequestV4Schema,
	type RuntimeNativeCapabilityRequestV5,
	RuntimeNativeCapabilityTransportV5Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV4Schema,
	type RuntimeRestoreExecutionKeyRequestV4,
	RuntimeRestoreExecutionKeyRequestV4Schema,
	RuntimeSubmitTurnRequestV4Schema,
	runtimeEventRequestDigestV4,
	runtimeRequestDigestV5,
	runtimeRequestSigningPayloadV4,
	runtimeRestoreExecutionKeyRequestDigestV4,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import type {
	RuntimeBrowserExecutionContextV1,
	RuntimeDriver,
	RuntimeExternalActionAuthorization,
} from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import {
	FakeRuntimeDriver,
	fakeNativeCommandCapabilityId,
	fakeNativeCommandDirectoryRevision,
} from "./fake-runtime-driver.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import { createRuntimeExecutionGrantVerifierV2 } from "./grant-v2.js";
import {
	signV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
import {
	createRuntimeExecutionGrantValidatorV4,
	createRuntimeExecutionKeyRecoveryValidatorV4,
} from "./grant-v4.js";
import type { RuntimeFileBridgePortV1 } from "./runtime-file-bridge.js";
import {
	type RuntimeBrowserExecutionContextFactoryInputV1,
	RuntimeHost,
} from "./runtime-host.js";

// These exercise the real Host/Store and signature validators with a controlled
// Driver. They do not attest PostgreSQL, HTTP assembly or official native ACs.
const keys = generateKeyPairSync("ed25519");
const publicKeys = new Map([["fixture", keys.publicKey]]);
const verifyV2 = createRuntimeExecutionGrantVerifierV2(publicKeys);
const now = 1_800_000_000_000;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function token(claims: unknown) {
	const header = Buffer.from(
		JSON.stringify({
			alg: "EdDSA",
			kid: "fixture",
			typ: "runtime-execution+jws",
		}),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url")}`;
}

function submission() {
	return RuntimeSubmitTurnRequestV4Schema.parse({
		schemaVersion: 4,
		requestId: "request-1",
		traceId: "trace-1",
		principal: { kind: "user", id: "alice" },
		executionSource: "web",
		channelId: "web",
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		turnId: "turn-1",
		sessionGeneration: 1,
		hostSessionRef: null,
		operation: {
			kind: "execution",
			id: "execution-1",
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
		keyBinding: {
			purpose: "personal",
			subjectId: "alice",
			ciphertextRef: "key-1",
			version: 1,
		},
		input: { text: "synthetic input", attachments: [] },
		selection: {
			schemaVersion: 1,
			modelOptionId: "model-option-primary",
			reasoningLevel: "high",
		},
	});
}

function businessClaims(
	request: RuntimeBusinessRequestV4,
	clock = now,
): RuntimeBusinessGrantClaimsV4 {
	return RuntimeBusinessGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer: "platform-fixture",
		audience: "runtime_host",
		workerId: "worker-fixture",
		issuedAt: clock,
		expiresAt: clock + 30_000,
		grantId: request.requestId,
		principal: request.principal,
		executionSource: request.executionSource,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
		hostSessionRef: request.hostSessionRef,
		operation: request.operation,
		relayKeyBinding: request.keyBinding,
		requestDigest: createHash("sha256")
			.update(runtimeRequestSigningPayloadV4(request))
			.digest("hex"),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: [
			"selection" in request
				? "turn.submit"
				: "capabilityId" in request
					? "native-capability.invoke"
					: "turn.supplement",
		],
		attachments: [],
	});
}

function delivery<T extends RuntimeBusinessRequestV4>(request: T) {
	const claims = businessClaims(request);
	return {
		businessRequest: {
			...request,
			grant: { ...request.grant, token: token(claims) },
		},
		privateKeyField: {
			schemaVersion: 1 as const,
			context: {
				requestId: request.requestId,
				grantId: claims.grantId,
				requestDigest: claims.requestDigest,
				traceId: request.traceId,
				principal: request.principal,
				executionSource: request.executionSource,
				channelId: request.channelId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				hostSessionRef: request.hostSessionRef,
				operation: request.operation,
				keyBinding: request.keyBinding,
			},
			keyDelivery: { relayKey: "synthetic-pinned-key-k1" },
		},
	};
}

async function setup(
	fileBridge?: RuntimeFileBridgePortV1,
	createBrowserExecutionContext?: (
		input: RuntimeBrowserExecutionContextFactoryInputV1,
	) => RuntimeBrowserExecutionContextV1 | undefined,
	validateRecoveryGrantV4?: (request: unknown) => Promise<{
		request: RuntimeRestoreExecutionKeyRequestV4;
		claims: import("@agent-infra/contracts/runtime").RuntimeRestoreExecutionKeyGrantClaimsV4;
	}>,
	validateGrantV5?: import("./runtime-host.js").RuntimeHostOptions["validateGrantV5"],
	validateRecoveryGrantV5?: import("./runtime-host.js").RuntimeHostOptions["validateRecoveryGrantV5"],
) {
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-v4-consumer-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "host.json");
	const store = await FileRuntimeStore.open(path);
	cleanups.push(() => store.close());
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	let clock = now;
	const options = {
		store,
		driver,
		grantValidation: { expectedIssuer: "platform-fixture" },
		grantValidationV2: {
			expectedIssuer: "platform-fixture",
			expectedWorkerId: "worker-fixture",
			now: () => clock,
		},
		allowLegacyBusiness: false,
		validateGrantV4: createRuntimeExecutionGrantValidatorV4(publicKeys, {
			expectedIssuer: "platform-fixture",
			expectedWorkerId: "worker-fixture",
			now: () => clock,
		}),
		...(fileBridge ? { fileBridge: () => fileBridge } : {}),
		...(createBrowserExecutionContext ? { createBrowserExecutionContext } : {}),
		...(validateRecoveryGrantV4 ? { validateRecoveryGrantV4 } : {}),
		...(validateGrantV5 ? { validateGrantV5 } : {}),
		...(validateRecoveryGrantV5 ? { validateRecoveryGrantV5 } : {}),
	};
	let host = await RuntimeHost.open(options);
	cleanups.push(() => host.close());
	const transport = delivery(submission());
	return {
		host,
		store,
		driver,
		path,
		transport,
		expire: () => {
			clock = now + 30_000;
		},
		reopen: async () => {
			await host.close();
			host = await RuntimeHost.open(options);
			return host;
		},
	};
}

function action(ref: string): RuntimeExternalActionAuthorization {
	return {
		nativeSessionRef: ref,
		executionId: "execution-1",
		runtimeOperationId: "execution-1",
		operationRef: "model-operation-1",
		attemptRef: "attempt-1",
		kind: "model",
	};
}
function retainedKeys(host: RuntimeHost) {
	return (host as unknown as { executionKeys: ReadonlyMap<string, unknown> })
		.executionKeys;
}

async function event(
	request: RuntimeBusinessRequestV4,
	hostSessionRef: string,
	cursor?: string,
	afterCursor: string | null = null,
) {
	const base = {
		schemaVersion: request.schemaVersion,
		traceId: request.traceId,
		principal: request.principal,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		operation: request.operation,
		executionSource: request.executionSource,
		keyBinding: request.keyBinding,
	};
	const value = {
		...base,
		requestId: cursor ? "ack-1" : "read-1",
		hostSessionRef,
		grant: {
			schemaVersion: 2 as const,
			format: "runtime-execution-jws" as const,
			token: "a.b.c",
		},
		consumer: "platform_worker_persistence" as const,
		...(cursor ? { confirmedCursor: cursor } : { afterCursor }),
	};
	const parsed = cursor
		? RuntimeEventAckRequestV4Schema.parse(value)
		: RuntimeEventReadRequestV4Schema.parse(value);
	const eventAccess =
		"afterCursor" in parsed
			? {
					command: "events.persist",
					consumer: parsed.consumer,
					afterCursor: parsed.afterCursor,
				}
			: {
					command: "events.ack",
					consumer: parsed.consumer,
					confirmedCursor: parsed.confirmedCursor,
				};
	const claims = RuntimeExecutionGrantClaimsV2Schema.parse({
		schemaVersion: 2,
		issuer: "platform-fixture",
		audience: "runtime_host",
		workerId: "worker-fixture",
		issuedAt: now,
		expiresAt: now + 30_000,
		grantId: parsed.requestId,
		principal: parsed.principal,
		channelId: parsed.channelId,
		agentId: parsed.agentId,
		conversationId: parsed.conversationId,
		executionId: parsed.executionId,
		turnId: parsed.turnId,
		sessionGeneration: parsed.sessionGeneration,
		traceId: parsed.traceId,
		hostSessionRef,
		operation: parsed.operation,
		requestDigest: await runtimeEventRequestDigestV4(parsed),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: [eventAccess.command],
		attachments: [],
		eventAccess,
	});
	return {
		request: { ...parsed, grant: { ...parsed.grant, token: token(claims) } },
		verification: verifyV2({ ...parsed.grant, token: token(claims) }),
	};
}

it.each(["current", "expiry", "close"] as const)(
	"returns a keyless tool guard without a Connection consumer: %s",
	async (change) => {
		const f = await setup();
		const accepted = await f.host.submitTurnV4(f.transport);
		const native = f.store.nativeSessionRef(accepted.hostSessionRef);
		if (!native) throw new Error("Missing original native Session");
		const authorized = await f.host.authorizeExternalAction({
			...action(native),
			kind: "tool",
		});
		expect(authorized).toEqual({ revalidate: expect.any(Function) });
		if (!authorized?.revalidate) throw new Error("Missing Host tool guard");
		expect(authorized.relayKey).toBeUndefined();
		expect(authorized.revalidate()).toBeUndefined();
		if (change === "expiry") f.expire();
		else if (change === "close") await f.host.close();
		if (change !== "current")
			expect(authorized.revalidate).toThrowError(
				expect.objectContaining({ code: "RUNTIME_GRANT_INVALID" }),
			);
	},
);

it("binds the first durable native receipt and returns the original Key before submit resolves", async () => {
	const f = await setup();
	const execute = f.driver.execute.bind(f.driver);
	vi.spyOn(f.driver, "execute").mockImplementation(async (command) => {
		const receipt = await execute(command);
		if (command.kind === "submit-turn") {
			const key = await f.host.authorizeExternalAction(
				action(receipt.nativeSessionRef),
			);
			expect(key?.relayKey).toBe("synthetic-pinned-key-k1");
			expect(key?.revalidate()).toBeUndefined();
			expect(
				f.store.nativeSessionRef(
					f.store.readOriginalExecutionKeyScopeV4(f.transport.businessRequest)
						?.hostSessionRef ?? "",
				),
			).toBe(receipt.nativeSessionRef);
			await expect(
				f.host.authorizeExternalAction(action("foreign-native-ref")),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		}
		return receipt;
	});
	const accepted = await f.host.submitTurnV4(f.transport);
	expect(accepted.result).toEqual({ outcome: "accepted", status: "running" });
	expect(await f.driver.sideEffectCount()).toBe(1);
	expect(await readFile(f.path, "utf8")).not.toContain(
		"synthetic-pinned-key-k1",
	);
});

// #3017：受理不明阻塞会话的拒绝经 V4 持久化；同请求重放（含 Host 重启后）
// 直接返回持久结果，不再调用 Driver 执行。
it("persists a session blocked V4 rejection and replays it without Driver execution", async () => {
	const f = await setup();
	const blocked = {
		outcome: "rejected",
		code: "RUNTIME_SESSION_BLOCKED",
		message: "Runtime session is blocked by an unconfirmed turn",
		retryable: false,
	} as const;
	const execute = vi.spyOn(f.driver, "execute").mockImplementation(
		async (command) =>
			({
				schemaVersion: command.schemaVersion,
				agentId: command.agentId,
				conversationId: command.conversationId,
				sessionGeneration: command.sessionGeneration,
				kind: command.kind,
				operationId: command.operationId,
				nativeSessionRef: "native-session-blocked",
				result: blocked,
			}) as Awaited<ReturnType<RuntimeDriver["execute"]>>,
	);

	const rejected = await f.host.submitTurnV4(f.transport);
	expect(rejected).toEqual({
		schemaVersion: 4,
		hostSessionRef: expect.any(String),
		operationId: "execution-1",
		result: blocked,
	});
	const persisted = JSON.parse(await readFile(f.path, "utf8")) as {
		sessions: Record<
			string,
			{ operations: Record<string, { state: string; result?: unknown }> }
		>;
	};
	expect(
		persisted.sessions[rejected.hostSessionRef]?.operations["execution-1"],
	).toMatchObject({ state: "resolved", result: blocked });
	expect(await f.host.submitTurnV4(f.transport)).toEqual(rejected);
	const reopened = await f.reopen();
	expect(await reopened.submitTurnV4(f.transport)).toEqual(rejected);
	expect(execute).toHaveBeenCalledTimes(1);
	expect(await f.driver.sideEffectCount()).toBe(0);
});

it("executes an admitted V4 native command through the Driver seam without text", async () => {
	const f = await setup();
	const submitted = await f.host.submitTurnV4(f.transport);
	await f.driver.setOperationStatus("execution-1", "completed");
	const { input: _input, selection: _selection, ...context } = submission();
	const request = RuntimeNativeCapabilityRequestV4Schema.parse({
		...context,
		hostSessionRef: submitted.hostSessionRef,
		executionId: "execution-command",
		turnId: "turn-command",
		operation: {
			kind: "execution",
			id: "execution-command",
			deliveryFence: 2,
			executionDeliveryFence: 2,
		},
		capabilityId: fakeNativeCommandCapabilityId,
		capabilityKind: "command",
		directoryRevision: fakeNativeCommandDirectoryRevision,
		parameters: "",
		parametersDigest: createHash("sha256").update("").digest("hex"),
		capabilitySourceVersion: "1",
	});
	const result = await f.host.nativeCapabilityV4(delivery(request));
	expect(result.result).toEqual({ outcome: "accepted", status: "completed" });
	expect(await f.driver.sideEffectCount()).toBe(2);
	const read = await event(request, result.hostSessionRef);
	const replay = await f.host.readEventsV4(
		RuntimeEventReadRequestV4Schema.parse(read.request),
		read.verification,
	);
	expect(replay.events.length).toBeGreaterThan(0);
	const cursor = replay.events.at(-1)?.cursor;
	if (!cursor) throw new Error("Expected native command terminal event");
	const ack = await event(request, result.hostSessionRef, cursor);
	const active = await f.reopen();
	await expect(
		active.acknowledgeEventsV4(
			RuntimeEventAckRequestV4Schema.parse(ack.request),
			ack.verification,
		),
	).resolves.toMatchObject({ confirmedCursor: cursor });
	expect(await f.driver.sideEffectCount()).toBe(2);
	const beforeDeniedAck = await readFile(f.path, "utf8");
	const foreign = await event(request, result.hostSessionRef, "fake-cursor-1");
	await expect(
		active.acknowledgeEventsV4(
			RuntimeEventAckRequestV4Schema.parse(foreign.request),
			foreign.verification,
		),
	).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
	expect(await readFile(f.path, "utf8")).toBe(beforeDeniedAck);
	const foreignRequests: RuntimeBusinessRequestV4[] = [
		{ ...request, agentId: "foreign-agent" },
		{
			...request,
			principal: { kind: "user", id: "foreign-user" },
			keyBinding: {
				...request.keyBinding,
				subjectId: "foreign-user",
				ciphertextRef: "foreign-key",
			},
		},
	];
	for (const foreignRequest of foreignRequests) {
		const read = await event(foreignRequest, result.hostSessionRef);
		await expect(
			active.readEventsV4(
				RuntimeEventReadRequestV4Schema.parse(read.request),
				read.verification,
			),
		).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		expect(await readFile(f.path, "utf8")).toBe(beforeDeniedAck);
	}
	const bytes = await readFile(f.path, "utf8");
	f.expire();
	await expect(
		active.resolveNativeMetadataSessionRef(
			{
				schemaVersion: 1,
				principal: request.principal,
				channelId: request.channelId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				sessionGeneration: request.sessionGeneration,
				authorizationRevision: "metadata-authorization",
			},
			result.hostSessionRef,
		),
	).resolves.toBe(f.store.nativeSessionRef(result.hostSessionRef));
	expect(await readFile(f.path, "utf8")).toBe(bytes);
	expect(await f.driver.sideEffectCount()).toBe(2);
});

it("passes the request-scoped file bridge only through the Driver execution context", async () => {
	const fileBridge = {
		readInput: vi.fn(),
		writeResult: vi.fn(),
	} as unknown as RuntimeFileBridgePortV1;
	const f = await setup(fileBridge);
	const execute = f.driver.execute.bind(f.driver);
	const contexts: unknown[] = [];
	vi.spyOn(f.driver, "execute").mockImplementation(async (command, context) => {
		contexts.push(context);
		return execute(command, context);
	});
	await f.host.submitTurnV4(f.transport);
	const context = contexts[0] as { fileBridge?: RuntimeFileBridgePortV1 };
	// The Host hands the Driver its own boundary-checking view of the deployment
	// port instead of the bare factory object.
	expect(context.fileBridge).toMatchObject({
		readInput: expect.any(Function),
		writeResult: expect.any(Function),
		revalidate: expect.any(Function),
	});
	expect(context.fileBridge).not.toBe(fileBridge);
	await context.fileBridge?.readInput("input-1");
	expect(fileBridge.readInput).toHaveBeenCalledWith("input-1", undefined);
	expect(JSON.stringify(await readFile(f.path, "utf8"))).not.toContain(
		"fileBridge",
	);
});

it("injects the deployment-owned Browser controller only after Host binding admission", async () => {
	const factoryCalls: RuntimeBrowserExecutionContextFactoryInputV1[] = [];
	const f = await setup(undefined, (input) => {
		factoryCalls.push(input);
		return {
			...input,
			executeTool: async (request) => ({
				actionId: request.actionId,
				operationRef: request.operationRef,
				attemptRef: request.attemptRef,
				binding: request.binding,
				phase: "completed" as const,
				contentItems: [],
				success: true,
			}),
		};
	});
	const browser = {
		capabilityVersion: 3,
		principal: { kind: "user" as const, id: "alice" },
		binding: {
			agentId: "agent-1",
			conversationId: "conversation-1",
			sessionGeneration: 1,
			resourceFence: 1,
			workloadRevision: 4,
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
	} satisfies RuntimeBrowserExecutionContextV1;
	(
		f.host as unknown as {
			browserExecutionContext?: RuntimeBrowserExecutionContextV1;
		}
	).browserExecutionContext = browser;
	const execute = f.driver.execute.bind(f.driver);
	const contexts: RuntimeBrowserExecutionContextV1[] = [];
	vi.spyOn(f.driver, "execute").mockImplementation(async (command, context) => {
		if (context?.browser) contexts.push(context.browser);
		return execute(command, context);
	});
	await f.host.submitTurnV4(f.transport);
	expect(factoryCalls).toHaveLength(1);
	expect(factoryCalls[0]).toMatchObject({
		binding: browser.binding,
		capabilityVersion: 3,
		executionId: "execution-1",
		pageRevision: 1,
		principal: { kind: "user", id: "alice" },
	});
	expect(contexts).toHaveLength(1);
	expect(contexts[0]?.executeTool).toEqual(expect.any(Function));
	expect(Object.isFrozen(contexts[0])).toBe(true);
	expect(Object.isFrozen(contexts[0]?.binding)).toBe(true);
	expect(Object.isFrozen(contexts[0]?.principal)).toBe(true);
	// The factory input is a runtime snapshot too, and the admitted context
	// cannot swap its principal after validation.
	expect(Object.isFrozen(factoryCalls[0]?.principal)).toBe(true);
	expect(() => {
		(
			contexts[0] as {
				principal?: RuntimeBrowserExecutionContextV1["principal"];
			}
		).principal = { kind: "user", id: "mallory" };
	}).toThrow(TypeError);
	expect(contexts[0]?.principal).toMatchObject({ id: "alice" });
});

it("strips a preconfigured principal when no Browser factory is installed", async () => {
	const f = await setup();
	(
		f.host as unknown as {
			browserExecutionContext?: RuntimeBrowserExecutionContextV1;
		}
	).browserExecutionContext = {
		capabilityVersion: 3,
		principal: { kind: "user", id: "stale-principal" },
		binding: {
			agentId: "agent-1",
			conversationId: "conversation-1",
			sessionGeneration: 1,
			resourceFence: 1,
			workloadRevision: 4,
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
	};
	const execute = f.driver.execute.bind(f.driver);
	const contexts: RuntimeBrowserExecutionContextV1[] = [];
	vi.spyOn(f.driver, "execute").mockImplementation(async (command, context) => {
		if (context?.browser) contexts.push(context.browser);
		return execute(command, context);
	});
	await f.host.submitTurnV4(f.transport);
	expect(contexts).toHaveLength(1);
	expect(contexts[0]?.principal).toBeUndefined();
});

it("withholds an unadmitted Browser principal from the factory for a control operation", async () => {
	const factoryCalls: RuntimeBrowserExecutionContextFactoryInputV1[] = [];
	const f = await setup(undefined, (input) => {
		factoryCalls.push(input);
		return input;
	});
	(
		f.host as unknown as {
			browserExecutionContext?: RuntimeBrowserExecutionContextV1;
		}
	).browserExecutionContext = {
		capabilityVersion: 3,
		principal: { kind: "user", id: "stale-principal" },
		binding: {
			agentId: "agent-1",
			conversationId: "conversation-1",
			sessionGeneration: 1,
			resourceFence: 1,
			workloadRevision: 4,
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
	};
	const accepted = await f.host.submitTurnV4(f.transport);
	expect(factoryCalls[0]?.principal).toMatchObject({ id: "alice" });
	// A control operation owns no pinned execution authority, so the readiness
	// snapshot's preconfigured principal must never reach the factory.
	factoryCalls.length = 0;
	const {
		input: _input,
		selection: _selection,
		executionSource: _source,
		keyBinding: _binding,
		grant: _grant,
		...base
	} = submission();
	const stop = signV3Fixture(
		{
			...base,
			schemaVersion: 3,
			requestId: "stop-1",
			hostSessionRef: accepted.hostSessionRef,
			operation: {
				kind: "stop",
				id: "stop-1",
				deliveryFence: 1,
				executionDeliveryFence: 1,
			},
		},
		"turn.stop",
		{ now, purpose: "control", reason: "stop" },
	);
	await f.host.stopV3(stop, verifyRuntimeV2Fixture(stop.grant));
	expect(factoryCalls.length).toBeGreaterThan(0);
	expect(factoryCalls.every((call) => call.principal === undefined)).toBe(true);
});

it("drops a Browser controller factory result whose binding drifts", async () => {
	const f = await setup(undefined, (input) => ({
		...input,
		binding: {
			...input.binding,
			resourceFence: input.binding.resourceFence + 1,
		},
	}));
	const browser = {
		capabilityVersion: 3,
		binding: {
			agentId: "agent-1",
			conversationId: "conversation-1",
			sessionGeneration: 1,
			resourceFence: 1,
			workloadRevision: 4,
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
	} satisfies RuntimeBrowserExecutionContextV1;
	(
		f.host as unknown as {
			browserExecutionContext?: RuntimeBrowserExecutionContextV1;
		}
	).browserExecutionContext = browser;
	const execute = f.driver.execute.bind(f.driver);
	const contexts: unknown[] = [];
	vi.spyOn(f.driver, "execute").mockImplementation(async (command, context) => {
		contexts.push(context?.browser);
		return execute(command, context);
	});
	await f.host.submitTurnV4(f.transport);
	expect(contexts).toEqual([undefined]);
});

it("isolates the admitted Browser binding from an in-place factory mutation", async () => {
	let observed: RuntimeBrowserExecutionContextV1 | undefined;
	const f = await setup(undefined, (input) => {
		observed = input;
		(input.binding as { resourceFence: number }).resourceFence += 1;
		return input;
	});
	const browser = {
		capabilityVersion: 3,
		binding: {
			agentId: "agent-1",
			conversationId: "conversation-1",
			sessionGeneration: 1,
			resourceFence: 1,
			workloadRevision: 4,
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
	} satisfies RuntimeBrowserExecutionContextV1;
	(
		f.host as unknown as {
			browserExecutionContext?: RuntimeBrowserExecutionContextV1;
		}
	).browserExecutionContext = browser;
	const execute = f.driver.execute.bind(f.driver);
	const contexts: unknown[] = [];
	vi.spyOn(f.driver, "execute").mockImplementation(async (command, context) => {
		contexts.push(context?.browser);
		return execute(command, context);
	});
	await f.host.submitTurnV4(f.transport);
	expect(observed?.binding.resourceFence).toBe(2);
	expect(browser.binding.resourceFence).toBe(1);
	expect(contexts).toEqual([undefined]);
});

it("does not invoke the Browser controller factory for a foreign readiness binding", async () => {
	let calls = 0;
	const f = await setup(undefined, (input) => {
		calls += 1;
		return input;
	});
	(
		f.host as unknown as {
			browserExecutionContext?: RuntimeBrowserExecutionContextV1;
		}
	).browserExecutionContext = {
		capabilityVersion: 3,
		binding: {
			agentId: "agent-1",
			conversationId: "foreign-conversation",
			sessionGeneration: 1,
			resourceFence: 1,
			workloadRevision: 4,
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
	};
	await f.host.submitTurnV4(f.transport);
	expect(calls).toBe(0);
});

it("re-checks current execution authority at the native submission boundary", async () => {
	const fileBridge = {
		readInput: vi.fn(),
		writeResult: vi.fn(),
		revalidate: vi.fn(),
	} as unknown as RuntimeFileBridgePortV1;
	const f = await setup(fileBridge);
	const execute = f.driver.execute.bind(f.driver);
	vi.spyOn(f.driver, "execute").mockImplementation(async (command, context) => {
		// The Driver revalidates before its native submission boundary.
		context?.fileBridge?.revalidate();
		return execute(command, context);
	});

	await f.host.submitTurnV4(f.transport);
	expect(fileBridge.revalidate).toHaveBeenCalledTimes(1);
});

it("refuses the deployment bridge once its execution authority lapses", async () => {
	const fileBridge = {
		readInput: vi.fn(),
		writeResult: vi.fn(),
		revalidate: vi.fn(),
	} as unknown as RuntimeFileBridgePortV1;
	const f = await setup(fileBridge);
	const execute = f.driver.execute.bind(f.driver);
	const denials: unknown[] = [];
	vi.spyOn(f.driver, "execute").mockImplementation(async (command, context) => {
		f.expire();
		try {
			context?.fileBridge?.revalidate();
		} catch (error) {
			denials.push(error);
		}
		return execute(command, context);
	});

	await f.host.submitTurnV4(f.transport);
	expect(denials).toHaveLength(1);
	// A lapsed authority never reaches the deployment port.
	expect(fileBridge.revalidate).not.toHaveBeenCalled();
});

it("decides bridge expiry on the injected grant clock instead of the wall clock", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "runtime-host-v4-bridge-clock-"),
	);
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	cleanups.push(() => store.close());
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	// A deployment clock decades away from the wall clock.
	let clock = 1_000_000;
	const request = submission();
	const accepted = { request, claims: businessClaims(request, clock) };
	const fileBridge = {
		readInput: vi.fn(),
		writeResult: vi.fn(),
		revalidate: vi.fn(),
	} as unknown as RuntimeFileBridgePortV1;
	const host = await RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: "platform-fixture" },
		grantValidationV2: {
			expectedIssuer: "platform-fixture",
			expectedWorkerId: "worker-fixture",
			now: () => clock,
		},
		validateGrantV4: async () => accepted,
		fileBridge: () => fileBridge,
	});
	cleanups.push(() => host.close());

	// The grant is live on the deployment clock even though the wall clock is far
	// beyond its expiry.
	await expect(host.getFileBridge(request)).resolves.toMatchObject({
		readInput: expect.any(Function),
		writeResult: expect.any(Function),
		revalidate: expect.any(Function),
	});
	clock += 60_000;
	await expect(host.getFileBridge(request)).rejects.toThrow(
		"RUNTIME_FILE_BRIDGE_BINDING_INVALID",
	);
});

it("records result metadata only after the bridge confirms the write", async () => {
	const fileBridge = {
		readInput: vi.fn(),
		writeResult: vi.fn().mockResolvedValue({
			schemaVersion: 1,
			fileId: "result-1",
			kind: "result",
			descriptor: {
				name: "answer.txt",
				mediaType: "text/plain",
				sizeBytes: 0,
				sha256: "a".repeat(64),
			},
			status: "available",
			createdAt: "2026-08-28T10:00:00Z",
			expiresAt: "2026-08-28T11:00:00Z",
		}),
	} as unknown as RuntimeFileBridgePortV1;
	const f = await setup(fileBridge);
	const recordResultFile = vi.fn().mockResolvedValue(undefined);
	(
		f.driver as FakeRuntimeDriver & {
			recordResultFile: typeof recordResultFile;
		}
	).recordResultFile = recordResultFile;
	const execute = f.driver.execute.bind(f.driver);
	vi.spyOn(f.driver, "execute").mockImplementation(async (command, context) => {
		if (context?.fileBridge) {
			await context.fileBridge.writeResult(
				{
					name: "answer.txt",
					mediaType: "text/plain",
					sizeBytes: 0,
					sha256: "a".repeat(64),
				},
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.close();
					},
				}),
			);
		}
		return execute(command, context);
	});
	await f.host.submitTurnV4(f.transport);
	expect(fileBridge.writeResult).toHaveBeenCalledTimes(1);
	expect(recordResultFile).toHaveBeenCalledTimes(1);
	expect(recordResultFile).toHaveBeenCalledWith(
		expect.objectContaining({ executionId: "execution-1" }),
		expect.objectContaining({ fileId: "result-1", status: "available" }),
	);
});

it("decides bridge expiry on the injected grant clock instead of the wall clock", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "runtime-host-v4-bridge-clock-"),
	);
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	cleanups.push(() => store.close());
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	// A deployment clock decades away from the wall clock.
	let clock = 1_000_000;
	const request = submission();
	const accepted = { request, claims: businessClaims(request, clock) };
	const fileBridge = {
		readInput: vi.fn(),
		writeResult: vi.fn(),
		revalidate: vi.fn(),
	} as unknown as RuntimeFileBridgePortV1;
	const host = await RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: "platform-fixture" },
		grantValidationV2: {
			expectedIssuer: "platform-fixture",
			expectedWorkerId: "worker-fixture",
			now: () => clock,
		},
		validateGrantV4: async () => accepted,
		fileBridge: () => fileBridge,
	});
	cleanups.push(() => host.close());

	// The grant is live on the deployment clock even though the wall clock is far
	// beyond its expiry.
	await expect(host.getFileBridge(request)).resolves.toMatchObject({
		readInput: expect.any(Function),
		writeResult: expect.any(Function),
		revalidate: expect.any(Function),
	});
	clock += 60_000;
	await expect(host.getFileBridge(request)).rejects.toThrow(
		"RUNTIME_FILE_BRIDGE_BINDING_INVALID",
	);
});

it.each(["signature", "privateScope", "privateDigest"] as const)(
	"rejects %s before reservation",
	async (change) => {
		const f = await setup();
		const invalid = structuredClone(f.transport);
		if (change === "signature") invalid.businessRequest.grant.token = "a.b.c";
		if (change === "privateScope")
			invalid.privateKeyField.context.executionId = "other-execution";
		if (change === "privateDigest")
			invalid.privateKeyField.context.requestDigest = "0".repeat(64);
		const before = await readFile(f.path);
		await expect(f.host.submitTurnV4(invalid)).rejects.toThrow();
		expect(await readFile(f.path)).toEqual(before);
		expect(await f.driver.sideEffectCount()).toBe(0);
		expect(retainedKeys(f.host).size).toBe(0);
	},
);

it("replays the same running Execution and supplements with the original Key without another submit", async () => {
	const f = await setup();
	const accepted = await f.host.submitTurnV4(f.transport);
	const reopened = await f.reopen();
	const native = f.store.nativeSessionRef(accepted.hostSessionRef) as string;
	await expect(
		reopened.authorizeExternalAction(action(native)),
	).rejects.toThrow();
	expect(await reopened.submitTurnV4(f.transport)).toEqual(accepted);
	expect(await f.driver.sideEffectCount()).toBe(1);
	const { selection: _selection, ...base } = submission();
	const supplement = delivery({
		...base,
		requestId: "supplement-1",
		hostSessionRef: accepted.hostSessionRef,
		operation: {
			kind: "message",
			id: "message-1",
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
	});
	await expect(reopened.supplementV4(supplement)).resolves.toMatchObject({
		result: { outcome: "accepted" },
	});
	const wrong = delivery({
		...submission(),
		keyBinding: { ...submission().keyBinding, version: 2 },
	});
	await expect(reopened.submitTurnV4(wrong)).rejects.toThrow();
	const key = await reopened.authorizeExternalAction(action(native));
	expect(key?.relayKey).toBe("synthetic-pinned-key-k1");
	expect(key?.revalidate()).toBeUndefined();
	expect(await f.driver.sideEffectCount()).toBe(2);
});

it.each(["expired", "control", "closed"] as const)(
	"synchronous guard rejects %s after authorization",
	async (change) => {
		const f = await setup();
		const accepted = await f.host.submitTurnV4(f.transport);
		const key = await f.host.authorizeExternalAction(
			action(f.store.nativeSessionRef(accepted.hostSessionRef) as string),
		);
		if (change === "expired") f.expire();
		if (change === "closed") await f.host.close();
		if (change === "control") {
			const {
				input: _input,
				selection: _selection,
				executionSource: _source,
				keyBinding: _key,
				grant: _grant,
				...base
			} = submission();
			const control = signV3Fixture(
				{ ...base, schemaVersion: 3, hostSessionRef: accepted.hostSessionRef },
				"session.status",
				{
					now,
					purpose: "control",
					reason: "authorization_revoked",
				},
			);
			const verified = verifyRuntimeV2Fixture(control.grant);
			await f.store.authorizeRequestV3(verified.claims, "query", () => now);
		}
		expect(() => key?.revalidate()).toThrow();
		expect(retainedKeys(f.host).size).toBe(change === "closed" ? 0 : 1);
	},
);

it("releases closed Host Key references without advancing the running receipt", async () => {
	const f = await setup();
	await f.host.submitTurnV4(f.transport);
	const before = await readFile(f.path);
	expect(retainedKeys(f.host).size).toBe(1);
	await f.host.close();
	expect(retainedKeys(f.host).size).toBe(0);
	expect(await readFile(f.path)).toEqual(before);
	expect(
		f.store.readOriginalExecutionKeyScopeV4(submission())?.operation.result,
	).toEqual({ outcome: "accepted", status: "running" });
	expect(await f.driver.sideEffectCount()).toBe(1);
});

it("uses original Driver terminal evidence during event-only delivery and never reinstalls its Key", async () => {
	const f = await setup();
	const accepted = await f.host.submitTurnV4(f.transport);
	await f.driver.setOperationStatus("execution-1", "completed");
	const read = await event(
		f.transport.businessRequest,
		accepted.hostSessionRef,
	);
	const replay = await f.host.readEventsV4(
		RuntimeEventReadRequestV4Schema.parse(read.request),
		read.verification,
	);
	expect(replay.events.length).toBeGreaterThan(0);
	expect(
		f.store.readOriginalExecutionKeyScopeV4(submission())?.operation.result,
	).toEqual({ outcome: "accepted", status: "completed" });
	expect(retainedKeys(f.host).size).toBe(0);
	expect((await f.host.submitTurnV4(f.transport)).result).toEqual({
		outcome: "accepted",
		status: "completed",
	});
	expect(retainedKeys(f.host).size).toBe(0);
	expect(await f.driver.sideEffectCount()).toBe(1);
});

it.each(["status", "persist"] as const)(
	"retains the Key and occupancy on failed %s terminal confirmation",
	async (failure) => {
		const f = await setup();
		const accepted = await f.host.submitTurnV4(f.transport);
		await f.driver.setOperationStatus("execution-1", "completed");
		if (failure === "status")
			vi.spyOn(f.driver, "getStatus").mockRejectedValue(
				new Error("controlled status failure"),
			);
		else
			vi.spyOn(f.store, "resolveOperation").mockRejectedValue(
				new Error("controlled persist failure"),
			);
		const read = await event(
			f.transport.businessRequest,
			accepted.hostSessionRef,
		);
		await expect(
			f.host.readEventsV4(
				RuntimeEventReadRequestV4Schema.parse(read.request),
				read.verification,
			),
		).rejects.toThrow();
		expect(retainedKeys(f.host).size).toBe(1);
		expect(
			f.store.readOriginalExecutionKeyScopeV4(submission())?.operation.result,
		).toEqual({ outcome: "accepted", status: "running" });
		expect(await f.driver.sideEffectCount()).toBe(1);
	},
);

it("keeps acceptance unknown occupied without redispatching or installing a recovered Key", async () => {
	const f = await setup();
	const execute = f.driver.execute.bind(f.driver);
	vi.spyOn(f.driver, "execute").mockImplementation(async (command) => {
		await execute(command);
		await f.driver.makeOperationUnknown(command.operationId);
		throw new Error("controlled response loss");
	});
	await expect(f.host.submitTurnV4(f.transport)).rejects.toThrow();
	expect(retainedKeys(f.host).size).toBe(1);
	vi.restoreAllMocks();
	const reopened = await f.reopen();
	expect((await reopened.submitTurnV4(f.transport)).result.outcome).toBe(
		"unknown",
	);
	expect(retainedKeys(reopened).size).toBe(0);
	expect(await f.driver.sideEffectCount()).toBe(1);
});

it("persists only delivered cursors and keeps ACK retryable after response loss", async () => {
	const f = await setup();
	const accepted = await f.host.submitTurnV4(f.transport);
	const read = await event(
		f.transport.businessRequest,
		accepted.hostSessionRef,
	);
	const replay = await f.host.readEventsV4(
		RuntimeEventReadRequestV4Schema.parse(read.request),
		read.verification,
	);
	const cursor = replay.events[0]?.cursor;
	if (!cursor) throw new Error("Controlled Driver event missing");
	const foreign = await event(
		f.transport.businessRequest,
		accepted.hostSessionRef,
		"never-delivered",
	);
	const before = await readFile(f.path);
	await expect(
		f.host.acknowledgeEventsV4(
			RuntimeEventAckRequestV4Schema.parse(foreign.request),
			foreign.verification,
		),
	).rejects.toMatchObject({
		code: "RUNTIME_GRANT_INVALID",
		diagnostic: "ack-cursor-unknown",
	});
	// A read whose cursor differs from its Grant names the failed check (#1888).
	await expect(
		f.host.readEventsV4(
			RuntimeEventReadRequestV4Schema.parse({
				...read.request,
				afterCursor: cursor,
			}),
			read.verification,
		),
	).rejects.toMatchObject({
		code: "RUNTIME_GRANT_INVALID",
		diagnostic: "v4-event-access:cursor-mismatch",
	});
	expect(await readFile(f.path)).toEqual(before);
	const ack = await event(
		f.transport.businessRequest,
		accepted.hostSessionRef,
		cursor,
	);
	const driverAck = vi
		.fn()
		.mockRejectedValueOnce(new Error("controlled ACK response loss"))
		.mockResolvedValue(undefined);
	Object.assign(f.driver, { acknowledgeEvents: driverAck });
	await expect(
		f.host.acknowledgeEventsV4(
			RuntimeEventAckRequestV4Schema.parse(ack.request),
			ack.verification,
		),
	).rejects.toThrow();
	const persisted = await readFile(f.path);
	await expect(
		f.host.acknowledgeEventsV4(
			RuntimeEventAckRequestV4Schema.parse(ack.request),
			ack.verification,
		),
	).resolves.toMatchObject({ confirmedCursor: cursor });
	expect(await readFile(f.path)).toEqual(persisted);
	expect(driverAck).toHaveBeenCalledTimes(2);
});

function pageEvents(first: number, count: number) {
	return Array.from({ length: count }, (_, index) => ({
		schemaVersion: 1 as const,
		adapterEventKey: `page-event-${first + index}`,
		executionId: "execution-1",
		cursor: `page-cursor-${first + index}`,
		occurredAt: new Date(now).toISOString(),
		type: "text" as const,
		payload: { delta: `page-delta-${first + index}` },
	}));
}

function hostWrites(path: string) {
	const persist = vi.spyOn(
		DurableJsonFile.prototype as unknown as {
			persist(serialized: string): Promise<void>;
		},
		"persist",
	);
	return () =>
		persist.mock.contexts.filter(
			(context) => (context as { path: string }).path === path,
		).length;
}

it("records a replay page with one Host write and a re-read with none (#1637)", async () => {
	const f = await setup();
	const accepted = await f.host.submitTurnV4(f.transport);
	vi.spyOn(f.driver, "replayEvents").mockResolvedValue(pageEvents(1, 8));
	Object.assign(f.driver, { acknowledgeEvents: vi.fn(async () => undefined) });
	const writes = hostWrites(f.path);
	for (const expected of [1, 1]) {
		const read = await event(
			f.transport.businessRequest,
			accepted.hostSessionRef,
		);
		const replay = await f.host.readEventsV4(
			RuntimeEventReadRequestV4Schema.parse(read.request),
			read.verification,
		);
		expect(replay.events).toHaveLength(8);
		expect(writes()).toBe(expected);
	}
	// Every cursor of the page was recorded, so its last one is acknowledgeable,
	// and the ACK itself is one write.
	const ack = await event(
		f.transport.businessRequest,
		accepted.hostSessionRef,
		"page-cursor-8",
	);
	await expect(
		f.host.acknowledgeEventsV4(
			RuntimeEventAckRequestV4Schema.parse(ack.request),
			ack.verification,
		),
	).resolves.toMatchObject({ confirmedCursor: "page-cursor-8" });
	expect(writes()).toBe(2);
});

it("returns up to 64 waiting events per replay page, all recorded in one write (#1637)", async () => {
	const f = await setup();
	const accepted = await f.host.submitTurnV4(f.transport);
	vi.spyOn(f.driver, "replayEvents").mockResolvedValue(pageEvents(1, 100));
	Object.assign(f.driver, { acknowledgeEvents: vi.fn(async () => undefined) });
	const writes = hostWrites(f.path);
	const read = await event(
		f.transport.businessRequest,
		accepted.hostSessionRef,
	);
	const replay = await f.host.readEventsV4(
		RuntimeEventReadRequestV4Schema.parse(read.request),
		read.verification,
	);
	expect(replay.events.map((item) => item.cursor)).toEqual(
		pageEvents(1, 64).map((item) => item.cursor),
	);
	expect(writes()).toBe(1);
	const ack = await event(
		f.transport.businessRequest,
		accepted.hostSessionRef,
		"page-cursor-64",
	);
	await expect(
		f.host.acknowledgeEventsV4(
			RuntimeEventAckRequestV4Schema.parse(ack.request),
			ack.verification,
		),
	).resolves.toMatchObject({ confirmedCursor: "page-cursor-64" });
	const beyond = await event(
		f.transport.businessRequest,
		accepted.hostSessionRef,
		"page-cursor-65",
	);
	await expect(
		f.host.acknowledgeEventsV4(
			RuntimeEventAckRequestV4Schema.parse(beyond.request),
			beyond.verification,
		),
	).rejects.toThrow();
});

it("grows a replay page past eight events only within the Worker's byte bound (#1637)", async () => {
	const f = await setup();
	const accepted = await f.host.submitTurnV4(f.transport);
	const sized = (bytes: number) =>
		pageEvents(1, 20).map((item) => ({
			...item,
			payload: { delta: "x".repeat(bytes) },
		}));
	const replayed = vi.spyOn(f.driver, "replayEvents");
	Object.assign(f.driver, { acknowledgeEvents: vi.fn(async () => undefined) });
	const pageLength = async (bytes: number) => {
		replayed.mockResolvedValueOnce(sized(bytes));
		const read = await event(
			f.transport.businessRequest,
			accepted.hostSessionRef,
		);
		const replay = await f.host.readEventsV4(
			RuntimeEventReadRequestV4Schema.parse(read.request),
			read.verification,
		);
		const body = Buffer.byteLength(
			replay.events.map((item) => JSON.stringify(item)).join(","),
		);
		return { length: replay.events.length, body };
	};
	// Fourteen 70 KiB events fit the 1 MiB bound; a fifteenth would not.
	const grown = await pageLength(70 * 1024);
	expect(grown.length).toBe(14);
	expect(grown.body).toBeLessThanOrEqual(maximumRuntimeEventReplayPageBytesV4);
	// Eight events larger than the bound still form a page, as before #1637.
	expect((await pageLength(160 * 1024)).length).toBe(8);
});

it("pages reasoning events within the same event and byte bounds (#2980)", async () => {
	const f = await setup();
	const accepted = await f.host.submitTurnV4(f.transport);
	const reasoning = (count: number, bytes: number) =>
		pageEvents(1, count).map((item) => ({
			...item,
			schemaVersion: 2 as const,
			type: "reasoning" as const,
			payload: { kind: "raw" as const, delta: "x".repeat(bytes) },
		}));
	// #2980：Host 通过接口读取 Driver，接口的事件类型包含 V2。
	const replayed = vi.spyOn(f.driver as RuntimeDriver, "replayEvents");
	Object.assign(f.driver, { acknowledgeEvents: vi.fn(async () => undefined) });
	const page = async (events: ReturnType<typeof reasoning>) => {
		replayed.mockResolvedValueOnce(events);
		const read = await event(
			f.transport.businessRequest,
			accepted.hostSessionRef,
		);
		const replay = await f.host.readEventsV4(
			RuntimeEventReadRequestV4Schema.parse(read.request),
			read.verification,
		);
		return replay.events;
	};
	// 17 条 60 KiB 的思考增量在 1 MiB 上限内，第 18 条会超出。
	const large = await page(reasoning(20, 60 * 1024));
	expect(large).toHaveLength(17);
	expect(large.every((item) => item.type === "reasoning")).toBe(true);
	expect(
		Buffer.byteLength(large.map((item) => JSON.stringify(item)).join(",")),
	).toBeLessThanOrEqual(maximumRuntimeEventReplayPageBytesV4);
	// 小的思考增量仍然每页最多 64 条。
	expect(await page(reasoning(100, 8))).toHaveLength(64);
});

it("drains a long reply in full pages with the Worker's batched ACKs (#1637)", async () => {
	const f = await setup();
	const accepted = await f.host.submitTurnV4(f.transport);
	const all = pageEvents(1, 700);
	vi.spyOn(f.driver, "replayEvents").mockImplementation(
		async (_ref, _execution, after) =>
			after === undefined
				? all
				: all.slice(all.findIndex((item) => item.cursor === after) + 1),
	);
	Object.assign(f.driver, { acknowledgeEvents: vi.fn(async () => undefined) });
	let last: string | null = null;
	let persisted = 0;
	while (persisted < all.length) {
		const read = await event(
			f.transport.businessRequest,
			accepted.hostSessionRef,
			undefined,
			last,
		);
		const replay = await f.host.readEventsV4(
			RuntimeEventReadRequestV4Schema.parse(read.request),
			read.verification,
		);
		expect(replay.events.length).toBeGreaterThan(0);
		for (const item of replay.events) {
			persisted++;
			last = item.cursor;
			// The Worker confirms every 32 persisted events (platform-core).
			if (persisted % 32 === 0 || persisted === all.length) {
				const ack = await event(
					f.transport.businessRequest,
					accepted.hostSessionRef,
					item.cursor,
				);
				await f.host.acknowledgeEventsV4(
					RuntimeEventAckRequestV4Schema.parse(ack.request),
					ack.verification,
				);
			}
		}
	}
	expect(persisted).toBe(all.length);
});

it("refuses a whole page past the delivered-cursor bound without recording any of it", async () => {
	const f = await setup();
	const accepted = await f.host.submitTurnV4(f.transport);
	let page = 0;
	vi.spyOn(f.driver, "replayEvents").mockImplementation(async () =>
		pageEvents(page++ * 8 + 1, 8),
	);
	Object.assign(f.driver, { acknowledgeEvents: vi.fn(async () => undefined) });
	const read = async () => {
		const value = await event(
			f.transport.businessRequest,
			accepted.hostSessionRef,
		);
		return f.host.readEventsV4(
			RuntimeEventReadRequestV4Schema.parse(value.request),
			value.verification,
		);
	};
	// 256 delivered but unacknowledged cursors fill the Host bound exactly.
	for (let index = 0; index < 32; index++) await read();
	const before = await readFile(f.path);
	await expect(read()).rejects.toThrow();
	expect(await readFile(f.path)).toEqual(before);
	const refused = await event(
		f.transport.businessRequest,
		accepted.hostSessionRef,
		"page-cursor-257",
	);
	await expect(
		f.host.acknowledgeEventsV4(
			RuntimeEventAckRequestV4Schema.parse(refused.request),
			refused.verification,
		),
	).rejects.toThrow();
});

it("keeps the pinned Key when stop is accepted but original request drain is still running", async () => {
	const f = await setup();
	const accepted = await f.host.submitTurnV4(f.transport);
	const nativeRef = f.store.nativeSessionRef(accepted.hostSessionRef) as string;
	const key = await f.host.authorizeExternalAction(action(nativeRef));
	const execute = f.driver.execute.bind(f.driver);
	vi.spyOn(f.driver, "execute").mockImplementation(async (command) => {
		const receipt = await execute(command);
		if (command.kind !== "stop") return receipt;
		// Accepted cancellation is distinct from a terminal original request/drain.
		await f.driver.setOperationStatus("execution-1", "running");
		return {
			...receipt,
			result: { outcome: "accepted" as const, status: "running" as const },
		};
	});
	const {
		input: _input,
		selection: _selection,
		executionSource: _source,
		keyBinding: _binding,
		grant: _grant,
		...base
	} = submission();
	const stop = signV3Fixture(
		{
			...base,
			schemaVersion: 3,
			requestId: "stop-1",
			hostSessionRef: accepted.hostSessionRef,
			operation: {
				kind: "stop",
				id: "stop-1",
				deliveryFence: 1,
				executionDeliveryFence: 1,
			},
		},
		"turn.stop",
		{ now, purpose: "control", reason: "stop" },
	);
	await expect(
		f.host.stopV3(stop, verifyRuntimeV2Fixture(stop.grant)),
	).resolves.toMatchObject({
		result: { outcome: "accepted", status: "running" },
	});
	expect(retainedKeys(f.host).size).toBe(1);
	expect(() => key?.revalidate()).toThrow();
	expect(
		f.store.readOriginalExecutionKeyScopeV4(submission())?.operation.result,
	).toEqual({ outcome: "accepted", status: "running" });
});

it("restores a Key only for the durable accepted/running journal entry", async () => {
	let acceptedRecovery:
		| {
				request: RuntimeRestoreExecutionKeyRequestV4;
				claims: import("@agent-infra/contracts/runtime").RuntimeRestoreExecutionKeyGrantClaimsV4;
		  }
		| undefined;
	const f = await setup(undefined, undefined, async () => {
		if (!acceptedRecovery) throw new Error("recovery fixture not ready");
		return acceptedRecovery;
	});
	const accepted = await f.host.submitTurnV4(f.transport);
	const original = f.store.readOriginalExecutionKeyScopeV4(
		f.transport.businessRequest,
	);
	if (!original?.scope) throw new Error("missing accepted scope");
	const recoveryRequest = RuntimeRestoreExecutionKeyRequestV4Schema.parse({
		schemaVersion: 4,
		mode: "existing-accepted-only",
		acceptedHostSessionRef: accepted.hostSessionRef,
		acceptedOperationDigest: original.operation.requestDigest,
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
		originalRequest: f.transport.businessRequest,
	});
	const requestDigest =
		await runtimeRestoreExecutionKeyRequestDigestV4(recoveryRequest);
	const claims = RuntimeRestoreExecutionKeyGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer: "platform-fixture",
		audience: "runtime_host",
		workerId: "worker-fixture",
		issuedAt: now,
		expiresAt: now + 30_000,
		grantId: "recovery-grant-1",
		principal: f.transport.businessRequest.principal,
		executionSource: f.transport.businessRequest.executionSource,
		channelId: f.transport.businessRequest.channelId,
		agentId: f.transport.businessRequest.agentId,
		conversationId: f.transport.businessRequest.conversationId,
		executionId: f.transport.businessRequest.executionId,
		turnId: f.transport.businessRequest.turnId,
		sessionGeneration: f.transport.businessRequest.sessionGeneration,
		traceId: f.transport.businessRequest.traceId,
		hostSessionRef: f.transport.businessRequest.hostSessionRef,
		operation: f.transport.businessRequest.operation,
		relayKeyBinding: f.transport.businessRequest.keyBinding,
		requestDigest,
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["execution.key.restore"],
		attachments: [],
		mode: recoveryRequest.mode,
		acceptedHostSessionRef: recoveryRequest.acceptedHostSessionRef,
		acceptedOperationDigest: recoveryRequest.acceptedOperationDigest,
	});
	acceptedRecovery = { request: recoveryRequest, claims };
	const before = await readFile(f.path, "utf8");
	const result = await f.host.restoreExecutionKeyV4({
		recoveryRequest,
		privateKeyField: {
			schemaVersion: 1,
			context: {
				requestId: f.transport.businessRequest.requestId,
				grantId: claims.grantId,
				requestDigest: claims.requestDigest,
				traceId: f.transport.businessRequest.traceId,
				principal: f.transport.businessRequest.principal,
				executionSource: f.transport.businessRequest.executionSource,
				channelId: f.transport.businessRequest.channelId,
				agentId: f.transport.businessRequest.agentId,
				conversationId: f.transport.businessRequest.conversationId,
				executionId: f.transport.businessRequest.executionId,
				turnId: f.transport.businessRequest.turnId,
				sessionGeneration: f.transport.businessRequest.sessionGeneration,
				hostSessionRef: f.transport.businessRequest.hostSessionRef,
				operation: f.transport.businessRequest.operation,
				keyBinding: f.transport.businessRequest.keyBinding,
			},
			keyDelivery: { relayKey: "synthetic-pinned-key-k1" },
		},
	});
	expect(result).toEqual({
		schemaVersion: 4,
		hostSessionRef: accepted.hostSessionRef,
		operationId: f.transport.businessRequest.executionId,
		result: "restored",
	});
	expect(await f.driver.sideEffectCount()).toBe(1);
	expect(await readFile(f.path, "utf8")).toBe(before);
	expect(retainedKeys(f.host).get("execution-1")).toMatchObject({
		relayKey: "synthetic-pinned-key-k1",
	});
});

it("restores a restarted native Skill from its signed original envelope without reinvoking or rediscovering it", async () => {
	const validateRecovery = createRuntimeExecutionKeyRecoveryValidatorV4(
		publicKeys,
		{
			expectedIssuer: "platform-fixture",
			expectedWorkerId: "worker-fixture",
			now: () => now,
		},
	);
	const f = await setup(undefined, undefined, validateRecovery);
	const submitted = await f.host.submitTurnV4(f.transport);
	await f.driver.setOperationStatus("execution-1", "completed");
	const metadata = vi.fn(async () => ({
		selector: "skills" as const,
		revision: "b".repeat(64),
		capabilities: [
			{
				id: "a".repeat(64),
				kind: "skill" as const,
				name: "test-skill",
				description: "Controlled Skill",
				source: { name: "controlled", version: "1" },
				parameters: [],
				effect: "model_turn" as const,
				availability: "discovered" as const,
			},
		],
	}));
	const createSkill = vi.fn(
		(command: import("./driver.js").RuntimeNativeSkillCommandV1) => ({
			schemaVersion: 1 as const,
			kind: "submit-turn" as const,
			operationId: command.operationId,
			agentId: command.agentId,
			conversationId: command.conversationId,
			executionId: command.executionId,
			turnId: command.turnId,
			sessionGeneration: command.sessionGeneration,
			nativeSessionRef: command.nativeSessionRef,
			input: { text: command.parameters, attachments: [] },
			nativeSkill: {
				capabilityId: command.capabilityId,
				directoryRevision: command.directoryRevision,
				name: command.capabilityName,
				version: command.capabilitySourceVersion,
				packageDigest: command.packageDigest,
				manifestDigest: command.manifestDigest,
			},
		}),
	);
	Object.assign(f.driver, {
		readNativeMetadataV1: metadata,
		resolveNativeSkillBinding: () => ({
			packageDigest: "c".repeat(64),
			manifestDigest: "d".repeat(64),
		}),
		createNativeSkillCommand: createSkill,
	});
	const { input: _input, selection: _selection, ...context } = submission();
	const request = RuntimeNativeCapabilityRequestV4Schema.parse({
		...context,
		requestId: "native-skill-request",
		hostSessionRef: submitted.hostSessionRef,
		executionId: "execution-skill",
		turnId: "turn-skill",
		operation: {
			kind: "execution",
			id: "execution-skill",
			deliveryFence: 2,
			executionDeliveryFence: 2,
		},
		capabilityId: "a".repeat(64),
		capabilityKind: "skill",
		directoryRevision: "b".repeat(64),
		parameters: "skill parameters",
		parametersDigest: createHash("sha256")
			.update("skill parameters")
			.digest("hex"),
		capabilitySourceVersion: "1",
	});
	const accepted = await f.host.nativeCapabilityV4(delivery(request));
	expect(accepted.result).toEqual({ outcome: "accepted", status: "running" });
	const original = f.store.readOriginalExecutionKeyScopeV4(request);
	if (!original?.scope) throw new Error("missing original Skill binding");
	const reopened = await f.reopen();
	expect(retainedKeys(reopened).size).toBe(0);
	const metadataReads = metadata.mock.calls.length;
	const makeRecovery = async (originalRequest = request) => {
		const unsigned = RuntimeRestoreExecutionKeyRequestV4Schema.parse({
			schemaVersion: 4,
			mode: "existing-accepted-only",
			acceptedHostSessionRef: accepted.hostSessionRef,
			acceptedOperationDigest: original.operation.requestDigest,
			grant: request.grant,
			originalRequest,
		});
		const claims = RuntimeRestoreExecutionKeyGrantClaimsV4Schema.parse({
			...businessClaims(originalRequest),
			grantId: "native-skill-key-recovery",
			allowedCommands: ["execution.key.restore"],
			mode: unsigned.mode,
			acceptedHostSessionRef: unsigned.acceptedHostSessionRef,
			acceptedOperationDigest: unsigned.acceptedOperationDigest,
			requestDigest: await runtimeRestoreExecutionKeyRequestDigestV4(unsigned),
		});
		const field = delivery(originalRequest).privateKeyField;
		return {
			recoveryRequest: {
				...unsigned,
				grant: { ...unsigned.grant, token: token(claims) },
			},
			privateKeyField: {
				...field,
				context: {
					...field.context,
					grantId: claims.grantId,
					requestDigest: claims.requestDigest,
				},
			},
		};
	};
	const before = await readFile(f.path, "utf8");
	for (const changes of [
		{ capabilityId: "e".repeat(64) },
		{ directoryRevision: "f".repeat(64) },
		{ capabilitySourceVersion: "other-version" },
		{
			parameters: "changed",
			parametersDigest: createHash("sha256").update("changed").digest("hex"),
		},
		{ keyBinding: { ...request.keyBinding, version: 2 } },
		{ agentId: "other-agent" },
		{
			principal: { kind: "user" as const, id: "bob" },
			keyBinding: { ...request.keyBinding, subjectId: "bob" },
		},
	]) {
		await expect(
			reopened.restoreExecutionKeyV4(
				await makeRecovery({ ...request, ...changes }),
			),
		).rejects.toThrow();
		expect(retainedKeys(reopened).size).toBe(0);
		expect(await readFile(f.path, "utf8")).toBe(before);
	}
	await expect(
		reopened.restoreExecutionKeyV4(await makeRecovery()),
	).resolves.toMatchObject({
		result: "restored",
		operationId: "execution-skill",
	});
	expect(retainedKeys(reopened).get("execution-skill")).toMatchObject({
		relayKey: "synthetic-pinned-key-k1",
	});
	expect(await readFile(f.path, "utf8")).toBe(before);
	expect(await f.driver.sideEffectCount()).toBe(2);
	expect(createSkill).toHaveBeenCalledTimes(1);
	expect(metadata).toHaveBeenCalledTimes(metadataReads);
	// A real terminal Driver observation prevents reinstalling the accepted Key.
	await f.driver.setOperationStatus("execution-skill", "completed");
	const terminalHost = await f.reopen();
	await expect(
		terminalHost.restoreExecutionKeyV4(await makeRecovery()),
	).rejects.toThrow();
	expect(retainedKeys(terminalHost).size).toBe(0);
	expect(await f.driver.sideEffectCount()).toBe(2);
});

it("rejects missing or terminal recovery without creating durable state", async () => {
	let acceptedRecovery:
		| {
				request: RuntimeRestoreExecutionKeyRequestV4;
				claims: import("@agent-infra/contracts/runtime").RuntimeRestoreExecutionKeyGrantClaimsV4;
		  }
		| undefined;
	const f = await setup(undefined, undefined, async () => {
		if (!acceptedRecovery) throw new Error("recovery fixture not ready");
		return acceptedRecovery;
	});
	const recoveryRequest = RuntimeRestoreExecutionKeyRequestV4Schema.parse({
		schemaVersion: 4,
		mode: "existing-accepted-only",
		acceptedHostSessionRef: "missing-host-session",
		acceptedOperationDigest: "A".repeat(43),
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
		originalRequest: f.transport.businessRequest,
	});
	const requestDigest =
		await runtimeRestoreExecutionKeyRequestDigestV4(recoveryRequest);
	acceptedRecovery = {
		request: recoveryRequest,
		claims: RuntimeRestoreExecutionKeyGrantClaimsV4Schema.parse({
			schemaVersion: 4,
			issuer: "platform-fixture",
			audience: "runtime_host",
			workerId: "worker-fixture",
			issuedAt: now,
			expiresAt: now + 30_000,
			grantId: "recovery-grant-2",
			principal: f.transport.businessRequest.principal,
			executionSource: f.transport.businessRequest.executionSource,
			channelId: f.transport.businessRequest.channelId,
			agentId: f.transport.businessRequest.agentId,
			conversationId: f.transport.businessRequest.conversationId,
			executionId: f.transport.businessRequest.executionId,
			turnId: f.transport.businessRequest.turnId,
			sessionGeneration: f.transport.businessRequest.sessionGeneration,
			traceId: f.transport.businessRequest.traceId,
			hostSessionRef: f.transport.businessRequest.hostSessionRef,
			operation: f.transport.businessRequest.operation,
			relayKeyBinding: f.transport.businessRequest.keyBinding,
			requestDigest,
			purpose: "business",
			authorizationRecordId: "authorization-1",
			allowedCommands: ["execution.key.restore"],
			attachments: [],
			mode: recoveryRequest.mode,
			acceptedHostSessionRef: recoveryRequest.acceptedHostSessionRef,
			acceptedOperationDigest: recoveryRequest.acceptedOperationDigest,
		}),
	};
	const before = await readFile(f.path, "utf8");
	await expect(
		f.host.restoreExecutionKeyV4({
			recoveryRequest,
			privateKeyField: {
				schemaVersion: 1,
				context: {
					requestId: f.transport.businessRequest.requestId,
					grantId: acceptedRecovery.claims.grantId,
					requestDigest,
					traceId: f.transport.businessRequest.traceId,
					principal: f.transport.businessRequest.principal,
					executionSource: f.transport.businessRequest.executionSource,
					channelId: f.transport.businessRequest.channelId,
					agentId: f.transport.businessRequest.agentId,
					conversationId: f.transport.businessRequest.conversationId,
					executionId: f.transport.businessRequest.executionId,
					turnId: f.transport.businessRequest.turnId,
					sessionGeneration: f.transport.businessRequest.sessionGeneration,
					hostSessionRef: f.transport.businessRequest.hostSessionRef,
					operation: f.transport.businessRequest.operation,
					keyBinding: f.transport.businessRequest.keyBinding,
				},
				keyDelivery: { relayKey: "synthetic-pinned-key-k1" },
			},
		}),
	).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
	expect(await readFile(f.path, "utf8")).toBe(before);
	expect(retainedKeys(f.host).size).toBe(0);
});

function v5Request(
	hostSessionRef = "host-v5",
): RuntimeNativeCapabilityRequestV5 {
	return {
		schemaVersion: 5,
		requestId: "request-v5",
		traceId: "trace-v5",
		principal: { kind: "user", id: "alice" },
		executionSource: "web",
		channelId: "web",
		agentId: "agent-1",
		conversationId: "conversation-v5",
		executionId: "execution-v5",
		turnId: "turn-v5",
		sessionGeneration: 1,
		hostSessionRef,
		operation: {
			kind: "execution",
			id: "execution-v5",
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		keyBinding: {
			purpose: "personal",
			subjectId: "alice",
			ciphertextRef: "key-1",
			version: 1,
		},
		capabilityKind: "skill",
		capabilityId: "a".repeat(64),
		directoryRevision: "b".repeat(64),
		parameters: "{}",
		parametersDigest: createHash("sha256").update("{}").digest("hex"),
		capabilitySourceVersion: "1.0.0",
		attachments: [
			{
				attachmentId: "file-v5",
				sha256: createHash("sha256").update("hello").digest("hex"),
				byteLength: 5,
				mediaType: "text/plain",
			},
		],
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
	};
}

async function v5Accepted(
	request: RuntimeNativeCapabilityRequestV5,
	attachments = request.attachments,
) {
	const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer: "platform-fixture",
		audience: "runtime_host",
		workerId: "worker-fixture",
		issuedAt: now,
		expiresAt: now + 30_000,
		grantId: "grant-v5",
		principal: request.principal,
		executionSource: request.executionSource,
		relayKeyBinding: request.keyBinding,
		agentId: request.agentId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
		hostSessionRef: request.hostSessionRef,
		operation: request.operation,
		allowedCommands: ["native-capability.invoke"],
		purpose: "business",
		authorizationRecordId: "authorization-1",
		attachments: attachments.map((entry) => ({
			attachmentId: entry.attachmentId,
			operations: ["read"] as const,
		})),
		requestDigest: await runtimeRequestDigestV5(request),
	});
	return { request, claims };
}

it("requires a V5 validator and a text-input-aware Driver before any file bridge", async () => {
	const request = v5Request();
	const transport = RuntimeNativeCapabilityTransportV5Schema.parse({
		businessRequest: request,
		privateKeyField: {
			schemaVersion: 1,
			context: {
				requestId: request.requestId,
				grantId: "grant-v5",
				requestDigest: (await v5Accepted(request)).claims.requestDigest,
				traceId: request.traceId,
				principal: request.principal,
				executionSource: request.executionSource,
				channelId: request.channelId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				hostSessionRef: request.hostSessionRef,
				operation: request.operation,
				keyBinding: request.keyBinding,
			},
			keyDelivery: { relayKey: "synthetic-v5-key" },
		},
	});
	const withoutValidator = await setup();
	await expect(
		withoutValidator.host.nativeCapabilityV5(transport),
	).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });

	const accepted = await v5Accepted(request);
	const withoutTextInputDriver = await setup(
		undefined,
		undefined,
		undefined,
		async () => accepted,
	);
	await expect(
		withoutTextInputDriver.host.nativeCapabilityV5(transport),
	).rejects.toMatchObject({ code: "RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED" });
});

it("rejects a V5 Grant whose ordered attachments do not match the request", async () => {
	const request = v5Request();
	const accepted = await v5Accepted(request);
	const host = await setup(undefined, undefined, undefined, async () => ({
		request,
		claims: { ...accepted.claims, attachments: [] },
	}));
	await expect(
		host.host.nativeCapabilityV5(
			RuntimeNativeCapabilityTransportV5Schema.parse({
				businessRequest: request,
				privateKeyField: {
					schemaVersion: 1,
					context: {
						requestId: request.requestId,
						grantId: accepted.claims.grantId,
						requestDigest: accepted.claims.requestDigest,
						traceId: request.traceId,
						principal: request.principal,
						executionSource: request.executionSource,
						channelId: request.channelId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						hostSessionRef: request.hostSessionRef,
						operation: request.operation,
						keyBinding: request.keyBinding,
					},
					keyDelivery: { relayKey: "synthetic-v5-key" },
				},
			}),
		),
	).rejects.toThrow();
});

it("keeps V5 restore fail-closed without a recovery validator", async () => {
	const host = await setup();
	await expect(
		host.host.restoreExecutionKeyV5({
			recoveryRequest: {
				schemaVersion: 5,
				mode: "existing-accepted-only",
				acceptedHostSessionRef: "host-v5",
				acceptedOperationDigest: "A".repeat(43),
				acceptedAttachmentIds: ["file-v5"],
				grant: {
					schemaVersion: 5,
					format: "runtime-execution-jws",
					token: "a.b.c",
				},
				originalRequest: v5Request(),
			},
			privateKeyField: {
				schemaVersion: 1,
				context: {
					requestId: "request-v5",
					grantId: "grant-v5",
					requestDigest: "a".repeat(64),
					traceId: "trace-v5",
					principal: { kind: "user", id: "alice" },
					executionSource: "web",
					channelId: "web",
					agentId: "agent-1",
					conversationId: "conversation-v5",
					executionId: "execution-v5",
					turnId: "turn-v5",
					sessionGeneration: 1,
					hostSessionRef: "host-v5",
					operation: {
						kind: "execution",
						id: "execution-v5",
						deliveryFence: 1,
						executionDeliveryFence: 1,
					},
					keyBinding: {
						purpose: "personal",
						subjectId: "alice",
						ciphertextRef: "key-1",
						version: 1,
					},
				},
				keyDelivery: { relayKey: "synthetic-v5-key" },
			},
		}),
	).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
});

it("dispatches a V5 Skill with the ordered ids on the same FileBridge port the Driver reads", async () => {
	let accepted: Awaited<ReturnType<typeof v5Accepted>> | undefined;
	const deploymentBridge: RuntimeFileBridgePortV1 = {
		async readInput(fileId) {
			return {
				fileId,
				descriptor: {
					name: "input.txt",
					mediaType: "text/plain",
					sizeBytes: 5,
					sha256: createHash("sha256").update("hello").digest("hex"),
				},
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("hello"));
						controller.close();
					},
				}),
			};
		},
		async writeResult() {
			throw new Error("unused V5 result write");
		},
		revalidate() {},
	};
	const f = await setup(deploymentBridge, undefined, undefined, async () => {
		if (!accepted) throw new Error("V5 fixture is not ready");
		return accepted;
	});
	const submitted = await f.host.submitTurnV4(f.transport);
	await f.driver.setOperationStatus("execution-1", "completed");
	const request = {
		...v5Request(submitted.hostSessionRef),
		conversationId: "conversation-1",
	};
	accepted = await v5Accepted(request);
	const metadata = vi.fn(async () => ({
		selector: "skills" as const,
		revision: request.directoryRevision,
		capabilities: [
			{
				id: request.capabilityId,
				kind: "skill" as const,
				name: "v5-skill",
				description: "Controlled V5 Skill",
				source: {
					name: "controlled",
					version: request.capabilitySourceVersion,
				},
				parameters: [],
				effect: "model_turn" as const,
				availability: "discovered" as const,
			},
		],
	}));
	const originalExecute = f.driver.execute.bind(f.driver);
	let observedCommand: unknown;
	let observedInput: unknown;
	Object.assign(f.driver, {
		readNativeMetadataV1: metadata,
		resolveNativeSkillBinding: () => ({
			packageDigest: "c".repeat(64),
			manifestDigest: "d".repeat(64),
		}),
		createNativeSkillCommand: (
			command: import("./driver.js").RuntimeNativeSkillCommandV1,
		) => ({
			schemaVersion: 1 as const,
			kind: "submit-turn" as const,
			operationId: command.operationId,
			agentId: command.agentId,
			conversationId: command.conversationId,
			executionId: command.executionId,
			turnId: command.turnId,
			sessionGeneration: command.sessionGeneration,
			nativeSessionRef: command.nativeSessionRef,
			input: { text: command.parameters, attachments: [] },
			nativeSkill: {
				capabilityId: command.capabilityId,
				directoryRevision: command.directoryRevision,
				name: command.capabilityName,
				version: command.capabilitySourceVersion,
				packageDigest: command.packageDigest,
				manifestDigest: command.manifestDigest,
			},
		}),
		execute: async (
			command: import("./driver.js").RuntimeDriverCommand,
			context?: import("./driver.js").RuntimeDriverExecutionContextV1,
		) => {
			if (command.kind === "submit-turn" && "nativeSkill" in command) {
				observedCommand = command;
				const bridge = context?.fileBridge as
					| (RuntimeFileBridgePortV1 & {
							readNativeTextInput?: (
								attachmentId: string,
								signal?: AbortSignal,
							) => Promise<unknown>;
					  })
					| undefined;
				if (typeof bridge?.readNativeTextInput === "function")
					observedInput = await bridge.readNativeTextInput("file-v5");
			}
			return originalExecute(command, context);
		},
	});
	const transport = RuntimeNativeCapabilityTransportV5Schema.parse({
		businessRequest: request,
		privateKeyField: {
			schemaVersion: 1,
			context: {
				requestId: request.requestId,
				grantId: accepted.claims.grantId,
				requestDigest: accepted.claims.requestDigest,
				traceId: request.traceId,
				principal: request.principal,
				executionSource: request.executionSource,
				channelId: request.channelId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				hostSessionRef: request.hostSessionRef,
				operation: request.operation,
				keyBinding: request.keyBinding,
			},
			keyDelivery: { relayKey: "synthetic-v5-key" },
		},
	});
	await expect(f.host.nativeCapabilityV5(transport)).resolves.toMatchObject({
		schemaVersion: 5,
		operationId: "execution-v5",
		result: { outcome: "accepted", status: "running" },
	});
	expect(observedCommand).toMatchObject({
		kind: "submit-turn",
		nativeSkill: { name: "v5-skill" },
		input: { attachments: ["file-v5"] },
	});
	expect(observedInput).toEqual({
		bytes: new TextEncoder().encode("hello"),
		sha256: createHash("sha256").update("hello").digest("hex"),
		byteLength: 5,
		mediaType: "text/plain",
	});
	expect(retainedKeys(f.host).get("execution-v5")).toMatchObject({
		relayKey: "synthetic-v5-key",
	});
});
