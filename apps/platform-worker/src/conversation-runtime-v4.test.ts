import { createRuntimeExecutionGrantVerifierV2 } from "@agent-infra/agent-runtime";
import {
	type ConversationDispatchStorePortV1,
	ConversationRuntimeHostError,
	createConversationDispatchUseCaseV1,
} from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import {
	grantSigner,
	keySentinel,
	runtimeV4Harness,
	signingKeys,
	time,
} from "./test-support/runtime-v4.js";

const verifyControl = createRuntimeExecutionGrantVerifierV2(
	new Map([["signing", signingKeys.publicKey]]),
);
const modelFact = {
	schemaVersion: 2,
	adapterEventKey: "model-fact",
	executionId: "execution",
	cursor: "model-cursor",
	occurredAt: "2026-10-02T00:00:00Z",
	type: "operation",
	payload: {
		kind: "model",
		phase: "completed",
		operationRef: "model-operation",
		attemptRef: "attempt",
		model: {
			configVersion: "config-1",
			modelOptionId: "option",
			modelId: "model",
			reasoningLevel: "high",
		},
		usage: { inputTokens: 5, outputTokens: 7, cachedInputTokens: 3 },
	},
} as const;
const toolFact = {
	schemaVersion: 2,
	adapterEventKey: "tool-fact",
	executionId: "execution",
	cursor: "tool-cursor",
	occurredAt: "2026-10-02T00:00:00Z",
	type: "operation",
	payload: {
		kind: "tool",
		phase: "unknown",
		operationRef: "tool-operation",
		attemptRef: "tool-attempt",
		toolId: "connection-tool",
		resultRef: "result",
		connection: {
			verification: "verified",
			serviceRef: "connection",
			callRef: "call",
		},
	},
} as const;
const terminal = {
	schemaVersion: 1,
	adapterEventKey: "completed-fact",
	executionId: "execution",
	cursor: "terminal-cursor",
	occurredAt: "2026-10-02T00:00:01Z",
	type: "completed",
	payload: { status: "completed" },
} as const;

describe("Execution-bound V4 in the production conversation adapter", () => {
	it.each(["submit", "supplement"] as const)(
		"delivers %s with the original version, subject and private field",
		async (operation) => {
			const h = runtimeV4Harness(operation);
			try {
				const reference = await h.authorize();
				// Rotating the current alias does not change the accepted claim or Key reader.
				Object.assign(h.claim, {
					relayKeyBinding: {
						purpose: "personal",
						subjectId: "user",
						keyId: "key-new",
						keyVersion: 2,
					},
				});
				const response = await h.runtime.runtimeHost.dispatch({
					...h.request(reference),
					input: { text: "caller replacement", attachments: [] },
				});
				const { body, url, init } = h.sent();
				expect(url).toContain(
					operation === "submit" ? "/v4/turns" : "/v4/instructions",
				);
				expect(response).toMatchObject({
					schemaVersion: operation === "submit" ? 2 : 1,
					operationId: operation === "submit" ? "execution" : "message",
				});
				expect(body.businessRequest).toMatchObject({
					input: { text: "original accepted input" },
					principal: { kind: "user", id: "user" },
					executionSource: "web",
					keyBinding: {
						purpose: "personal",
						subjectId: "user",
						ciphertextRef: "key-original",
						version: 1,
					},
				});
				expect(h.executionKeys.readCiphertext).toHaveBeenCalledWith({
					purpose: "personal",
					subjectId: "user",
					keyId: "key-original",
					keyVersion: 1,
				});
				expect(body.privateKeyField.keyDelivery.relayKey).toBe(keySentinel);
				const claims = grantSigner.verify(body.businessRequest.grant);
				expect(body.privateKeyField.context).toMatchObject({
					grantId: claims.grantId,
					requestDigest: claims.requestDigest,
					requestId: "request",
					executionId: "execution",
					turnId: "turn",
					operation: body.businessRequest.operation,
				});
				expect(JSON.stringify(body.businessRequest)).not.toContain(keySentinel);
				expect(JSON.stringify(claims)).not.toContain(keySentinel);
				expect(init?.redirect).toBe("error");
				expect(init?.headers).toMatchObject({
					authorization: "Bearer synthetic-service-token",
				});
				expect(
					h.plaintexts.every((bytes) => bytes.every((byte) => byte === 0)),
				).toBe(true);
			} finally {
				h.runtime.close();
			}
		},
	);

	it("preserves the original null submit reference after the Host has assigned its Session", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			await h.runtime.runtimeHost.dispatch(h.request(reference));
			await h.runtime.runtimeHost.dispatch(h.request(reference));
			for (const [, init] of h.fetcher.mock.calls) {
				const body = JSON.parse(init?.body as string);
				expect(body.businessRequest).toMatchObject({
					hostSessionRef: null,
					executionId: "execution",
					turnId: "turn",
					sessionGeneration: 1,
				});
				expect(body.privateKeyField.context.hostSessionRef).toBeNull();
			}
		} finally {
			h.runtime.close();
		}
	});

	it("rechecks the Runtime route with the original Session binding", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			await h.runtime.runtimeHost.dispatch(h.request(reference));
			const recheck = h.resolveRuntimeHost.mock.calls.at(-1)?.[0];
			expect(recheck).toMatchObject({
				agentId: "agent",
				actorId: "user",
				channelId: "web",
				conversationId: "conversation",
				principal: { kind: "user", id: "user" },
				sessionGeneration: 1,
				deliveryFence: 2,
				purpose: "business",
			});
		} finally {
			h.runtime.close();
		}
	});

	it.each([
		"principal",
		"source",
		"channel",
		"purpose",
		"subject",
		"reference",
		"version",
		"selection",
		"original-host",
		"authorization",
	])("rejects accepted %s mismatch before decrypting", async (field) => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			const original = h.accepted();
			if (!original) throw new Error("Missing fixture acceptance");
			const next = structuredClone(original);
			if (field === "principal") next.scope.principal.id = "other-user";
			if (field === "source") next.scope.executionSource = "platform-api";
			if (field === "channel") next.scope.channelId = "other-channel";
			if (field === "purpose")
				next.scope.keyBinding = {
					...next.scope.keyBinding,
					purpose: "agent-default",
				};
			if (field === "subject") next.scope.keyBinding.subjectId = "other-user";
			if (field === "reference")
				next.scope.keyBinding.ciphertextRef = "other-key";
			if (field === "version") next.scope.keyBinding.version = 2;
			if (field === "selection")
				next.selection.modelOptionId = "current-default-option";
			if (field === "original-host") next.scope.hostSessionRef = "other-host";
			if (field === "authorization")
				Object.assign(next, { authorizationRecordId: "other-authorization" });
			h.setAccepted(next);
			await expect(
				h.runtime.runtimeHost.dispatch(h.request(reference)),
			).rejects.toThrow();
			expect(h.executionKeys.readCiphertext).not.toHaveBeenCalled();
			expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
			expect(h.fetcher).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it.each([
		"acceptance removed",
		"acceptance changed",
		"revoked",
		"lost lease",
		"stop",
		"route changed",
		"grant expired",
	])(
		"rechecks %s after the decrypt await and never dispatches",
		async (mutation) => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				h.relayKeyDecryptor.decrypt.mockImplementationOnce(async () => {
					if (mutation === "acceptance removed") h.setAccepted(null);
					if (mutation === "acceptance changed") {
						const next = structuredClone(h.accepted());
						if (!next) throw new Error("Missing fixture acceptance");
						next.scope.keyBinding.version = 2;
						h.setAccepted(next);
					}
					if (mutation === "revoked") h.setUser(null);
					if (mutation === "lost lease")
						h.dispatchStore.readRuntimeState.mockResolvedValue(null);
					if (mutation === "stop")
						Object.assign(h.state, { stopPending: true });
					if (mutation === "route changed")
						h.target.serviceToken = "rotated-service-token";
					if (mutation === "grant expired") h.setNow(time + 30_001);
					const plaintext = new TextEncoder().encode(keySentinel);
					h.plaintexts.push(plaintext);
					return { outcome: "decrypted", plaintext };
				});
				await expect(
					h.runtime.runtimeHost.dispatch(h.request(reference)),
				).rejects.toThrow();
				expect(h.fetcher).not.toHaveBeenCalled();
				expect(h.plaintexts[0]?.every((byte) => byte === 0)).toBe(true);
				if (mutation === "revoked")
					expect(h.taskAuthorizationStore.recordControl).toHaveBeenCalledWith(
						expect.objectContaining({ reason: "authorization_revoked" }),
					);
			} finally {
				h.runtime.close();
			}
		},
	);

	it.each([
		"absent version",
		"historical protocol",
		"missing original reference",
	])("does not fall back for %s", async (missing) => {
		const h = runtimeV4Harness();
		try {
			if (missing === "absent version")
				Object.assign(h.claim, { relayKeyBinding: undefined });
			if (missing === "historical protocol")
				Object.assign(h.state, { runtimeSubmitProtocol: "v2" });
			if (missing === "missing original reference")
				Object.assign(h.state, { originalSubmitHostSessionRef: undefined });
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.dispatch(h.request(reference)),
			).rejects.toThrow();
			expect(h.fetcher).not.toHaveBeenCalled();
			expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it("uses the committed cursor for V4 replay and ACK while retaining V2 model facts", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			h.fetcher.mockImplementation(async (_url, init) => {
				const body = JSON.parse(init?.body as string);
				if (body.confirmedCursor)
					return Response.json({
						schemaVersion: 4,
						executionId: "execution",
						confirmedCursor: body.confirmedCursor,
					});
				return Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					executionId: "execution",
					events:
						body.afterCursor === "tool-cursor"
							? [terminal]
							: [modelFact, toolFact],
				});
			});
			const stream = h.runtime.runtimeHost
				.events(h.events(reference))
				[Symbol.asyncIterator]();
			expect((await stream.next()).value).toEqual(modelFact);
			await h.runtime.runtimeHost.acknowledge?.({
				...h.events(reference),
				confirmedCursor: "model-cursor",
			});
			expect(h.fetcher).toHaveBeenCalledTimes(1);
			Object.assign(h.state, { runtimeCursor: "model-cursor" });
			await h.runtime.runtimeHost.acknowledge?.({
				...h.events(reference),
				confirmedCursor: "model-cursor",
			});
			expect((await stream.next()).value).toEqual(toolFact);
			Object.assign(h.state, { runtimeCursor: "tool-cursor" });
			await h.runtime.runtimeHost.acknowledge?.({
				...h.events(reference),
				confirmedCursor: "tool-cursor",
			});
			expect((await stream.next()).value).toEqual(terminal);
			expect((await stream.next()).done).toBe(true);
			const bodies = h.fetcher.mock.calls.map(([, init]) =>
				JSON.parse(init?.body as string),
			);
			expect(
				bodies
					.filter((body) => "afterCursor" in body)
					.map((body) => body.afterCursor),
			).toEqual([null, "tool-cursor"]);
			expect(
				bodies.find((body) => "confirmedCursor" in body).confirmedCursor,
			).toBe("model-cursor");
			for (const body of bodies) {
				expect(body.schemaVersion).toBe(4);
				expect(verifyControl(body.grant).claims.eventAccess?.consumer).toBe(
					"platform_worker_persistence",
				);
				expect(body).not.toHaveProperty("privateKeyField");
			}
			expect(h.executionKeys.readCiphertext).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it("switches the same V4 event loop to persisted control after stop", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			h.fetcher.mockImplementation(async (_url, init) => {
				const body = JSON.parse(init?.body as string);
				return Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					executionId: "execution",
					events: body.afterCursor ? [terminal] : [modelFact],
				});
			});
			const stream = h.runtime.runtimeHost
				.events(h.events(reference))
				[Symbol.asyncIterator]();
			expect((await stream.next()).value).toEqual(modelFact);
			Object.assign(h.state, {
				stopPending: true,
				runtimeCursor: "model-cursor",
			});
			expect((await stream.next()).value).toEqual(terminal);
			expect(verifyControl(h.sent().body.grant).claims).toMatchObject({
				purpose: "control",
				reason: "stop",
				controlRecordId: "control-stop",
			});
			expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
			await stream.return?.();
		} finally {
			h.runtime.close();
		}
	});

	it("keeps revoked unknown original-binding recovery independent of the Key or directory", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			Object.assign(h.state, {
				hostSessionRef: null,
				executionStatus: "unknown",
				stopPending: true,
			});
			h.setRecord({ ...h.record(), revokedAt: new Date(time) });
			h.directory.resolveUser.mockRejectedValue(
				new Error("directory unavailable"),
			);
			h.setAccepted(null);
			const result = await h.runtime.runtimeHost.recoverOriginalStatus?.({
				...h.events(reference),
				schemaVersion: 2,
				hostSessionRef: null,
			});
			expect(result).toMatchObject({
				schemaVersion: 2,
				outcome: "binding_found",
				executionId: "execution",
				hostSessionRef: "host",
			});
			expect(h.sent().url).toContain("/v3/original-binding");
			expect(h.sent().body.originalOperationDigest).toBe(
				h.state.originalOperationDigest,
			);
			expect(verifyControl(h.sent().body.grant).claims).toMatchObject({
				purpose: "control",
				reason: "authorization_revoked",
			});
			expect(h.executionKeys.readAcceptedExecution).not.toHaveBeenCalled();
			expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
			expect(
				h.fetcher.mock.calls.some(([url]) => String(url).endsWith("/turns")),
			).toBe(false);
		} finally {
			h.runtime.close();
		}
	});

	it("keeps historical V3 metadata recovery and ACK Key-free", async () => {
		const h = runtimeV4Harness();
		try {
			const marker = {
				id: "history-pass",
				requestedAt: time,
				originalStatus: "failed" as const,
			};
			Object.assign(h.claim, {
				metadataRecovery: marker,
				executionStatus: "completed",
				runtimeCursor: "committed",
			});
			Object.assign(h.state, {
				metadataRecovery: marker,
				executionStatus: "completed",
				runtimeCursor: "committed",
				runtimeSubmitProtocol: "v2",
			});
			const reference = await h.authorize();
			await h.runtime.runtimeHost.acknowledge?.({
				...h.events(reference),
				requestId: marker.id,
				confirmedCursor: "committed",
			});
			expect(h.sent().url).toContain("/v3/events/ack");
			expect(h.sent().body.requestId).toBe("history-pass");
			expect(verifyControl(h.sent().body.grant).claims).toMatchObject({
				purpose: "control",
				reason: "recovery",
			});
			expect(h.executionKeys.readAcceptedExecution).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it("rejects a copied authorization reference before any Key read", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.dispatch(h.request({ ...(reference as object) })),
			).rejects.toThrow();
			expect(h.executionKeys.readAcceptedExecution).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});
	it("keeps reading Host pages past a terminal Platform status until the terminal event (#1524)", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			Object.assign(h.state, { executionStatus: "completed" });
			h.fetcher.mockImplementation(async (_url, init) => {
				const body = JSON.parse(init?.body as string);
				return Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					executionId: "execution",
					events:
						body.afterCursor === "model-cursor" ? [terminal] : [modelFact],
				});
			});
			const stream = h.runtime.runtimeHost
				.events(h.events(reference))
				[Symbol.asyncIterator]();
			expect((await stream.next()).value).toEqual(modelFact);
			Object.assign(h.state, { runtimeCursor: "model-cursor" });
			expect((await stream.next()).value).toEqual(terminal);
			expect((await stream.next()).done).toBe(true);
		} finally {
			h.runtime.close();
		}
	});

	describe("continuing a V4 drain on its proven route (#1525)", () => {
		function pages(h: ReturnType<typeof runtimeV4Harness>) {
			h.fetcher.mockImplementation(async (_url, init) => {
				const body = JSON.parse(init?.body as string);
				return Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					executionId: "execution",
					events:
						body.afterCursor === "model-cursor" ? [terminal] : [modelFact],
				});
			});
		}

		it("re-checks authorization before each read and reuses the fresh live route (#1611)", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				pages(h);
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				expect((await stream.next()).value).toEqual(modelFact);
				Object.assign(h.state, { runtimeCursor: "model-cursor" });
				const resolves = h.resolveRuntimeHost.mock.calls.length;
				const users = h.directory.resolveUser.mock.calls.length;
				const records =
					h.taskAuthorizationStore.readExecution.mock.calls.length;
				expect((await stream.next()).value).toEqual(terminal);
				expect((await stream.next()).done).toBe(true);
				// One authorization evaluation guards the second read; the live
				// route proved by the preparation is still inside its window.
				expect(h.resolveRuntimeHost.mock.calls.length - resolves).toBe(0);
				expect(h.directory.resolveUser.mock.calls.length - users).toBe(1);
				expect(
					h.taskAuthorizationStore.readExecution.mock.calls.length - records,
				).toBe(2);
				expect(
					h.fetcher.mock.calls.map(
						([, init]) => JSON.parse(init?.body as string).afterCursor,
					),
				).toEqual([null, "model-cursor"]);
			} finally {
				h.runtime.close();
			}
		});

		it("prepares again when the Session state changed beyond the cursor", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				pages(h);
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				expect((await stream.next()).value).toEqual(modelFact);
				Object.assign(h.state, {
					runtimeCursor: "model-cursor",
					originalSubmitHostSessionRef: "host",
				});
				const resolves = h.resolveRuntimeHost.mock.calls.length;
				expect((await stream.next()).value).toEqual(terminal);
				// A full preparation observes the live route three times.
				expect(h.resolveRuntimeHost.mock.calls.length - resolves).toBe(3);
			} finally {
				h.runtime.close();
			}
		});

		it("continues with the recovery control Grant once the Platform records a Host-confirmed finish (#1554)", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				pages(h);
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				expect((await stream.next()).value).toEqual(modelFact);
				// Core persisted the confirmed terminal status under its lease.
				Object.assign(h.state, {
					runtimeCursor: "model-cursor",
					executionStatus: "completed",
				});
				expect((await stream.next()).value).toEqual(terminal);
				expect((await stream.next()).done).toBe(true);
				const reads = h.fetcher.mock.calls.map(([, init]) =>
					JSON.parse(init?.body as string),
				);
				expect(reads).toHaveLength(2);
				expect(verifyControl(reads[0].grant).claims.purpose).toBe("business");
				expect(verifyControl(reads[1].grant).claims).toMatchObject({
					purpose: "control",
					reason: "recovery",
					allowedCommands: ["events.persist"],
				});
				// No business renewal is possible after the switch.
				await expect(
					h.runtime.runtimeHost.renewAuthorization?.(h.events(reference)),
				).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
			} finally {
				h.runtime.close();
			}
		});

		it("signs the next read for control once the user is disabled between pages", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				pages(h);
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				expect((await stream.next()).value).toEqual(modelFact);
				Object.assign(h.state, { runtimeCursor: "model-cursor" });
				h.setUser(null);
				expect((await stream.next()).value).toEqual(terminal);
				const reads = h.fetcher.mock.calls.map(([, init]) =>
					JSON.parse(init?.body as string),
				);
				expect(reads).toHaveLength(2);
				expect(verifyControl(reads[0].grant).claims.purpose).toBe("business");
				expect(verifyControl(reads[1].grant).claims).toMatchObject({
					purpose: "control",
					reason: "authorization_revoked",
				});
			} finally {
				h.runtime.close();
			}
		});
	});

	describe("bounding the live route reuse of a V4 drain (#1611)", () => {
		const route = "/internal/runtime/v4/events/";
		function threePages(h: ReturnType<typeof runtimeV4Harness>) {
			h.fetcher.mockImplementation(async (url, init) => {
				const body = JSON.parse(init?.body as string);
				if (String(url).endsWith("/events/ack"))
					return Response.json({
						schemaVersion: 4,
						executionId: "execution",
						confirmedCursor: body.confirmedCursor,
					});
				return Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					executionId: "execution",
					events:
						body.afterCursor === null
							? [modelFact]
							: body.afterCursor === "model-cursor"
								? [toolFact]
								: [terminal],
				});
			});
		}
		async function firstPage(h: ReturnType<typeof runtimeV4Harness>) {
			const reference = await h.authorize();
			threePages(h);
			const stream = h.runtime.runtimeHost
				.events(h.events(reference))
				[Symbol.asyncIterator]();
			expect((await stream.next()).value).toEqual(modelFact);
			Object.assign(h.state, { runtimeCursor: "model-cursor" });
			return { reference, stream };
		}
		const calls = (h: ReturnType<typeof runtimeV4Harness>) => ({
			routes: h.resolveRuntimeHost.mock.calls.length,
			users: h.directory.resolveUser.mock.calls.length,
			sent: h.fetcher.mock.calls.length,
		});
		const acks = (h: ReturnType<typeof runtimeV4Harness>) =>
			h.fetcher.mock.calls
				.filter(([url]) => String(url).endsWith(`${route}ack`))
				.map(([, init]) => JSON.parse(init?.body as string));

		it("re-observes the live route once its proof leaves the window, then reuses the refreshed proof", async () => {
			const h = runtimeV4Harness();
			try {
				const { stream } = await firstPage(h);
				h.setNow(time + 2_000);
				const before = calls(h);
				expect((await stream.next()).value).toEqual(toolFact);
				expect(calls(h).routes - before.routes).toBe(1);
				expect(calls(h).users - before.users).toBe(2);
				Object.assign(h.state, { runtimeCursor: "tool-cursor" });
				h.setNow(time + 3_999);
				const refreshed = calls(h);
				expect((await stream.next()).value).toEqual(terminal);
				expect(calls(h).routes - refreshed.routes).toBe(0);
				expect(calls(h).users - refreshed.users).toBe(1);
			} finally {
				h.runtime.close();
			}
		});

		it.each(["changed", "unavailable"] as const)(
			"sends no read when the re-observed live route is %s",
			async (change) => {
				const h = runtimeV4Harness();
				try {
					const { stream } = await firstPage(h);
					h.setNow(time + 2_000);
					if (change === "changed")
						h.target.serviceToken = "rotated-service-token";
					else
						h.resolveRuntimeHost.mockRejectedValue(
							new ConversationRuntimeHostError(
								"RUNTIME_WORKLOAD_UNAVAILABLE",
								true,
							),
						);
					const before = calls(h);
					await expect(stream.next()).rejects.toMatchObject({
						code:
							change === "changed"
								? "RUNTIME_ROUTE_STALE"
								: "RUNTIME_WORKLOAD_UNAVAILABLE",
					});
					expect(calls(h).sent).toBe(before.sent);
				} finally {
					h.runtime.close();
				}
			},
		);

		it("rejects a Platform route record change on the next read inside the window", async () => {
			const h = runtimeV4Harness();
			try {
				const { stream } = await firstPage(h);
				h.setRecord({
					...h.record(),
					workload: { ...h.workload, revision: h.workload.revision + 1 },
				});
				const before = calls(h);
				await expect(stream.next()).rejects.toMatchObject({
					code: "RUNTIME_ROUTE_STALE",
				});
				expect(calls(h).sent).toBe(before.sent);
				expect(calls(h).routes).toBe(before.routes);
			} finally {
				h.runtime.close();
			}
		});

		it("ACKs inside the drain on the reads' preparation with one authorization evaluation", async () => {
			const h = runtimeV4Harness();
			try {
				const { reference } = await firstPage(h);
				const before = calls(h);
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(reference),
					confirmedCursor: "model-cursor",
				});
				// A full preparation would add three route observations and four
				// authorization evaluations before the ACK.
				expect(calls(h).routes - before.routes).toBe(0);
				expect(calls(h).users - before.users).toBe(1);
				expect(acks(h)).toHaveLength(1);
				expect(acks(h)[0]?.confirmedCursor).toBe("model-cursor");
				expect(verifyControl(acks(h)[0]?.grant).claims).toMatchObject({
					purpose: "business",
					authorizationRecordId: "authorization",
					eventAccess: {
						command: "events.ack",
						confirmedCursor: "model-cursor",
					},
				});
			} finally {
				h.runtime.close();
			}
		});

		it("prepares an ACK again when its re-observed live route changed", async () => {
			const h = runtimeV4Harness();
			try {
				const { reference } = await firstPage(h);
				h.setNow(time + 2_000);
				h.target.serviceToken = "rotated-service-token";
				const before = calls(h);
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(reference),
					confirmedCursor: "model-cursor",
				});
				// The stale proof is rejected before sending; only the new full
				// preparation's route carries the ACK.
				expect(calls(h).routes - before.routes).toBe(4);
				expect(acks(h)).toHaveLength(1);
				expect(h.sent().url).toMatch(/\/events\/ack$/);
				expect(h.sent().init?.headers).toMatchObject({
					authorization: "Bearer rotated-service-token",
				});
			} finally {
				h.runtime.close();
			}
		});

		it("signs the ACK for control when the user is disabled after the last read", async () => {
			const h = runtimeV4Harness();
			try {
				const { reference } = await firstPage(h);
				h.setUser(null);
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(reference),
					confirmedCursor: "model-cursor",
				});
				expect(acks(h)).toHaveLength(1);
				expect(verifyControl(acks(h)[0]?.grant).claims).toMatchObject({
					purpose: "control",
					reason: "authorization_revoked",
				});
			} finally {
				h.runtime.close();
			}
		});

		it("prepares the ACK again after a stop since the last read", async () => {
			const h = runtimeV4Harness();
			try {
				const { reference } = await firstPage(h);
				Object.assign(h.state, { stopPending: true });
				const before = calls(h);
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(reference),
					confirmedCursor: "model-cursor",
				});
				expect(calls(h).routes - before.routes).toBe(3);
				expect(acks(h)).toHaveLength(1);
				expect(verifyControl(acks(h)[0]?.grant).claims).toMatchObject({
					purpose: "control",
					reason: "stop",
				});
			} finally {
				h.runtime.close();
			}
		});

		it("keeps the full route check for a business submission", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				await h.runtime.runtimeHost.dispatch(h.request(reference));
				// Three observations prepare the Turn and one guards its send.
				expect(h.resolveRuntimeHost).toHaveBeenCalledTimes(4);
			} finally {
				h.runtime.close();
			}
		});
	});

	it("ends a drained stream for a terminal Platform status without spinning (#1524)", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			Object.assign(h.state, { executionStatus: "completed" });
			h.fetcher.mockImplementation(async (_url, init) => {
				const body = JSON.parse(init?.body as string);
				return Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					executionId: "execution",
					events: body.afterCursor === "model-cursor" ? [] : [modelFact],
				});
			});
			const stream = h.runtime.runtimeHost
				.events(h.events(reference))
				[Symbol.asyncIterator]();
			expect((await stream.next()).value).toEqual(modelFact);
			Object.assign(h.state, { runtimeCursor: "model-cursor" });
			// The Host has nothing more; Core decides whether the stream completed.
			expect((await stream.next()).done).toBe(true);
			expect(h.fetcher).toHaveBeenCalledTimes(2);
		} finally {
			h.runtime.close();
		}
	});

	it("renews only the original V4 Execution lease through the existing Key-free V3 control envelope", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			await h.runtime.runtimeHost.renewAuthorization?.(h.events(reference));
			expect(h.sent().url).toContain("/v3/authorizations/renew");
			expect(h.sent().body).toMatchObject({
				executionId: "execution",
				turnId: "turn",
				hostSessionRef: "host",
				operation: {
					kind: "execution",
					id: "execution",
					deliveryFence: 2,
					executionDeliveryFence: 2,
				},
			});
			expect(verifyControl(h.sent().body.grant).claims).toMatchObject({
				purpose: "business",
				authorizationRecordId: "authorization",
				allowedCommands: ["execution.renew"],
			});
			expect(h.sent().body).not.toHaveProperty("keyBinding");
			expect(h.sent().body).not.toHaveProperty("privateKeyField");
			expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it.each(["unknown", "malformed", "disconnected"])(
		"never submits a successor after %s original acceptance",
		async (outcome) => {
			const h = runtimeV4Harness();
			Object.assign(h.claim, {
				executionStatus: "submitted",
				hostSessionRef: null,
			});
			Object.assign(h.state, {
				executionStatus: "submitted",
				hostSessionRef: null,
			});
			const store: ConversationDispatchStorePortV1 = {
				claim: vi.fn(async () => ({
					outcome: "claimed" as const,
					claim: structuredClone(h.claim),
				})),
				renew: vi.fn(async () => true),
				prepareRuntimeDispatch: vi.fn(async () => true),
				cancelUnaccepted: vi.fn(async () => true),
				recordRuntimeResponse: vi.fn(async (input) => {
					Object.assign(h.claim, { hostSessionRef: input.hostSessionRef });
					Object.assign(h.state, { hostSessionRef: input.hostSessionRef });
					return true;
				}),
				finish: vi.fn(async () => true),
				retry: vi.fn(async () => {
					Object.assign(h.claim, { executionStatus: "unknown" });
					Object.assign(h.state, { executionStatus: "unknown" });
					return true;
				}),
			};
			const persist = vi.fn(async () => {
				throw new Error("No accepted event expected");
			});
			const useCase = createConversationDispatchUseCaseV1(
				{
					store,
					authorization: h.runtime.authorization,
					runtimeHost: h.runtime.runtimeHost,
					events: { persist },
				},
				{ retryDelayMs: 0 },
			);
			h.fetcher.mockImplementation(async (url, init) => {
				if (String(url).endsWith("/status"))
					return Response.json({
						schemaVersion: 3,
						executionId: "execution",
						hostSessionRef: h.state.hostSessionRef,
						outcome: "not_found",
					});
				if (outcome === "disconnected")
					throw new Error("synthetic transport disconnected");
				if (outcome === "malformed") return new Response("invalid JSON");
				const body = JSON.parse(init?.body as string);
				return Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					operationId: body.businessRequest.operation.id,
					result: {
						outcome: "unknown",
						code: "RUNTIME_ACCEPTANCE_UNKNOWN",
						message: "Runtime command acceptance could not be confirmed",
					},
				});
			});
			try {
				const command = {
					schemaVersion: 1 as const,
					itemId: "item",
					workerId: "instance",
				};
				expect((await useCase.dispatch(command)).outcome).toBe(
					outcome === "unknown" ? "unknown" : "retry",
				);
				await useCase.dispatch(command);
				expect(
					h.fetcher.mock.calls.filter(([url]) =>
						String(url).endsWith("/v4/turns"),
					),
				).toHaveLength(1);
				expect(
					h.fetcher.mock.calls.some(([url]) =>
						String(url).includes("/v3/turns"),
					),
				).toBe(false);
				expect(h.claim).toMatchObject({
					executionId: "execution",
					turnId: "turn",
					sessionGeneration: 1,
				});
				expect(persist).not.toHaveBeenCalled();
			} finally {
				h.runtime.close();
			}
		},
	);

	it("does not ACK an operation fact whose persistence transaction fails", async () => {
		const h = runtimeV4Harness();
		const store: ConversationDispatchStorePortV1 = {
			claim: vi.fn(async () => ({
				outcome: "claimed" as const,
				claim: structuredClone(h.claim),
			})),
			renew: vi.fn(async () => true),
			prepareRuntimeDispatch: vi.fn(async () => true),
			cancelUnaccepted: vi.fn(async () => true),
			recordRuntimeResponse: vi.fn(async () => true),
			finish: vi.fn(async () => true),
			retry: vi.fn(async () => true),
		};
		const persist = vi.fn(async () => {
			throw new Error("transaction unavailable");
		});
		const useCase = createConversationDispatchUseCaseV1(
			{
				store,
				authorization: h.runtime.authorization,
				runtimeHost: h.runtime.runtimeHost,
				events: { persist },
			},
			{ retryDelayMs: 0 },
		);
		h.fetcher.mockImplementation(async (url) =>
			String(url).endsWith("/status")
				? Response.json({
						schemaVersion: 3,
						executionId: "execution",
						hostSessionRef: "host",
						outcome: "found",
						status: "running",
					})
				: Response.json({
						schemaVersion: 4,
						executionId: "execution",
						hostSessionRef: "host",
						events: [modelFact],
					}),
		);
		try {
			expect(
				await useCase.dispatch({
					schemaVersion: 1,
					itemId: "item",
					workerId: "instance",
				}),
			).toMatchObject({ outcome: "retry" });
			expect(persist).toHaveBeenCalledWith(
				expect.objectContaining({
					runtimeCursor: "model-cursor",
					event: expect.objectContaining({
						type: "execution.operation",
						fact: modelFact.payload,
					}),
				}),
			);
			expect(
				h.fetcher.mock.calls.some(([url]) =>
					String(url).endsWith("/events/ack"),
				),
			).toBe(false);
			expect(h.state.runtimeCursor).toBeNull();
			expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});
});
