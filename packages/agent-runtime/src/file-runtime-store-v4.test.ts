import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	RuntimeBusinessGrantClaimsV2Schema,
	RuntimePinnedExecutionKeyScopeV4Schema,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it } from "vitest";

import { FileRuntimeStore, requestDigest } from "./file-runtime-store.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function input(v4 = true) {
	const binding = {
		principal: { kind: "user" as const, id: "alice" },
		channelId: "web",
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		turnId: "turn-1",
		sessionGeneration: 1,
	};
	const keyScopeV4 = RuntimePinnedExecutionKeyScopeV4Schema.parse({
		...binding,
		executionSource: "web",
		hostSessionRef: null,
		keyBinding: {
			purpose: "personal",
			subjectId: "alice",
			ciphertextRef: "ciphertext-1",
			version: 1,
		},
	});
	const authorization = RuntimeBusinessGrantClaimsV2Schema.parse({
		schemaVersion: 2,
		issuer: "platform-worker",
		audience: "runtime_host",
		issuedAt: 100,
		expiresAt: 200,
		grantId: "grant-1",
		workerId: "worker-1",
		...binding,
		traceId: "trace-1",
		hostSessionRef: null,
		operation: {
			kind: "execution",
			id: binding.executionId,
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		requestDigest: "a".repeat(64),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["turn.submit"],
		attachments: [],
	});
	return {
		binding,
		authorization,
		now: 100,
		operationId: binding.executionId,
		kind: "submit-turn" as const,
		scope: `execution:${binding.executionId}`,
		deliveryFence: 1,
		requestDigest: requestDigest({
			binding,
			keyScopeV4: v4 ? keyScopeV4 : null,
		}),
		...(v4 ? { keyScopeV4 } : {}),
		command: () => ({
			schemaVersion: 2 as const,
			kind: "submit-turn" as const,
			operationId: binding.executionId,
			agentId: binding.agentId,
			conversationId: binding.conversationId,
			executionId: binding.executionId,
			turnId: binding.turnId,
			sessionGeneration: binding.sessionGeneration,
			input: { text: "synthetic-message", attachments: [] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "model-1",
				reasoningLevel: "high",
			},
		}),
	};
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-key-journal-"));
	const path = join(directory, "host.json");
	let store = await FileRuntimeStore.open(path);
	cleanups.push(async () => {
		await store.close();
		await rm(directory, { recursive: true });
	});
	return {
		path,
		get store() {
			return store;
		},
		async reopen() {
			await store.close();
			store = await FileRuntimeStore.open(path);
		},
	};
}

async function supplementFixture(v4 = true) {
	const f = await fixture();
	const request = input(v4);
	const prepared = await f.store.prepareOperation(request);
	const hostSessionRef = prepared.session.hostSessionRef;
	await f.store.resolveOperation(
		hostSessionRef,
		request.operationId,
		{ outcome: "accepted", status: "running" },
		"native-session-1",
	);
	await f.store.prepareOperation({
		...request,
		requestedHostSessionRef: hostSessionRef,
		operationId: "message-1",
		kind: "supplement",
		scope: "message:message-1",
		requestDigest: requestDigest({ messageId: "message-1" }),
		authorization: {
			...request.authorization,
			operation: {
				...request.authorization.operation,
				kind: "message",
				id: "message-1",
			},
			allowedCommands: ["turn.supplement"],
		},
		command: () => ({
			schemaVersion: 1,
			kind: "supplement",
			operationId: "message-1",
			agentId: request.binding.agentId,
			conversationId: request.binding.conversationId,
			executionId: request.binding.executionId,
			turnId: request.binding.turnId,
			sessionGeneration: request.binding.sessionGeneration,
			nativeSessionRef: "native-session-1",
			input: { text: "synthetic-instruction", attachments: [] },
		}),
	});
	await f.store.resolveOperation(hostSessionRef, "message-1", {
		outcome: "accepted",
		status: "running",
	});
	return Object.assign(f, { request, hostSessionRef });
}

it.each([false, true])(
	"reopens a matching supplement journal without changing bytes for original V4=%s",
	async (v4) => {
		const f = await supplementFixture(v4);
		const original = f.store.readOriginalExecutionKeyScopeV4(f.request.binding);
		const bytes = await readFile(f.path, "utf8");
		await f.reopen();
		expect(await readFile(f.path, "utf8")).toBe(bytes);
		expect(
			f.store.readOriginalExecutionKeyScopeV4(f.request.binding),
		).toStrictEqual(original);
	},
);

it.each(["key-version", "removed-scope", "added-scope"] as const)(
	"quarantines a persisted supplement with %s instead of repairing its original scope",
	async (corruption) => {
		const f = await supplementFixture(corruption !== "added-scope");
		await f.store.close();
		const journal = JSON.parse(await readFile(f.path, "utf8"));
		const session = journal.sessions[f.hostSessionRef];
		const supplement = session.operations["message-1"];
		if (corruption === "key-version")
			supplement.keyScopeV4.keyBinding.version = 2;
		else if (corruption === "removed-scope") delete supplement.keyScopeV4;
		else supplement.keyScopeV4 = input().keyScopeV4;
		if (supplement.keyScopeV4)
			RuntimePinnedExecutionKeyScopeV4Schema.parse(supplement.keyScopeV4);
		await writeFile(f.path, `${JSON.stringify(journal)}\n`);
		await f.reopen();
		expect(() =>
			f.store.readOriginalExecutionKeyScopeV4(f.request.binding),
		).toThrow("Runtime session state is quarantined");
		const quarantined = JSON.parse(await readFile(f.path, "utf8"));
		expect(quarantined.sessions).toEqual({});
		expect(quarantined.sessionBindings).toEqual(journal.sessionBindings);
		expect(quarantined.quarantinedSessions).toEqual({
			[f.hostSessionRef]: session,
		});
	},
);

it.each(["running", "unknown", "completed", "failed", "cancelled"] as const)(
	"reads the same original V4 scope and %s receipt after reopening real durable storage",
	async (status) => {
		const f = await fixture();
		const request = input();
		const prepared = await f.store.prepareOperation(request);
		await f.store.resolveOperation(
			prepared.session.hostSessionRef,
			request.operationId,
			{ outcome: "accepted", status },
			"native-session-1",
		);
		const original = f.store.readOriginalExecutionKeyScopeV4(request.binding);
		await f.reopen();
		const bytes = await readFile(f.path, "utf8");
		const recovered = f.store.readOriginalExecutionKeyScopeV4(request.binding);
		expect(recovered).toStrictEqual(original);
		expect(recovered).toMatchObject({
			hostSessionRef: prepared.session.hostSessionRef,
			scope: request.keyScopeV4,
			operation: {
				operationId: request.operationId,
				executionId: request.binding.executionId,
				turnId: request.binding.turnId,
				requestDigest: request.requestDigest,
				deliveryFence: 1,
				result: { outcome: "accepted", status },
			},
		});
		if (!recovered?.scope) throw new Error("Original scope was not restored");
		recovered.scope.keyBinding.version = 99;
		expect(f.store.readOriginalExecutionKeyScopeV4(request.binding)).toEqual(
			original,
		);
		expect(await readFile(f.path, "utf8")).toBe(bytes);
		expect(f.store.nativeSessionRef(prepared.session.hostSessionRef)).toBe(
			"native-session-1",
		);
	},
);

it("returns null for a missing original without creating or modifying a Session", async () => {
	const f = await fixture();
	const bytes = await readFile(f.path, "utf8");
	expect(f.store.readOriginalExecutionKeyScopeV4(input().binding)).toBeNull();
	expect(await readFile(f.path, "utf8")).toBe(bytes);
});

it("keeps the stored scope independent from the caller's mutable input", async () => {
	const f = await fixture();
	const request = input();
	const original = structuredClone(request.keyScopeV4);
	await f.store.prepareOperation(request);
	if (!request.keyScopeV4) throw new Error("Missing fixture scope");
	request.keyScopeV4.keyBinding.version = 99;
	expect(
		f.store.readOriginalExecutionKeyScopeV4(request.binding)?.scope,
	).toEqual(original);
});

it.each([
	"principalId",
	"principalKind",
	"channelId",
	"agentId",
	"conversationId",
	"executionId",
	"turnId",
	"sessionGeneration",
] as const)(
	"rejects an initial V4 scope with another %s without changing durable bytes",
	async (field) => {
		const f = await fixture();
		const request = input();
		if (!request.keyScopeV4) throw new Error("Missing fixture scope");
		const keyScopeV4 = structuredClone(request.keyScopeV4);
		if (field === "principalId") keyScopeV4.principal.id = "bob";
		else if (field === "principalKind")
			keyScopeV4.principal.kind = "application";
		else if (field === "sessionGeneration") keyScopeV4.sessionGeneration = 2;
		else keyScopeV4[field] = "other-object";
		RuntimePinnedExecutionKeyScopeV4Schema.parse(keyScopeV4);
		const bytes = await readFile(f.path, "utf8");
		await expect(
			f.store.prepareOperation({ ...request, keyScopeV4 }),
		).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		expect(await readFile(f.path, "utf8")).toBe(bytes);
		await f.reopen();
		expect(f.store.readOriginalExecutionKeyScopeV4(request.binding)).toBeNull();
		expect(await readFile(f.path, "utf8")).toBe(bytes);
	},
);

it("rejects an initial V4 scope without original authority while retaining legacy admission", async () => {
	const f = await fixture();
	const request = input();
	const bytes = await readFile(f.path, "utf8");
	await expect(
		f.store.prepareOperation({ ...request, authorization: undefined }),
	).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
	expect(await readFile(f.path, "utf8")).toBe(bytes);
	const legacy = input(false);
	const {
		principal: _principal,
		channelId: _channel,
		...binding
	} = legacy.binding;
	await f.store.prepareOperation({
		...legacy,
		binding,
		authorization: undefined,
	});
	await f.reopen();
	expect(f.store.readOriginalExecutionKeyScopeV4(binding)?.scope).toBeNull();
});

it("rejects a retry with another pinned Key or removed scope without changing durable bytes", async () => {
	const f = await fixture();
	const request = input();
	await f.store.prepareOperation(request);
	const bytes = await readFile(f.path, "utf8");
	const { keyScopeV4, ...legacyRetry } = request;
	if (!keyScopeV4) throw new Error("Missing fixture scope");
	await expect(
		f.store.prepareOperation({
			...request,
			keyScopeV4: {
				...keyScopeV4,
				keyBinding: { ...keyScopeV4.keyBinding, version: 2 },
			},
		}),
	).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
	await expect(f.store.prepareOperation(legacyRetry)).rejects.toMatchObject({
		code: "RUNTIME_OPERATION_CONFLICT",
	});
	expect(await readFile(f.path, "utf8")).toBe(bytes);
});

it.each([false, true])(
	"rejects mixed legacy/V4 supplements for original V4=%s",
	async (originalV4) => {
		const f = await fixture();
		const request = input(originalV4);
		const prepared = await f.store.prepareOperation(request);
		const { keyScopeV4: _scope, ...base } = request;
		const otherScope = input().keyScopeV4;
		const bytes = await readFile(f.path, "utf8");
		await expect(
			f.store.prepareOperation({
				...base,
				...(originalV4 ? {} : { keyScopeV4: otherScope }),
				requestedHostSessionRef: prepared.session.hostSessionRef,
				operationId: "message-1",
				kind: "supplement",
				scope: "message:message-1",
			}),
		).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		expect(await readFile(f.path, "utf8")).toBe(bytes);
	},
);

it.each(["running", "unknown"] as const)(
	"renews only the original %s business lease while preserving the Key and receipt",
	async (status) => {
		const f = await fixture();
		const request = input();
		const prepared = await f.store.prepareOperation(request);
		await f.store.resolveOperation(
			prepared.session.hostSessionRef,
			request.operationId,
			{ outcome: "accepted", status },
			"native-session-1",
		);
		const renewed = await f.store.prepareOperation({
			...request,
			now: 250,
			deliveryFence: 2,
			authorization: {
				...request.authorization,
				issuedAt: 250,
				expiresAt: 350,
				operation: {
					...request.authorization.operation,
					deliveryFence: 2,
					executionDeliveryFence: 2,
				},
			},
		});
		expect(renewed.session.hostSessionRef).toBe(
			prepared.session.hostSessionRef,
		);
		expect(renewed.operation.result).toEqual({ outcome: "accepted", status });
		expect(renewed.operation.keyScopeV4).toEqual(request.keyScopeV4);
		expect(
			renewed.session.executionAuthorities?.[request.operationId],
		).toMatchObject({
			workerId: "worker-1",
			authorizationRecordId: "authorization-1",
			issuedAt: 250,
			expiresAt: 350,
			executionDeliveryFence: 2,
		});
		await f.reopen();
		expect(
			f.store.readOriginalExecutionKeyScopeV4(request.binding)?.operation,
		).toEqual(renewed.operation);
	},
);

it("rejects a new supplement using another Key version before changing the original journal", async () => {
	const f = await fixture();
	const request = input();
	const prepared = await f.store.prepareOperation(request);
	await f.store.resolveOperation(
		prepared.session.hostSessionRef,
		request.operationId,
		{ outcome: "accepted", status: "running" },
		"native-session-1",
	);
	if (!request.keyScopeV4) throw new Error("Missing fixture scope");
	const bytes = await readFile(f.path, "utf8");
	await expect(
		f.store.prepareOperation({
			...request,
			requestedHostSessionRef: prepared.session.hostSessionRef,
			operationId: "message-1",
			kind: "supplement",
			scope: "message:message-1",
			authorization: {
				...request.authorization,
				operation: {
					...request.authorization.operation,
					kind: "message",
					id: "message-1",
				},
				allowedCommands: ["turn.supplement"],
			},
			keyScopeV4: {
				...request.keyScopeV4,
				keyBinding: { ...request.keyScopeV4.keyBinding, version: 2 },
			},
			command: () => ({
				schemaVersion: 1,
				kind: "supplement",
				operationId: "message-1",
				agentId: request.binding.agentId,
				conversationId: request.binding.conversationId,
				executionId: request.binding.executionId,
				turnId: request.binding.turnId,
				sessionGeneration: request.binding.sessionGeneration,
				nativeSessionRef: "native-session-1",
				input: { text: "synthetic-instruction", attachments: [] },
			}),
		}),
	).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
	expect(await readFile(f.path, "utf8")).toBe(bytes);
});

it.each(["expired-in-queue", "future-issued"] as const)(
	"checks the current authorization clock for a resolved running renewal: %s",
	async (boundary) => {
		const f = await fixture();
		const request = input();
		const prepared = await f.store.prepareOperation(request);
		await f.store.resolveOperation(
			prepared.session.hostSessionRef,
			request.operationId,
			{
				outcome: "accepted",
				status: "running",
			},
		);
		const bytes = await readFile(f.path, "utf8");
		let queuedNow = 150;
		const renewal = f.store.prepareOperation({
			...request,
			now: () => queuedNow,
			authorization: {
				...request.authorization,
				issuedAt: boundary === "future-issued" ? 300 : 150,
				expiresAt: boundary === "future-issued" ? 400 : 200,
			},
		});
		queuedNow = 250;
		await expect(renewal).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
		expect(await readFile(f.path, "utf8")).toBe(bytes);
	},
);

it.each(["worker", "record", "stale-time", "stopped", "control"] as const)(
	"does not revive the original running authorization after %s changes",
	async (change) => {
		const f = await fixture();
		const request = input();
		const prepared = await f.store.prepareOperation(request);
		await f.store.resolveOperation(
			prepared.session.hostSessionRef,
			request.operationId,
			{
				outcome: "accepted",
				status: "running",
			},
		);
		if (change === "stopped" || change === "control") {
			await f.store.close();
			const journal = JSON.parse(await readFile(f.path, "utf8"));
			const authority =
				journal.sessions[prepared.session.hostSessionRef].executionAuthorities[
					request.operationId
				];
			if (change === "stopped") authority.stopped = true;
			else
				authority.control = {
					controlRecordId: "control-1",
					reason: "recovery",
				};
			await writeFile(f.path, `${JSON.stringify(journal)}\n`);
			await f.reopen();
		}
		const bytes = await readFile(f.path, "utf8");
		await expect(
			f.store.prepareOperation({
				...request,
				authorization: {
					...request.authorization,
					...(change === "worker" ? { workerId: "worker-2" } : {}),
					...(change === "record"
						? { authorizationRecordId: "authorization-2" }
						: {}),
					...(change === "stale-time" ? { issuedAt: 99 } : {}),
				},
			}),
		).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		expect(await readFile(f.path, "utf8")).toBe(bytes);
	},
);

it("preserves a legacy journal without inventing a V4 Key binding", async () => {
	const f = await fixture();
	const request = input(false);
	const prepared = await f.store.prepareOperation(request);
	await f.store.resolveOperation(
		prepared.session.hostSessionRef,
		request.operationId,
		{
			outcome: "accepted",
			status: "completed",
		},
	);
	await f.reopen();
	expect(
		f.store.readOriginalExecutionKeyScopeV4(request.binding),
	).toMatchObject({
		hostSessionRef: prepared.session.hostSessionRef,
		scope: null,
		operation: {
			requestDigest: request.requestDigest,
			result: { status: "completed" },
		},
	});
});

it.each([
	"principalId",
	"principalKind",
	"channelId",
	"authority",
	"agentId",
	"conversationId",
	"executionId",
	"turnId",
	"sessionGeneration",
] as const)(
	"quarantines a persisted V4 scope with a mismatched %s instead of rebinding it",
	async (field) => {
		const f = await fixture();
		const request = input();
		const prepared = await f.store.prepareOperation(request);
		await f.store.close();
		const journal = JSON.parse(await readFile(f.path, "utf8"));
		const session = journal.sessions[prepared.session.hostSessionRef];
		const scope = session.operations[request.operationId].keyScopeV4;
		if (field === "principalId") scope.principal.id = "bob";
		else if (field === "principalKind") scope.principal.kind = "application";
		else if (field === "authority") {
			delete session.authority;
			delete session.executionAuthorities;
		} else scope[field] = field === "sessionGeneration" ? 2 : "other-object";
		RuntimePinnedExecutionKeyScopeV4Schema.parse(scope);
		await writeFile(f.path, `${JSON.stringify(journal)}\n`);
		await f.reopen();
		expect(() =>
			f.store.readOriginalExecutionKeyScopeV4(request.binding),
		).toThrow("Runtime session state is quarantined");
		const quarantined = JSON.parse(await readFile(f.path, "utf8"));
		expect(
			quarantined.quarantinedSessions[prepared.session.hostSessionRef],
		).toBeDefined();
		expect(quarantined.sessionBindings).toEqual(journal.sessionBindings);
		expect(quarantined.sessions).toEqual({});
	},
);
