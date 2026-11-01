import { createHash } from "node:crypto";
import { createRuntimeExecutionGrantVerifierV2 } from "@agent-infra/agent-runtime";
import {
	type ConversationDispatchStorePortV1,
	type ConversationRuntimeDispatchRequestV1,
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
	it("dispatches and restores an Invocation V2 Skill plan over Native V5", async () => {
		const h = runtimeV4Harness();
		const parameters = JSON.stringify({ path: "workspace/file.txt" });
		const attachments = [
			{
				fileId: "file-input-1",
				sha256: createHash("sha256").update("first").digest("hex"),
				byteLength: 5,
				mediaType: "text/plain" as const,
			},
			{
				fileId: "file-input-2",
				sha256: createHash("sha256").update("second").digest("hex"),
				byteLength: 6,
				mediaType: "text/plain" as const,
			},
		];
		const nativeCapability = {
			agentId: "agent",
			actorId: "user",
			channelId: "web",
			turnId: "turn",
			capabilityId: "a".repeat(64),
			capabilityKind: "skill",
			directoryRevision: "b".repeat(64),
			capabilitySourceVersion: "1.0.0",
			parameters,
			parametersDigest: createHash("sha256").update(parameters).digest("hex"),
			attachments,
		} as const;
		Object.assign(h.claim, {
			operation: "conversation.native-capability.invoke.v1",
			messageId: null,
			modelConfigurationRevision: null,
			modelOptionId: null,
			reasoningLevel: null,
			input: null,
			nativeCapability,
		});
		const accepted = h.accepted();
		if (!accepted) throw new Error("Missing accepted execution");
		h.setAccepted({
			...accepted,
			trustedHostSessionRef: "host",
			scope: { ...accepted.scope, hostSessionRef: "host" },
			selection: undefined,
		});
		const fallback = h.fetcher.getMockImplementation();
		h.fetcher.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/v5/native-capability"))
				return Response.json({
					schemaVersion: 5,
					hostSessionRef: "host",
					operationId: "execution",
					result: { outcome: "accepted", status: "running" },
				});
			if (String(url).endsWith("/v5/execution-key/restore"))
				return Response.json({
					schemaVersion: 5,
					hostSessionRef: "host",
					operationId: "execution",
					result: "restored",
				});
			if (!fallback) throw new Error("missing fixture transport");
			return fallback(url, init);
		});
		try {
			const reference = await h.authorize();
			const request: ConversationRuntimeDispatchRequestV1 = {
				schemaVersion: 1,
				operation: "native-capability.invoke",
				requestId: "request",
				traceId: "trace",
				agentId: "agent",
				actorId: "user",
				channelId: "web",
				conversationId: "conversation",
				executionId: "execution",
				turnId: "turn",
				sessionGeneration: 1,
				deliveryFence: 2,
				executionDeliveryFence: 2,
				hostSessionRef: "host",
				runtimeGrant: reference,
				nativeCapability,
			};
			await expect(
				h.runtime.runtimeHost.dispatch(request),
			).resolves.toMatchObject({ result: { outcome: "accepted" } });
			const sent = h.sent();
			expect(sent.url).toContain("/v5/native-capability");
			expect(sent.body.businessRequest).toMatchObject({
				schemaVersion: 5,
				capabilityKind: "skill",
				capabilityId: nativeCapability.capabilityId,
				attachments: [
					{
						attachmentId: "file-input-1",
						sha256: attachments[0]?.sha256,
						byteLength: 5,
						mediaType: "text/plain",
					},
					{
						attachmentId: "file-input-2",
						sha256: attachments[1]?.sha256,
						byteLength: 6,
						mediaType: "text/plain",
					},
				],
			});
			expect(sent.body.businessRequest.grant.schemaVersion).toBe(4);
			expect(sent.body.privateKeyField.keyDelivery.relayKey).toBe(keySentinel);

			Object.assign(h.state, { originalSubmitHostSessionRef: "host" });
			await expect(
				h.runtime.runtimeHost.recoverOriginalStatus?.({
					...h.events(reference),
					schemaVersion: 2,
				}),
			).resolves.toMatchObject({ outcome: "found", status: "running" });
			const restores = h.fetcher.mock.calls.filter(([url]) =>
				String(url).endsWith("/v5/execution-key/restore"),
			);
			expect(restores).toHaveLength(1);
			const restored = JSON.parse(restores[0]?.[1]?.body as string);
			expect(restored.recoveryRequest).toMatchObject({
				schemaVersion: 5,
				acceptedAttachmentIds: ["file-input-1", "file-input-2"],
				originalRequest: {
					schemaVersion: 5,
					hostSessionRef: "host",
					attachments: [
						{ attachmentId: "file-input-1", byteLength: 5 },
						{ attachmentId: "file-input-2", byteLength: 6 },
					],
				},
			});
			expect(restored.privateKeyField.keyDelivery.relayKey).toBe(keySentinel);
		} finally {
			if (fallback) h.fetcher.mockImplementation(fallback);
		}
	});

	it.each(["command", "skill"] as const)(
		"dispatches an admitted V4 native %s plan with its exact binding",
		async (capabilityKind) => {
			const h = runtimeV4Harness();
			const parameters = JSON.stringify({ path: "workspace/file.txt" });
			const nativeCapability = {
				agentId: "agent",
				actorId: "user",
				channelId: "web",
				turnId: "turn",
				capabilityId: "a".repeat(64),
				capabilityKind,
				directoryRevision: "b".repeat(64),
				capabilitySourceVersion: "1.0.0",
				parameters,
				parametersDigest: createHash("sha256").update(parameters).digest("hex"),
			} as const;
			Object.assign(h.claim, {
				operation: "conversation.native-capability.invoke.v1",
				messageId: null,
				modelConfigurationRevision: null,
				modelOptionId: null,
				reasoningLevel: null,
				input: null,
				nativeCapability,
			});
			const accepted = h.accepted();
			if (!accepted) throw new Error("Missing accepted execution");
			h.setAccepted({
				...accepted,
				trustedHostSessionRef: "host",
				scope: { ...accepted.scope, hostSessionRef: "host" },
				selection: undefined,
			});
			try {
				const reference = await h.authorize();
				const request: ConversationRuntimeDispatchRequestV1 = {
					schemaVersion: 1,
					operation: "native-capability.invoke",
					requestId: "request",
					traceId: "trace",
					agentId: "agent",
					actorId: "user",
					channelId: "web",
					conversationId: "conversation",
					executionId: "execution",
					turnId: "turn",
					sessionGeneration: 1,
					deliveryFence: 2,
					executionDeliveryFence: 2,
					hostSessionRef: "host",
					runtimeGrant: reference,
					nativeCapability,
				};
				await expect(
					h.runtime.runtimeHost.dispatch(request),
				).resolves.toMatchObject({
					result: { outcome: "accepted" },
				});
				const sent = h.sent();
				expect(sent.url).toContain("/v4/native-capability");
				expect(sent.body.businessRequest).toMatchObject({
					capabilityId: nativeCapability.capabilityId,
					capabilityKind,
					directoryRevision: nativeCapability.directoryRevision,
					capabilitySourceVersion: nativeCapability.capabilitySourceVersion,
					parameters: nativeCapability.parameters,
					parametersDigest: nativeCapability.parametersDigest,
				});
				expect(sent.body.businessRequest).not.toHaveProperty("input");
				expect(sent.body.businessRequest).not.toHaveProperty("selection");
				expect(sent.body.businessRequest.operation).toMatchObject({
					kind: "execution",
					id: "execution",
				});
				Object.assign(h.state, { originalSubmitHostSessionRef: "host" });
				const fetcher = h.fetcher.getMockImplementation();
				h.fetcher.mockImplementation(async (url, init) => {
					if (String(url).endsWith("/execution-key/restore"))
						return Response.json({
							schemaVersion: 4,
							hostSessionRef: "host",
							operationId: "execution",
							result: "restored",
						});
					if (!fetcher) throw new Error("missing fixture transport");
					return fetcher(url, init);
				});
				const beforeReads =
					h.executionKeys.readAcceptedExecution.mock.calls.length;
				await expect(
					h.runtime.runtimeHost.recoverOriginalStatus?.({
						...h.events(reference),
						schemaVersion: 2,
					}),
				).resolves.toMatchObject({ outcome: "found", status: "running" });
				const restores = h.fetcher.mock.calls.filter(([url]) =>
					String(url).endsWith("/execution-key/restore"),
				);
				expect(restores).toHaveLength(capabilityKind === "skill" ? 1 : 0);
				expect(h.executionKeys.readAcceptedExecution).toHaveBeenCalledTimes(
					beforeReads + (capabilityKind === "skill" ? 1 : 0),
				);
				if (capabilityKind === "skill") {
					const restored = JSON.parse(restores[0]?.[1]?.body as string);
					expect(restored.recoveryRequest.originalRequest).toMatchObject({
						capabilityId: nativeCapability.capabilityId,
						capabilityKind,
						directoryRevision: nativeCapability.directoryRevision,
						parameters,
						parametersDigest: nativeCapability.parametersDigest,
						capabilitySourceVersion: nativeCapability.capabilitySourceVersion,
						hostSessionRef: "host",
						keyBinding: { ciphertextRef: "key-original", version: 1 },
					});
					expect(restored.recoveryRequest.originalRequest).not.toHaveProperty(
						"input",
					);
					expect(restored.recoveryRequest.originalRequest).not.toHaveProperty(
						"selection",
					);
					expect(restored.recoveryRequest.acceptedOperationDigest).toBe(
						h.state.originalOperationDigest,
					);
					expect(restored.privateKeyField.keyDelivery.relayKey).toBe(
						keySentinel,
					);
					expect(h.executionKeys.readCiphertext).toHaveBeenLastCalledWith({
						purpose: "personal",
						subjectId: "user",
						keyId: "key-original",
						keyVersion: 1,
					});
				}
				// Historical missing pins permit status reads, never Key replacement.
				const readsBeforeMissingPin =
					h.executionKeys.readAcceptedExecution.mock.calls.length;
				Object.assign(h.claim, {
					relayKeyBinding: null,
					executionSource: null,
				});
				const keyfreeReference = await h.authorize();
				await expect(
					h.runtime.runtimeHost.recoverOriginalStatus?.({
						...h.events(keyfreeReference),
						schemaVersion: 2,
					}),
				).resolves.toMatchObject({ outcome: "found", status: "running" });
				expect(h.executionKeys.readAcceptedExecution).toHaveBeenCalledTimes(
					readsBeforeMissingPin,
				);
				expect(
					h.fetcher.mock.calls.filter(([url]) =>
						String(url).endsWith("/native-capability"),
					),
				).toHaveLength(1);
			} finally {
				h.runtime.close();
			}
		},
	);

	it("fails closed on a mismatched V4 native response without retrying the operation", async () => {
		const h = runtimeV4Harness();
		const parameters = "{}";
		const nativeCapability = {
			agentId: "agent",
			actorId: "user",
			channelId: "web",
			turnId: "turn",
			capabilityId: "a".repeat(64),
			capabilityKind: "skill" as const,
			directoryRevision: "b".repeat(64),
			capabilitySourceVersion: "1.0.0",
			parameters,
			parametersDigest: createHash("sha256").update(parameters).digest("hex"),
		};
		Object.assign(h.claim, {
			operation: "conversation.native-capability.invoke.v1",
			messageId: null,
			modelConfigurationRevision: null,
			modelOptionId: null,
			reasoningLevel: null,
			input: null,
			nativeCapability,
		});
		const accepted = h.accepted();
		if (!accepted) throw new Error("Missing accepted execution");
		h.setAccepted({
			...accepted,
			trustedHostSessionRef: "host",
			scope: { ...accepted.scope, hostSessionRef: "host" },
			selection: undefined,
		});
		h.fetcher.mockImplementationOnce(async () =>
			Response.json({
				schemaVersion: 4,
				hostSessionRef: "host",
				executionId: "foreign-execution",
				operationId: "foreign-execution",
				result: { outcome: "accepted", status: "running" },
			}),
		);
		try {
			const reference = await h.authorize();
			const request: ConversationRuntimeDispatchRequestV1 = {
				schemaVersion: 1,
				operation: "native-capability.invoke",
				requestId: "request",
				traceId: "trace",
				agentId: "agent",
				actorId: "user",
				channelId: "web",
				conversationId: "conversation",
				executionId: "execution",
				turnId: "turn",
				sessionGeneration: 1,
				deliveryFence: 2,
				executionDeliveryFence: 2,
				hostSessionRef: "host",
				runtimeGrant: reference,
				nativeCapability,
			};
			await expect(
				h.runtime.runtimeHost.dispatch(request),
			).rejects.toMatchObject({
				code: "RUNTIME_RESPONSE_INVALID",
			});
			expect(h.fetcher).toHaveBeenCalledTimes(1);
		} finally {
			h.runtime.close();
		}
	});

	it("routes Browser handoff through the existing control grant and V3 client", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			h.fetcher.mockImplementationOnce(async (_input, init) => {
				const body = JSON.parse(init?.body as string) as {
					readonly hostSessionRef: string;
				};
				return Response.json({
					schemaVersion: 3,
					hostSessionRef: body.hostSessionRef,
					executionId: "execution",
					outcome: "accepted",
					record: {
						handoffId: "handoff-1",
						status: "requested",
						reason: "mfa",
						requestedAt: "2026-10-14T00:00:00.000Z",
						expiresAt: "2026-10-14T00:05:00.000Z",
					},
				});
			});
			const result = await h.runtime.browserHandoff({
				...h.events(reference),
				handoff: {
					kind: "request",
					reason: "mfa",
					runtime: {
						browserAlive: true,
						authorized: true,
						subjectId: "user",
						agentId: "agent",
						conversationId: "conversation",
						executionId: "execution",
						sessionGeneration: 1,
						resourceFence: 2,
						workloadRevision: 1,
						imageDigest: `sha256:${"a".repeat(64)}`,
						capabilityVersion: 1,
						pageRevision: 1,
					},
				},
			});
			expect(result.response.record?.status).toBe("requested");
			const sent = h.sent();
			expect(sent.url).toContain("/internal/runtime/v3/browser/handoff");
			const claims = verifyControl(sent.body.grant).claims;
			expect(claims).toMatchObject({
				purpose: "control",
				reason: "browser_handoff",
				allowedCommands: ["browser.handoff"],
			});
		} finally {
			await h.runtime.close();
		}
	});

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

	it.each([
		[
			"supplement",
			"cursor advance",
			{ runtimeCursor: "cursor-advanced" },
			true,
		],
		["submit", "cursor advance", { runtimeCursor: "cursor-advanced" }, false],
		["supplement", "stop", { stopPending: true }, false],
	] as const)(
		"%s rechecks the fenced state across a concurrent %s before sending (#3445)",
		async (operation, _change, change, sends) => {
			// 对照：未变化时一次投递解析几次路由；最后一次属于发送前复核。
			const control = runtimeV4Harness(operation);
			let last = 0;
			try {
				await control.runtime.runtimeHost.dispatch(
					control.request(await control.authorize()),
				);
				last = control.resolveRuntimeHost.mock.calls.length;
			} finally {
				control.runtime.close();
			}
			expect(last).toBeGreaterThan(1);
			const h = runtimeV4Harness(operation);
			try {
				const reference = await h.authorize();
				const before = h.resolveRuntimeHost.mock.calls.length;
				const resolve = h.resolveRuntimeHost.getMockImplementation();
				h.resolveRuntimeHost.mockImplementation(async (input) => {
					const target = await resolve?.(input);
					// 发送前复核解析路由时，原 Turn 的排空已提交事件（或 stop 已受理）。
					if (h.resolveRuntimeHost.mock.calls.length - before === last)
						Object.assign(h.state, change);
					return target as never;
				});
				const dispatched = h.runtime.runtimeHost.dispatch(h.request(reference));
				if (sends) {
					await expect(dispatched).resolves.toMatchObject({
						operationId: "message",
					});
					expect(h.fetcher).toHaveBeenCalled();
				} else {
					await expect(dispatched).rejects.toMatchObject({
						code: expect.stringMatching(/^RUNTIME_(FENCE|ROUTE)_STALE$/),
					});
					expect(h.fetcher).not.toHaveBeenCalled();
				}
			} finally {
				h.runtime.close();
			}
		},
	);

	it("sends an attachment-only message without an empty body (#3227)", async () => {
		const h = runtimeV4Harness("submit");
		try {
			Object.assign(h.claim, {
				input: { text: "", attachments: ["file-input-1"] },
			});
			const reference = await h.authorize();
			await h.runtime.runtimeHost.dispatch(h.request(reference));
			expect(h.sent().body.businessRequest.input).toEqual({
				attachments: ["file-input-1"],
			});
		} finally {
			await h.runtime.close();
		}
	});

	// #3314：Host 持久化的附件拒绝原样交给 Core 收敛为失败终态；字段漂移时失败关闭。
	it.each([
		[
			"passes the persisted file input rejection to Core",
			"Runtime file input was rejected",
			false,
		],
		[
			"fails closed on a drifted file input rejection",
			"Runtime file input was rejected for file-input-1",
			false,
		],
		[
			"fails closed on a retryable file input rejection",
			"Runtime file input was rejected",
			true,
		],
	] as const)("%s (#3314)", async (name, message, retryable) => {
		const h = runtimeV4Harness("submit");
		try {
			Object.assign(h.claim, {
				input: { text: "inspect", attachments: ["file-input-1"] },
			});
			const result = {
				outcome: "rejected",
				code: "RUNTIME_FILE_INPUT_REJECTED",
				message,
				retryable,
			};
			h.fetcher.mockImplementationOnce(async (_url, init) =>
				Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					operationId: JSON.parse(init?.body as string).businessRequest
						.operation.id,
					result,
				}),
			);
			const reference = await h.authorize();
			const dispatched = h.runtime.runtimeHost.dispatch(h.request(reference));
			if (name.startsWith("passes"))
				await expect(dispatched).resolves.toMatchObject({ result });
			else
				await expect(dispatched).rejects.toMatchObject({
					code: "RUNTIME_RESPONSE_INVALID",
				});
			expect(h.fetcher).toHaveBeenCalledTimes(1);
		} finally {
			await h.runtime.close();
		}
	});

	// #3373：Host 持久化的未提交结果（带固定阶段、可重试）原样交给 Core 重提；字段漂移时失败关闭，
	// 不能被当作未提交而重投。
	const notSubmitted = {
		outcome: "rejected",
		code: "RUNTIME_TURN_NOT_SUBMITTED",
		message: "Runtime turn was not submitted",
		reason: "file_input_unavailable",
		retryable: true,
	} as const;
	it.each([
		["passes the persisted unsubmitted Turn to Core", notSubmitted],
		[
			"passes the session preparation stage to Core",
			{ ...notSubmitted, reason: "session_preparation_failed" },
		],
		[
			"fails closed on an unpinned not-submitted stage",
			{ ...notSubmitted, reason: "exchange_timeout" },
		],
		[
			"fails closed on a non-retryable not-submitted result",
			{ ...notSubmitted, retryable: false },
		],
		[
			"fails closed on a not-submitted result without a stage",
			{
				outcome: notSubmitted.outcome,
				code: notSubmitted.code,
				message: notSubmitted.message,
				retryable: notSubmitted.retryable,
			},
		],
		[
			"fails closed on a not-submitted result carrying diagnostics",
			{ ...notSubmitted, message: "Codex app-server is unreachable" },
		],
	] as const)("%s (#3373)", async (name, result) => {
		const h = runtimeV4Harness("submit");
		try {
			Object.assign(h.claim, {
				input: { text: "inspect", attachments: ["file-input-1"] },
			});
			h.fetcher.mockImplementationOnce(async (_url, init) =>
				Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					operationId: JSON.parse(init?.body as string).businessRequest
						.operation.id,
					result,
				}),
			);
			const reference = await h.authorize();
			const dispatched = h.runtime.runtimeHost.dispatch(h.request(reference));
			if (name.startsWith("passes"))
				await expect(dispatched).resolves.toMatchObject({ result });
			else
				await expect(dispatched).rejects.toMatchObject({
					code: "RUNTIME_RESPONSE_INVALID",
				});
			expect(h.fetcher).toHaveBeenCalledTimes(1);
		} finally {
			await h.runtime.close();
		}
	});

	it("reports a stop-pending key race without sending the business request", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			const accepted = h.accepted();
			if (!accepted) throw new Error("Missing fixture acceptance");
			h.setAccepted({ ...accepted, stopPending: true });
			await expect(
				h.runtime.runtimeHost.dispatch(h.request(reference)),
			).rejects.toMatchObject({ code: "RUNTIME_STOP_PENDING" });
			expect(h.fetcher).not.toHaveBeenCalled();
			expect(h.executionKeys.readCiphertext).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

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

	it("requires signed readiness only on the last route resolution before submit (#2134)", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			const before = h.resolveRuntimeHost.mock.calls.length;
			await h.runtime.runtimeHost.dispatch(h.request(reference));
			const calls = h.resolveRuntimeHost.mock.calls
				.slice(before)
				.map(([input]) => input);
			// Agent-level fixture 没有 Session Sandbox route，保留完整三次解析和
			// 发送前复核；真实 Sandbox 路径单独复用最终 readiness proof。
			expect(calls.map((input) => input.command)).toEqual([
				"turn.submit",
				"turn.submit",
				"turn.submit",
				"turn.submit",
			]);
			expect(calls.map((input) => input.reuseSignedReadiness)).toEqual([
				true,
				true,
				undefined,
				true,
			]);
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
			if (field === "selection" && next.selection)
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

	describe("a stop accepted while the Key is being read (#2713)", () => {
		const submits = (h: ReturnType<typeof runtimeV4Harness>) =>
			h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/turns"));

		it.each([
			["before the Key read", 1],
			["after the decrypt, at the re-read", 2],
		] as const)(
			"rejects without sending, retryable and not sent, when the stop lands %s",
			async (_when, read) => {
				const h = runtimeV4Harness();
				try {
					const reference = await h.authorize();
					// Store 侧的取 Key 在 stop 待处理时不再返回已受理的 Execution。
					let reads = 0;
					h.executionKeys.readAcceptedExecution.mockImplementation(async () => {
						reads++;
						if (reads < read) return structuredClone(h.accepted());
						Object.assign(h.state, { stopPending: true });
						return null;
					});
					// 之前：不可重试的 RUNTIME_GRANT_INVALID，Core 把这条回复记为执行失败。
					await expect(
						h.runtime.runtimeHost.dispatch(h.request(reference)),
					).rejects.toMatchObject({
						code: "RUNTIME_ROUTE_STALE",
						retryable: true,
						notSent: true,
					});
					expect(submits(h)).toHaveLength(0);
				} finally {
					h.runtime.close();
				}
			},
		);

		it("marks a stop caught by the final pre-send check as not sent", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				h.relayKeyDecryptor.decrypt.mockImplementationOnce(async () => {
					Object.assign(h.state, { stopPending: true });
					const plaintext = new TextEncoder().encode(keySentinel);
					h.plaintexts.push(plaintext);
					return { outcome: "decrypted", plaintext };
				});
				await expect(
					h.runtime.runtimeHost.dispatch(h.request(reference)),
				).rejects.toMatchObject({
					code: "RUNTIME_ROUTE_STALE",
					retryable: true,
					notSent: true,
				});
				expect(submits(h)).toHaveLength(0);
				expect(h.plaintexts[0]?.every((byte) => byte === 0)).toBe(true);
			} finally {
				h.runtime.close();
			}
		});

		it("treats a revocation found when the Key read fails like one found during preparation", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				h.executionKeys.readAcceptedExecution.mockImplementationOnce(
					async () => {
						h.setUser(null);
						return null;
					},
				);
				// 撤销照旧被记录、请求照旧不发出；失败按确定未发送交还 Core，由撤销的 control 收口。
				await expect(
					h.runtime.runtimeHost.dispatch(h.request(reference)),
				).rejects.toMatchObject({ retryable: true, notSent: true });
				expect(submits(h)).toHaveLength(0);
				expect(h.taskAuthorizationStore.recordControl).toHaveBeenCalledWith(
					expect.objectContaining({ reason: "authorization_revoked" }),
				);
			} finally {
				h.runtime.close();
			}
		});

		it("never marks a failure once the request may have been sent", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				// 连接在请求发出后中断：Runtime 可能已经受理，不能让 Core 当作未发送而重发。
				h.fetcher.mockImplementationOnce(async () => {
					throw new TypeError("socket hang up");
				});
				const failure = await h.runtime.runtimeHost
					.dispatch(h.request(reference))
					.catch((error: unknown) => error);
				expect(failure).toMatchObject({
					code: "RUNTIME_UNAVAILABLE",
					retryable: true,
					notSent: false,
				});
				expect(submits(h)).toHaveLength(1);
			} finally {
				h.runtime.close();
			}
		});

		it("keeps an invalid acceptance with no state change a non-retryable grant failure", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				h.setAccepted(null);
				await expect(
					h.runtime.runtimeHost.dispatch(h.request(reference)),
				).rejects.toMatchObject({
					code: "RUNTIME_GRANT_INVALID",
					retryable: false,
				});
				expect(submits(h)).toHaveLength(0);
			} finally {
				h.runtime.close();
			}
		});
	});

	describe("a stop accepted while a submit to an unbound Session is prepared (#3199)", () => {
		// 与 Runtime assertOpen 一致：没有 hostSessionRef 的 stop 控制状态查询判为会话未绑定。
		const unbound = (traceId: string) =>
			Response.json(
				{
					schemaVersion: 1,
					code: "RUNTIME_SESSION_UNAVAILABLE",
					message: "Runtime session could not be recovered",
					retryable: false,
					traceId,
				},
				{ status: 503 },
			);
		const paths = (h: ReturnType<typeof runtimeV4Harness>) =>
			h.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);

		it.each([
			["submit", "turn", "conversation.turn.submit.v1"],
			["submit", "stop", "conversation.turn.submit.v1"],
			["regenerate", "turn", "conversation.turn.regenerate.v1"],
			["regenerate", "stop", "conversation.turn.regenerate.v1"],
		] as const)(
			"cancels the unsent %s instead of failing it when the %s work item is claimed next",
			async (_name, next, operation) => {
				const h = runtimeV4Harness();
				// 会话从未原生绑定：此前的提交都在发送前被停止，Conversation 没有 hostSessionRef。
				Object.assign(h.claim, {
					operation,
					executionStatus: "submitted",
					hostSessionRef: null,
				});
				Object.assign(h.state, {
					executionStatus: "submitted",
					hostSessionRef: null,
				});
				h.fetcher.mockImplementation(async (url, init) => {
					const body = JSON.parse(init?.body as string);
					if (String(url).endsWith("/status") && body.hostSessionRef === null)
						return unbound(body.traceId);
					throw new Error(`Unexpected Runtime request: ${String(url)}`);
				});
				// 只模拟这条路径用到的 PG Store 语义（见 platform-store 的 #2534/#2674 用例）。
				const outbox: Record<string, string> = {
					item: "pending",
					"stop-item": "pending",
				};
				let stop: "none" | "submitted" | "completed" = "none";
				const failures: string[] = [];
				const cancelStoppedTurn = () => {
					Object.assign(h.state, {
						executionStatus: "cancelled",
						stopPending: false,
					});
					outbox.item = "succeeded";
					outbox["stop-item"] = "succeeded";
					stop = "completed";
				};
				const store: ConversationDispatchStorePortV1 = {
					async claim({ itemId }) {
						const status = outbox[itemId];
						if (status === "succeeded" || status === "failed")
							return { outcome: status };
						if (
							itemId === "item" &&
							stop === "submitted" &&
							h.state.executionStatus === "submitted"
						) {
							// 认领看到 stop：在与认领互斥的事务里直接取消未投递的 Turn。
							cancelStoppedTurn();
							return { outcome: "succeeded" };
						}
						outbox[itemId] = "processing";
						const current = {
							executionStatus: h.state.executionStatus,
							stopPending: stop === "submitted",
						};
						return {
							outcome: "claimed",
							claim:
								itemId === "item"
									? { ...h.claim, ...current }
									: {
											...h.claim,
											...current,
											itemId,
											operation: "conversation.turn.stop.v1",
											messageId: null,
											stopRequestId: "stop",
											input: null,
											deliveryFence: 1,
										},
						};
					},
					renew: async () => true,
					async prepareRuntimeDispatch({ claim }) {
						if (claim.operation !== "conversation.turn.stop.v1") {
							// 发送前的 write-ahead 提交之后 stop 才被受理：Worker 准备时读到控制用途。
							Object.assign(h.state, {
								executionStatus: "unknown",
								stopPending: true,
							});
							stop = "submitted";
						}
						return true;
					},
					async releaseUnsentDispatch({ claim }) {
						Object.assign(h.state, { executionStatus: claim.executionStatus });
						outbox[claim.itemId] = "retry_scheduled";
						return true;
					},
					async cancelUnaccepted() {
						cancelStoppedTurn();
						return true;
					},
					async recordRuntimeResponse() {
						throw new Error("The Runtime never accepted this submit");
					},
					async retry({ claim, transition }) {
						if (transition.executionStatus)
							Object.assign(h.state, {
								executionStatus: transition.executionStatus,
							});
						outbox[claim.itemId] = "retry_scheduled";
						return true;
					},
					async finish({ claim, status, transition, errorCode }) {
						if (errorCode) failures.push(errorCode);
						if (transition.executionStatus)
							Object.assign(h.state, {
								executionStatus: transition.executionStatus,
							});
						if (
							claim.operation === "conversation.turn.stop.v1" &&
							status === "succeeded"
						)
							stop = "completed";
						outbox[claim.itemId] = status;
						return true;
					},
				};
				const useCase = createConversationDispatchUseCaseV1(
					{
						store,
						authorization: h.runtime.authorization,
						runtimeHost: h.runtime.runtimeHost,
						events: {
							async persist() {
								throw new Error("An unsent submit has no Runtime events");
							},
						},
					},
					{ retryDelayMs: 0 },
				);
				const dispatch = async (itemId: string) =>
					(
						await useCase.dispatch({
							schemaVersion: 1,
							itemId,
							workerId: "instance",
						})
					).outcome;
				try {
					const first = await dispatch("item");
					const later: string[] = [];
					for (const itemId of next === "turn"
						? ["item", "stop-item"]
						: ["stop-item", "item"])
						later.push(await dispatch(itemId));
					expect({
						first,
						later,
						execution: h.state.executionStatus,
						stop,
						outbox,
						failures,
						paths: paths(h),
					}).toEqual({
						first: "retry",
						later: ["already_completed", "already_completed"],
						execution: "cancelled",
						stop: "completed",
						outbox: { item: "succeeded", "stop-item": "succeeded" },
						failures: [],
						// 只有发送前的 latch 状态查询，Runtime 没有收到任何 turns 请求。
						paths: ["/internal/runtime/v3/status"],
					});
				} finally {
					h.runtime.close();
				}
			},
		);

		it.each([
			["a bound Session", { hostSessionRef: "host" }],
			[
				"an original submit reference",
				{ hostSessionRef: null, originalSubmitHostSessionRef: "host" },
			],
		] as const)(
			"keeps a latch failure on %s for the existing recovery",
			async (_name, refs) => {
				const h = runtimeV4Harness();
				Object.assign(h.claim, {
					executionStatus: "submitted",
					hostSessionRef: refs.hostSessionRef,
				});
				Object.assign(h.state, { executionStatus: "submitted", ...refs });
				h.fetcher.mockImplementation(async (url, init) => {
					const body = JSON.parse(init?.body as string);
					if (String(url).endsWith("/status")) return unbound(body.traceId);
					throw new Error(`Unexpected Runtime request: ${String(url)}`);
				});
				try {
					const reference = await h.authorize();
					Object.assign(h.state, {
						executionStatus: "unknown",
						stopPending: true,
					});
					// 可能已发送：不改成「确定未发送」，交给 Core 现有的核实与恢复。
					await expect(
						h.runtime.runtimeHost.dispatch(h.request(reference)),
					).rejects.toMatchObject({
						code: "RUNTIME_SESSION_UNAVAILABLE",
						retryable: false,
						notSent: false,
					});
					expect(paths(h)).toEqual(["/internal/runtime/v3/status"]);
				} finally {
					h.runtime.close();
				}
			},
		);

		it("keeps the latched denial when the bound Session latch succeeds", async () => {
			const h = runtimeV4Harness();
			Object.assign(h.claim, { executionStatus: "submitted" });
			Object.assign(h.state, { executionStatus: "submitted" });
			try {
				const reference = await h.authorize();
				Object.assign(h.state, {
					executionStatus: "unknown",
					stopPending: true,
				});
				await expect(
					h.runtime.runtimeHost.dispatch(h.request(reference)),
				).rejects.toMatchObject({
					code: "AUTHORIZATION_REVOKED",
					retryable: true,
					notSent: false,
				});
				expect(paths(h)).toEqual(["/internal/runtime/v3/status"]);
				const latch = h.sent().body;
				expect(latch.hostSessionRef).toBe("host");
				expect(verifyControl(latch.grant).claims).toMatchObject({
					purpose: "control",
					reason: "stop",
					allowedCommands: ["session.status"],
				});
			} finally {
				h.runtime.close();
			}
		});
	});

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

	it("lets the consumer commit buffered events before every read and reads from that cursor (#3443)", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			const order: string[] = [];
			h.fetcher.mockImplementation(async (_url, init) => {
				const body = JSON.parse(init?.body as string);
				order.push(`read:${body.afterCursor}`);
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
			let reads = 0;
			const beforeRead = vi.fn(async () => {
				reads++;
				order.push(`commit:${reads}`);
				// 第二次读取前消费方提交了第一页的两个事件。
				if (reads === 2)
					Object.assign(h.state, { runtimeCursor: "tool-cursor" });
			});
			const events: unknown[] = [];
			for await (const event of h.runtime.runtimeHost.events(
				h.events(reference),
				undefined,
				{ beforeRead },
			))
				events.push(event);
			expect(events).toEqual([modelFact, toolFact, terminal]);
			expect(order).toEqual([
				"commit:1",
				"read:null",
				"commit:2",
				"read:tool-cursor",
			]);
		} finally {
			h.runtime.close();
		}
	});

	it("does not read when committing buffered events fails (#3443)", async () => {
		const h = runtimeV4Harness();
		try {
			const reference = await h.authorize();
			const failure = new Error("buffered commit failed");
			const stream = h.runtime.runtimeHost
				.events(h.events(reference), undefined, {
					beforeRead: async () => {
						throw failure;
					},
				})
				[Symbol.asyncIterator]();
			await expect(stream.next()).rejects.toBe(failure);
			expect(h.fetcher).not.toHaveBeenCalled();
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

	describe("a stop accepted while an event step is being prepared (#2712)", () => {
		/** 每次事件读取都返回 Runtime 已经给出的终态（停止之后 Host 交回的取消）。 */
		const terminalReads = (h: ReturnType<typeof runtimeV4Harness>) =>
			h.fetcher.mockImplementation(async (url, init) => {
				const body = JSON.parse(init?.body as string);
				if (String(url).endsWith("/events/ack"))
					return Response.json({
						schemaVersion: body.schemaVersion,
						executionId: "execution",
						confirmedCursor: body.confirmedCursor,
					});
				return Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					executionId: "execution",
					events: [terminal],
				});
			});
		/** 第 n 次路由解析时 stop 被受理：授权目的在同一次准备的两次检查之间从 business 变成 control。 */
		const stopDuringRoute = (
			h: ReturnType<typeof runtimeV4Harness>,
			n: number,
		) => {
			let calls = 0;
			h.resolveRuntimeHost.mockImplementation(async () => {
				calls++;
				if (calls === n) Object.assign(h.state, { stopPending: true });
				return { ...h.target };
			});
		};
		const reads = (h: ReturnType<typeof runtimeV4Harness>) =>
			h.fetcher.mock.calls
				.filter(([url]) => String(url).endsWith("/events/read"))
				.map(([, init]) => JSON.parse(init?.body as string));

		it.each([
			["the first route observation", 1],
			["the last route observation", 3],
		] as const)(
			"keeps draining under the stop control Grant when the stop lands during %s",
			async (_where, n) => {
				const h = runtimeV4Harness();
				try {
					const reference = await h.authorize();
					terminalReads(h);
					stopDuringRoute(h, n);
					const stream = h.runtime.runtimeHost
						.events(h.events(reference))
						[Symbol.asyncIterator]();
					// 之前：这次准备以 RUNTIME_ROUTE_STALE 失败，整次排空退回 Core 按退避重试，
					// Runtime 上的 Turn 继续跑完（停止丢失）。
					expect((await stream.next()).value).toEqual(terminal);
					expect(reads(h)).toHaveLength(1);
					expect(verifyControl(reads(h)[0]?.grant).claims).toMatchObject({
						purpose: "control",
						reason: "stop",
						controlRecordId: "control-stop",
					});
					expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
					await stream.return?.();
				} finally {
					h.runtime.close();
				}
			},
		);

		it("keeps draining under the recovery control Grant when a Host-confirmed finish is recorded during the preparation", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				terminalReads(h);
				let calls = 0;
				h.resolveRuntimeHost.mockImplementation(async () => {
					calls++;
					if (calls === 1)
						Object.assign(h.state, { executionStatus: "completed" });
					return { ...h.target };
				});
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				expect((await stream.next()).value).toEqual(terminal);
				expect(verifyControl(reads(h)[0]?.grant).claims).toMatchObject({
					purpose: "control",
					reason: "recovery",
				});
				await stream.return?.();
			} finally {
				h.runtime.close();
			}
		});

		it("marks only the first two control route resolutions as readiness preflight", async () => {
			const h = runtimeV4Harness();
			try {
				Object.assign(h.state, { stopPending: true });
				const reference = await h.authorize();
				terminalReads(h);
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				expect((await stream.next()).value).toEqual(terminal);
				const controlCalls = h.resolveRuntimeHost.mock.calls
					.map(([input]) => input)
					.filter((input) => input.purpose === "control");
				expect(controlCalls).toHaveLength(3);
				expect(
					controlCalls.slice(0, 3).map((input) => input.skipControlReadiness),
				).toEqual([true, true, undefined]);
				await stream.return?.();
			} finally {
				h.runtime.close();
			}
		});

		it.each(
			(["cursor", "terminal", "host", "barrier"] as const).flatMap((change) =>
				([1, 2, 3] as const).map((read) => [change, read] as const),
			),
		)(
			"rechecks %s at state read %s after final readiness before stop send",
			async (change, read) => {
				const h = runtimeV4Harness("stop");
				try {
					Object.assign(h.state, { stopPending: true });
					const reference = await h.authorize();
					let readsAfterRoutes = 0;
					h.dispatchStore.readRuntimeState.mockImplementation(async () => {
						// First read after route 3 becomes prepared.state. The next
						// read starts the stop's send-time authorization recheck.
						if (
							h.resolveRuntimeHost.mock.calls.length === 3 &&
							++readsAfterRoutes === read
						) {
							if (change === "cursor")
								Object.assign(h.state, { runtimeCursor: "cursor-advanced" });
							else if (change === "terminal")
								Object.assign(h.state, { executionStatus: "completed" });
							else if (change === "host")
								Object.assign(h.state, { hostSessionRef: "replacement-host" });
							else Object.assign(h.state, { stopPending: false });
						}
						return h.state;
					});
					const dispatch = h.runtime.runtimeHost.dispatch(h.request(reference));
					if (change === "cursor") {
						await expect(dispatch).resolves.toMatchObject({
							result: { outcome: "accepted" },
						});
						expect(h.fetcher).toHaveBeenCalledTimes(1);
						expect(h.sent().url).toContain("/stops");
					} else {
						await expect(dispatch).rejects.toMatchObject({
							code: expect.stringMatching(/^RUNTIME_(FENCE|ROUTE)_STALE$/),
							notSent: true,
						});
						expect(h.fetcher).not.toHaveBeenCalled();
					}
				} finally {
					h.runtime.close();
				}
			},
		);

		it("ACKs under the stop control Grant when the stop lands during the ACK's preparation", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				terminalReads(h);
				// ACK 只确认 Platform 已提交的游标。
				Object.assign(h.state, { runtimeCursor: "terminal-cursor" });
				stopDuringRoute(h, 1);
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(reference),
					confirmedCursor: "terminal-cursor",
				});
				const acksSent = h.fetcher.mock.calls.filter(([url]) =>
					String(url).endsWith("/events/ack"),
				);
				expect(acksSent).toHaveLength(1);
				expect(
					verifyControl(JSON.parse(acksSent[0]?.[1]?.body as string).grant)
						.claims,
				).toMatchObject({ purpose: "control", reason: "stop" });
			} finally {
				h.runtime.close();
			}
		});

		it("ACKs under the stop control Grant when the stop lands between the ACK's preparation and its send", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				terminalReads(h);
				Object.assign(h.state, { runtimeCursor: "terminal-cursor" });
				// 准备做完三次路由解析之后，第二次读状态发生在发送前的复核里：stop 在这时被受理。
				let routes = 0;
				let statesAfterRoutes = 0;
				h.resolveRuntimeHost.mockImplementation(async () => {
					routes++;
					return { ...h.target };
				});
				h.dispatchStore.readRuntimeState.mockImplementation(async () => {
					if (routes >= 3 && ++statesAfterRoutes === 2)
						Object.assign(h.state, { stopPending: true });
					return h.state;
				});
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(reference),
					confirmedCursor: "terminal-cursor",
				});
				const acksSent = h.fetcher.mock.calls.filter(([url]) =>
					String(url).endsWith("/events/ack"),
				);
				expect(acksSent).toHaveLength(1);
				expect(
					verifyControl(JSON.parse(acksSent[0]?.[1]?.body as string).grant)
						.claims,
				).toMatchObject({ purpose: "control", reason: "stop" });
			} finally {
				h.runtime.close();
			}
		});

		it("still fails the step for a route change that is not a stop", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				terminalReads(h);
				// 最后一次路由解析换了目标：真正的路由变化，没有 stop，也没有终态。
				let calls = 0;
				h.resolveRuntimeHost.mockImplementation(async () => {
					calls++;
					return calls === 3
						? { ...h.target, serviceToken: "rotated-service-token" }
						: { ...h.target };
				});
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				await expect(stream.next()).rejects.toMatchObject({
					code: "RUNTIME_ROUTE_STALE",
				});
				expect(reads(h)).toHaveLength(0);
			} finally {
				h.runtime.close();
			}
		});

		it("re-prepares a control drain when stop delivery changes the fence", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				Object.assign(h.state, { stopPending: true });
				let reads = 0;
				h.fetcher.mockImplementation(async (url, init) => {
					if (String(url).endsWith("/events/read") && reads++ === 0) {
						Object.assign(h.state, {
							stopPending: false,
							executionStatus: "cancelled",
						});
						return Response.json(
							{
								schemaVersion: 1,
								code: "RUNTIME_FENCE_STALE",
								message: "Runtime fence is stale",
								retryable: true,
								traceId: "trace",
							},
							{ status: 409 },
						);
					}
					const body = JSON.parse(init?.body as string);
					return Response.json({
						schemaVersion: 4,
						hostSessionRef: "host",
						executionId: "execution",
						events: [terminal],
						...(String(url).endsWith("/events/ack")
							? { confirmedCursor: body.confirmedCursor }
							: {}),
					});
				});
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				expect((await stream.next()).value).toEqual(terminal);
				expect(reads).toBe(2);
				await stream.return?.();
			} finally {
				h.runtime.close();
			}
		});

		it("keeps draining when the stop is delivered during a control read's pre-send check (#2720)", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				// 与 a4db4f8c 一致：stop 已受理、stop 控制记录已签发（Host 已被闩住），Execution 仍在处理中。
				Object.assign(h.state, {
					stopPending: true,
					latchedControlReason: "stop",
				});
				// 真实 Store 每次读取都返回新的快照：翻转只影响之后的读取，不改变已读出的状态。
				h.dispatchStore.readRuntimeState.mockImplementation(async () =>
					structuredClone(h.state),
				);
				let served = 0;
				let deliverStop = false;
				h.fetcher.mockImplementation(async (url) => {
					if (String(url).endsWith("/events/read")) served++;
					// 第一页读完之后，下一次读取的发送前复核期间 stop 被送达。
					if (served === 1) deliverStop = true;
					return Response.json({
						schemaVersion: 4,
						hostSessionRef: "host",
						executionId: "execution",
						events: served === 1 ? [modelFact] : [terminal],
					});
				});
				const resolveUser = h.directory.resolveUser.getMockImplementation();
				h.directory.resolveUser.mockImplementation(async (...args) => {
					if (deliverStop) {
						deliverStop = false;
						// stop 条目成功：Store 把 stop 记为 completed（stopPending 翻为 false），
						// Execution 要等 Runtime 的终态事件落库才结束。
						Object.assign(h.state, { stopPending: false });
					}
					return resolveUser?.(...args) ?? null;
				});
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				expect((await stream.next()).value).toEqual(modelFact);
				// 之前：发送前复核以 RUNTIME_FENCE_STALE 失败，stop 已不再待处理、Execution 也没结束，
				// 这次失败被交还 Core 退避重试（a4db4f8c 停止到结束 9.7 秒）。
				expect((await stream.next()).value).toEqual(terminal);
				expect(served).toBe(2);
				await stream.return?.();
			} finally {
				h.runtime.close();
			}
		});

		it("ACKs once when the stop is delivered between the ACK's preparation and its send (#2720)", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				Object.assign(h.state, {
					stopPending: true,
					latchedControlReason: "stop",
					runtimeCursor: "terminal-cursor",
				});
				terminalReads(h);
				let routes = 0;
				let statesAfterRoutes = 0;
				h.resolveRuntimeHost.mockImplementation(async () => {
					routes++;
					return { ...h.target };
				});
				h.dispatchStore.readRuntimeState.mockImplementation(async () => {
					// 准备做完三次路由解析之后，发送前复核读状态时 stop 已送达。
					if (routes >= 3 && ++statesAfterRoutes === 2)
						Object.assign(h.state, { stopPending: false });
					return structuredClone(h.state);
				});
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(reference),
					confirmedCursor: "terminal-cursor",
				});
				expect(
					h.fetcher.mock.calls.filter(([url]) =>
						String(url).endsWith("/events/ack"),
					),
				).toHaveLength(1);
			} finally {
				h.runtime.close();
			}
		});

		it("returns a control fence failure after the bounded reprepare limit", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				Object.assign(h.state, { stopPending: true });
				h.fetcher.mockImplementation(async (url) => {
					if (String(url).endsWith("/events/read")) {
						Object.assign(h.state, {
							stopPending: false,
							executionStatus: "cancelled",
						});
						return Response.json(
							{
								schemaVersion: 1,
								code: "RUNTIME_FENCE_STALE",
								message: "Runtime fence is stale",
								retryable: true,
								traceId: "trace",
							},
							{ status: 409 },
						);
					}
					return Response.json({
						schemaVersion: 4,
						hostSessionRef: "host",
						executionId: "execution",
						events: [],
					});
				});
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				await expect(stream.next()).rejects.toMatchObject({
					code: "RUNTIME_FENCE_STALE",
				});
				expect(
					h.fetcher.mock.calls.filter(([url]) =>
						String(url).endsWith("/events/read"),
					).length,
				).toBe(4);
			} finally {
				h.runtime.close();
			}
		});

		it("gives up after a bounded number of preparations that keep going stale", async () => {
			const h = runtimeV4Harness();
			try {
				const reference = await h.authorize();
				terminalReads(h);
				Object.assign(h.state, { stopPending: true });
				// 每次准备的最后一次路由解析都换目标：stop 已经待处理，但准备永远过期。
				let calls = 0;
				h.resolveRuntimeHost.mockImplementation(async () => {
					calls++;
					return calls % 3 === 0
						? { ...h.target, serviceToken: `rotated-${calls}` }
						: { ...h.target };
				});
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				await expect(stream.next()).rejects.toMatchObject({
					code: "RUNTIME_ROUTE_STALE",
				});
				expect(reads(h)).toHaveLength(0);
				// 三次准备、每次三次路由解析，然后把失败交还 Core。
				expect(calls).toBe(9);
			} finally {
				h.runtime.close();
			}
		});
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
				// Agent-level fixture retains the full route check; Session Sandbox
				// preparation has the bounded proof reuse.
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
				: String(url).endsWith("/authorizations/renew")
					? // The resumed drain renews the running Turn's authority first (#1888).
						Response.json({
							schemaVersion: 3,
							executionId: "execution",
							expiresAt: Date.now() + 30_000,
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
