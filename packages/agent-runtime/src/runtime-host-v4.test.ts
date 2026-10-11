import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type RuntimeBusinessGrantClaimsV4,
	RuntimeBusinessGrantClaimsV4Schema,
	type RuntimeBusinessRequestV4,
	RuntimeEventAckRequestV4Schema,
	RuntimeEventReadRequestV4Schema,
	RuntimeExecutionGrantClaimsV2Schema,
	RuntimeSubmitTurnRequestV4Schema,
	type RuntimeSubmitTurnTransportV4,
	runtimeEventRequestDigestV4,
	runtimeRequestSigningPayloadV4,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeExternalActionAuthorization } from "./driver.js";
import { FakeRuntimeDriver } from "./fake-runtime-driver.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import { createRuntimeExecutionGrantVerifierV2 } from "./grant-v2.js";
import {
	signV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
import { createRuntimeExecutionGrantValidatorV4 } from "./grant-v4.js";
import type { RuntimeFileBridgePortV1 } from "./runtime-file-bridge.js";
import { RuntimeHost } from "./runtime-host.js";

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
			"selection" in request ? "turn.submit" : "turn.supplement",
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

async function setup(fileBridge?: RuntimeFileBridgePortV1) {
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
	request: RuntimeSubmitTurnTransportV4["businessRequest"],
	hostSessionRef: string,
	cursor?: string,
) {
	const {
		input: _input,
		selection: _selection,
		grant: _grant,
		...base
	} = request;
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
		...(cursor ? { confirmedCursor: cursor } : { afterCursor: null }),
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
	).rejects.toThrow();
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
