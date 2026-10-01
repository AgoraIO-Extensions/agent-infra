import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	RuntimeBusinessGrantClaimsV2Schema,
	RuntimeControlGrantClaimsV2Schema,
	RuntimePinnedExecutionKeyScopeV4Schema,
	RuntimeStatusRequestV3Schema,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it } from "vitest";

import { RuntimeHostError } from "./errors.js";
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

it.each(["stop", "generation-cancel"] as const)(
	"rejects a V4 scope on %s before changing a valid original journal",
	async (kind) => {
		const f = await fixture();
		const request = input();
		const prepared = await f.store.prepareOperation(request);
		await f.store.resolveOperation(
			prepared.session.hostSessionRef,
			request.operationId,
			{ outcome: "accepted", status: "running" },
			"native-session-1",
		);
		const {
			authorizationRecordId: _businessRecord,
			attachments: _attachments,
			...claims
		} = request.authorization;
		const authorization = RuntimeControlGrantClaimsV2Schema.parse({
			...claims,
			purpose: "control",
			controlRecordId: "control-1",
			reason: kind === "stop" ? "stop" : "generation_isolation",
			allowedCommands: [kind === "stop" ? "turn.stop" : "generation.cancel"],
			hostSessionRef: prepared.session.hostSessionRef,
			operation: {
				...claims.operation,
				kind: kind === "stop" ? "stop" : "generation",
				id: "control-operation-1",
			},
		});
		const control = {
			...request,
			authorization,
			requestedHostSessionRef: prepared.session.hostSessionRef,
			operationId: "control-operation-1",
			kind,
			scope: kind === "stop" ? "stop:control-operation-1" : "generation:1",
			command: () => ({
				schemaVersion: 1 as const,
				kind,
				operationId: "control-operation-1",
				agentId: request.binding.agentId,
				conversationId: request.binding.conversationId,
				executionId: request.binding.executionId,
				turnId: request.binding.turnId,
				sessionGeneration: request.binding.sessionGeneration,
				nativeSessionRef: "native-session-1",
			}),
		};
		const original = f.store.readOriginalExecutionKeyScopeV4(request.binding);
		const bytes = await readFile(f.path, "utf8");
		await expect(f.store.prepareOperation(control)).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
		expect(await readFile(f.path, "utf8")).toBe(bytes);
		await f.reopen();
		expect(f.store.readOriginalExecutionKeyScopeV4(request.binding)).toEqual(
			original,
		);
		const { keyScopeV4: _scope, ...validControl } = control;
		await f.store.prepareOperation(validControl);
		const validBytes = await readFile(f.path, "utf8");
		await f.reopen();
		expect(await readFile(f.path, "utf8")).toBe(validBytes);
		expect(f.store.readOriginalExecutionKeyScopeV4(request.binding)).toEqual(
			original,
		);
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

function originalBindingQuery(original = input()) {
	const {
		authorizationRecordId: _record,
		attachments: _attachments,
		...common
	} = original.authorization;
	const claims = RuntimeControlGrantClaimsV2Schema.parse({
		...common,
		purpose: "control",
		controlRecordId: "control-1",
		reason: "recovery",
		allowedCommands: ["session.status"],
	});
	// This Store fixture does not perform Host signature/service verification.
	const request = RuntimeStatusRequestV3Schema.parse({
		...original.binding,
		schemaVersion: 3,
		requestId: "request-1",
		traceId: claims.traceId,
		hostSessionRef: null,
		operation: claims.operation,
		originalOperationDigest: original.requestDigest,
		grant: {
			schemaVersion: 2,
			format: "runtime-execution-jws",
			token: "header.payload.signature",
		},
	});
	return { request, claims };
}

async function acceptedBindingFixture(
	status:
		| "running"
		| "unknown"
		| "completed"
		| "failed"
		| "cancelled" = "running",
) {
	const f = await fixture();
	const original = input();
	const prepared = await f.store.prepareOperation(original);
	const hostSessionRef = prepared.session.hostSessionRef;
	await f.store.resolveOperation(
		hostSessionRef,
		original.operationId,
		{ outcome: "accepted", status },
		"native-session-1",
	);
	await f.reopen();
	return Object.assign(f, { original, hostSessionRef });
}

function expectBindingUnknown(read: () => string) {
	expect(read).toThrowError(RuntimeHostError);
	expect(read).toThrowError(
		expect.objectContaining({
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			httpStatus: 503,
			retryable: true,
			message: "Runtime command acceptance could not be confirmed",
		}),
	);
}

it.each(["running", "unknown", "completed", "failed", "cancelled"] as const)(
	"reads only the original accepted %s binding after reopen, retaining every durable byte",
	async (status) => {
		const f = await acceptedBindingFixture(status);
		const before = await readFile(f.path, "utf8");
		const original = f.store.readOriginalExecutionKeyScopeV4(
			f.original.binding,
		);
		for (const fence of [1, 3]) {
			for (const ref of [null, f.hostSessionRef]) {
				const { request, claims } = originalBindingQuery(f.original);
				request.hostSessionRef = claims.hostSessionRef = ref;
				request.operation.deliveryFence = claims.operation.deliveryFence =
					fence;
				request.operation.executionDeliveryFence =
					claims.operation.executionDeliveryFence = fence;
				expect(f.store.readAcceptedOriginalBindingV4(request, claims)).toBe(
					f.hostSessionRef,
				);
			}
		}
		expect(f.store.readOriginalExecutionKeyScopeV4(f.original.binding)).toEqual(
			original,
		);
		expect(await readFile(f.path, "utf8")).toBe(before);
		await f.reopen();
		expect(await readFile(f.path, "utf8")).toBe(before);
	},
);

it.each([
	"principalId",
	"principalKind",
	"channelId",
	"agentId",
	"conversationId",
	"executionId",
	"turnId",
	"sessionGeneration",
	"traceId",
	"hostSessionRef",
] as const)(
	"rejects mismatched request/claims/original %s without writing the journal",
	async (field) => {
		const f = await acceptedBindingFixture();
		const before = await readFile(f.path, "utf8");
		for (const target of ["request", "claims", "both"]) {
			const query = originalBindingQuery(f.original);
			for (const binding of target === "both"
				? [query.request, query.claims]
				: [target === "request" ? query.request : query.claims]) {
				if (field === "principalId") binding.principal.id = "bob";
				else if (field === "principalKind")
					binding.principal.kind = "application";
				else if (field === "sessionGeneration") binding.sessionGeneration = 2;
				else binding[field] = "other-object";
			}
			// A trace is per request, so only a disagreement with claims is invalid.
			if (field === "traceId" && target === "both") continue;
			expectBindingUnknown(() =>
				f.store.readAcceptedOriginalBindingV4(query.request, query.claims),
			);
		}
		expect(await readFile(f.path, "utf8")).toBe(before);
	},
);

it.each(["kind", "id", "unequal-fences", "claims-fence", "digest"] as const)(
	"rejects an invalid original control operation: %s",
	async (change) => {
		const f = await acceptedBindingFixture();
		const { request, claims } = originalBindingQuery(f.original);
		if (change === "kind")
			request.operation.kind = claims.operation.kind = "message";
		else if (change === "id")
			request.operation.id = claims.operation.id = "other-execution";
		else if (change === "unequal-fences")
			request.operation.deliveryFence = claims.operation.deliveryFence = 2;
		else if (change === "claims-fence")
			claims.operation.executionDeliveryFence = 2;
		else request.originalOperationDigest = requestDigest("different-input");
		const before = await readFile(f.path, "utf8");
		expectBindingUnknown(() =>
			f.store.readAcceptedOriginalBindingV4(request, claims),
		);
		expect(await readFile(f.path, "utf8")).toBe(before);
	},
);

it.each([
	"business",
	"readiness",
	"stop",
	"multiple-commands",
	"worker",
] as const)(
	"rejects a %s authority as an original status query",
	async (change) => {
		const f = await acceptedBindingFixture();
		const { request, claims } = originalBindingQuery(f.original);
		let supplied: Parameters<
			FileRuntimeStore["readAcceptedOriginalBindingV4"]
		>[1] = claims;
		if (change === "business") supplied = f.original.authorization;
		else if (change === "readiness")
			// Exercise a cross-purpose input at the typed internal boundary.
			supplied = {
				...claims,
				purpose: "readiness",
			} as unknown as typeof claims;
		else if (change === "stop") claims.allowedCommands = ["turn.stop"];
		else if (change === "multiple-commands")
			claims.allowedCommands.push("events.persist");
		else claims.workerId = "worker-2";
		const before = await readFile(f.path, "utf8");
		expectBindingUnknown(() =>
			f.store.readAcceptedOriginalBindingV4(request, supplied),
		);
		expect(await readFile(f.path, "utf8")).toBe(before);
	},
);

it.each(["absent", "prepared", "unknown", "busy", "legacy"] as const)(
	"keeps %s acceptance unknown without creating or replaying an operation",
	async (state) => {
		const f = await fixture();
		const original = input(state !== "legacy");
		if (state !== "absent") {
			const prepared = await f.store.prepareOperation(original);
			if (state !== "prepared")
				await f.store.resolveOperation(
					prepared.session.hostSessionRef,
					original.operationId,
					state === "legacy"
						? { outcome: "accepted", status: "running" }
						: state === "unknown"
							? {
									outcome: "unknown",
									code: "RUNTIME_ACCEPTANCE_UNKNOWN",
									message: "Runtime command acceptance could not be confirmed",
								}
							: { outcome: "busy" },
					"native-session-1",
				);
		}
		await f.reopen();
		const { request, claims } = originalBindingQuery(original);
		const before = await readFile(f.path, "utf8");
		expectBindingUnknown(() =>
			f.store.readAcceptedOriginalBindingV4(request, claims),
		);
		expect(await readFile(f.path, "utf8")).toBe(before);
	},
);

it.each([
	"native-session",
	"native-session-type",
	"scope",
	"high-water",
	"authority",
	"key-purpose",
	"key-subject",
	"application-personal-key",
	"pinned-ref",
	"stale-high-water",
	"stale-authority",
	"control-record",
	"control-reason",
	"quarantined",
] as const)(
	"fails closed after reopening an original journal with %s unavailable or mismatched",
	async (change) => {
		const f = await acceptedBindingFixture();
		await f.store.close();
		const journal = JSON.parse(await readFile(f.path, "utf8"));
		const session = journal.sessions[f.hostSessionRef];
		const operation = session.operations[f.original.operationId];
		const authority = session.executionAuthorities[f.original.operationId];
		if (change === "native-session") delete session.nativeSessionRef;
		else if (change === "native-session-type") session.nativeSessionRef = 123;
		else if (change === "scope") delete operation.keyScopeV4;
		else if (change === "high-water")
			delete session.highestFences[operation.scope];
		else if (change === "authority") delete session.executionAuthorities;
		else if (change === "key-purpose")
			operation.keyScopeV4.keyBinding.purpose = "agent-default";
		else if (change === "key-subject")
			operation.keyScopeV4.keyBinding.subjectId = "bob";
		else if (change === "application-personal-key") {
			session.authority.principal.kind = "application";
			operation.keyScopeV4.principal.kind = "application";
			operation.keyScopeV4.keyBinding.subjectId = session.agentId;
		} else if (change === "pinned-ref")
			operation.keyScopeV4.hostSessionRef = "other-host";
		else if (change === "stale-high-water")
			session.highestFences[operation.scope] = 2;
		else if (change === "stale-authority") authority.executionDeliveryFence = 2;
		else if (change === "control-record" || change === "control-reason")
			authority.control = {
				controlRecordId:
					change === "control-record" ? "control-2" : "control-1",
				reason:
					change === "control-reason" ? "authorization_revoked" : "recovery",
			};
		else {
			journal.quarantinedSessions[f.hostSessionRef] = session;
			delete journal.sessions[f.hostSessionRef];
		}
		await writeFile(f.path, `${JSON.stringify(journal)}\n`);
		await f.reopen();
		// Reopen may quarantine corrupt records; the read itself cannot repair them.
		const before = await readFile(f.path, "utf8");
		const { request, claims } = originalBindingQuery(f.original);
		if (change === "application-personal-key")
			request.principal.kind = claims.principal.kind = "application";
		expectBindingUnknown(() =>
			f.store.readAcceptedOriginalBindingV4(request, claims),
		);
		expect(await readFile(f.path, "utf8")).toBe(before);
	},
);

it.each(["active", "confirmed"] as const)(
	"keeps a durable %s generation barrier unknown without relaxing it",
	async (barrierState) => {
		const f = await acceptedBindingFixture();
		const { request, claims } = originalBindingQuery(f.original);
		const control = {
			...f.original,
			keyScopeV4: undefined,
			requestedHostSessionRef: f.hostSessionRef,
			operationId: "generation-1",
			kind: "generation-cancel" as const,
			scope: "generation:1",
			authorization: {
				...claims,
				hostSessionRef: f.hostSessionRef,
				reason: "generation_isolation" as const,
				allowedCommands: ["generation.cancel" as const],
				operation: {
					...claims.operation,
					kind: "generation" as const,
					id: "generation-1",
				},
			},
			command: () => ({
				schemaVersion: 1 as const,
				kind: "generation-cancel" as const,
				operationId: "generation-1",
				...f.original.binding,
				nativeSessionRef: "native-session-1",
			}),
		};
		await f.store.prepareOperation(control);
		await f.store.activateGenerationBarrier(
			f.hostSessionRef,
			f.original.binding,
			"generation-1",
		);
		if (barrierState === "confirmed")
			await f.store.confirmGenerationBarrier(f.hostSessionRef, "generation-1");
		await f.reopen();
		const before = await readFile(f.path, "utf8");
		expectBindingUnknown(() =>
			f.store.readAcceptedOriginalBindingV4(request, claims),
		);
		expect(await readFile(f.path, "utf8")).toBe(before);
	},
);

it("keeps a failed durable write retryable unknown instead of reading uncommitted authority", async () => {
	const f = await acceptedBindingFixture("unknown");
	const { request, claims } = originalBindingQuery(f.original);
	const before = await readFile(f.path, "utf8");
	const originalPath = `${f.path}.before-failure`;
	await rename(f.path, originalPath);
	await mkdir(f.path);
	// An actual rename-to-directory failure marks DurableJsonFile unavailable.
	await expect(
		f.store.authorizeRequestV3(
			{ ...claims, hostSessionRef: f.hostSessionRef },
			"query",
			100,
		),
	).rejects.toThrow();
	expectBindingUnknown(() =>
		f.store.readAcceptedOriginalBindingV4(request, claims),
	);
	expect(await readFile(originalPath, "utf8")).toBe(before);
});

it.each(["stop", "authorization_revoked", "recovery"] as const)(
	"reads a binding under its existing %s control authority without renewing it",
	async (reason) => {
		const f = await acceptedBindingFixture("unknown");
		const { request, claims } = originalBindingQuery(f.original);
		claims.reason = reason;
		await f.store.authorizeRequestV3(
			{ ...claims, hostSessionRef: f.hostSessionRef },
			"query",
			100,
		);
		await f.reopen();
		const before = await readFile(f.path, "utf8");
		expect(f.store.readAcceptedOriginalBindingV4(request, claims)).toBe(
			f.hostSessionRef,
		);
		expect(await readFile(f.path, "utf8")).toBe(before);
	},
);

it.each(["wecom", "platform-api"] as const)(
	"reads the original %s binding with its matching pinned Key purpose and subject",
	async (source) => {
		const f = await fixture();
		const original = input();
		if (!original.keyScopeV4) throw new Error("Missing fixture scope");
		original.keyScopeV4.executionSource = source;
		if (source === "platform-api") {
			original.keyScopeV4.keyBinding.purpose = "agent-default";
			original.keyScopeV4.keyBinding.subjectId = original.binding.agentId;
		}
		original.requestDigest = requestDigest({
			binding: original.binding,
			keyScopeV4: original.keyScopeV4,
		});
		const prepared = await f.store.prepareOperation(original);
		await f.store.resolveOperation(
			prepared.session.hostSessionRef,
			original.operationId,
			{ outcome: "accepted", status: "running" },
			"native-session-1",
		);
		await f.reopen();
		const { request, claims } = originalBindingQuery(original);
		const before = await readFile(f.path, "utf8");
		expect(f.store.readAcceptedOriginalBindingV4(request, claims)).toBe(
			prepared.session.hostSessionRef,
		);
		expect(await readFile(f.path, "utf8")).toBe(before);
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
