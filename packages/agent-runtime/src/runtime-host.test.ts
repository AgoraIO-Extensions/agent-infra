import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	ExecutionGrantCommandV1,
	ExecutionGrantV1,
	RuntimeEvent,
	RuntimeSubmitTurnRequestV1,
	RuntimeSubmitTurnRequestV2,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDriver } from "./driver.js";
import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import { FakeRuntimeDriver, FileRuntimeStore, RuntimeHost } from "./index.js";

const directories: string[] = [];

async function runtimeDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "agent-runtime-conformance-"));
	directories.push(directory);
	return directory;
}

function grant(
	request: Pick<
		RuntimeSubmitTurnRequestV1,
		| "agentId"
		| "actorId"
		| "channelId"
		| "conversationId"
		| "executionId"
		| "turnId"
		| "sessionGeneration"
		| "traceId"
	>,
	operations: ExecutionGrantCommandV1[],
): ExecutionGrantV1 {
	return runtimeGrantFixture(request, operations, {
		actionSetVersion: "actions-conformance",
	});
}

function submitRequest(): RuntimeSubmitTurnRequestV1 {
	const binding = {
		agentId: "agent-conformance",
		actorId: "actor-conformance",
		channelId: "web",
		conversationId: "conversation-conformance",
		executionId: "execution-conformance-1",
		turnId: "turn-conformance-1",
		sessionGeneration: 1,
		traceId: "trace-conformance",
	};
	return {
		schemaVersion: 1,
		requestId: "request-conformance-1",
		...binding,
		deliveryFence: 1,
		grant: grant(binding, ["turn.submit"]),
		input: { text: "synthetic-conformance-input", attachments: [] },
	};
}

function submitRequestV2(): RuntimeSubmitTurnRequestV2 {
	return {
		...submitRequest(),
		schemaVersion: 2,
		selection: {
			schemaVersion: 1,
			modelOptionId: "model-option-primary",
			reasoningLevel: "high",
		},
	};
}

function statusRequest(
	request: RuntimeSubmitTurnRequestV1 | RuntimeSubmitTurnRequestV2,
	hostSessionRef: string,
	requestId: string,
	deliveryFence = request.deliveryFence,
) {
	return {
		schemaVersion: 1 as const,
		requestId,
		traceId: request.traceId,
		actorId: request.actorId,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		deliveryFence,
		hostSessionRef,
		grant: grant(request, ["session.status"]),
	};
}

function recoveryStatusRequest(
	request: RuntimeSubmitTurnRequestV1 | RuntimeSubmitTurnRequestV2,
	hostSessionRef: string,
	requestId: string,
	deliveryFence: number,
) {
	return {
		...statusRequest(request, hostSessionRef, requestId, deliveryFence),
		schemaVersion: 2 as const,
		recovery: {
			schemaVersion: 1 as const,
			input: request.input,
			...(request.schemaVersion === 2 ? { selection: request.selection } : {}),
		},
		grant: grant(request, ["session.status", "turn.submit"]),
	};
}

function host(store: FileRuntimeStore, driver: FakeRuntimeDriver) {
	return RuntimeHost.open({
		store,
		driver,
		grantValidation: {
			expectedIssuer: "agent-platform",
			now: () => "2026-08-28T10:00:00Z",
		},
	}).then(ingressVerifiedRuntimeHost);
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true })),
	);
});

describe("RuntimeHost durable Session", () => {
	it.each([
		"mixed",
		"invalid operation",
		"invalid V1",
		"foreign operation",
		"foreign V1",
	])(
		"validates %s events before filtering V1 replay and stream",
		async (scenario) => {
			const directory = await runtimeDirectory();
			const driver = await FakeRuntimeDriver.open(
				join(directory, "driver.json"),
			);
			const eventDriver: RuntimeDriver = driver;
			const store = await FileRuntimeStore.open(join(directory, "host.json"));
			const runtimeHost = await host(store, driver);
			const submittedRequest = submitRequest();
			const submitted = await runtimeHost.submitTurn(submittedRequest);
			const nativeSessionRef = store.nativeSessionRef(submitted.hostSessionRef);
			const request = {
				...statusRequest(
					submittedRequest,
					submitted.hostSessionRef,
					"request-events",
				),
				afterCursor: "cursor-before",
				grant: grant(submittedRequest, ["events.replay"]),
			};
			const base = {
				executionId: request.executionId,
				occurredAt: "2026-08-28T10:00:00Z",
			};
			const events: RuntimeEvent[] = [
				{
					...base,
					schemaVersion: 1,
					adapterEventKey: "event-running",
					cursor: "cursor-running",
					type: "status",
					payload: { status: "running" },
				},
				{
					...base,
					schemaVersion: 2,
					adapterEventKey: "event-operation",
					cursor: "cursor-operation",
					type: "operation",
					payload: {
						kind: "tool",
						operationRef: "operation-original",
						attemptRef: "attempt-original",
						phase: "intent",
						toolId: "synthetic-tool",
					},
				},
				{
					...base,
					schemaVersion: 1,
					adapterEventKey: "event-text",
					cursor: "cursor-text",
					type: "text",
					payload: { delta: "synthetic-event-after-operation" },
				},
			];
			const operation = events[1];
			if (operation?.type !== "operation")
				throw new Error("Missing fixture operation");
			if (scenario === "invalid operation") operation.payload.operationRef = "";
			if (scenario === "foreign operation")
				operation.executionId = "other-execution";
			const text = events[2];
			if (text?.type !== "text") throw new Error("Missing fixture text");
			if (scenario === "invalid V1") text.payload.delta = "";
			if (scenario === "foreign V1") text.executionId = "other-execution";
			const replay = vi
				.spyOn(eventDriver, "replayEvents")
				.mockResolvedValue(events);
			let streamClosed = false;
			const subscribe = vi
				.spyOn(eventDriver, "subscribeEvents")
				.mockResolvedValue(
					(async function* () {
						try {
							yield* events;
						} finally {
							streamClosed = true;
						}
					})(),
				);
			if (scenario === "mixed") {
				await expect(runtimeHost.replay(request)).resolves.toEqual({
					schemaVersion: 1,
					events: [events[0], events[2]],
				});
			} else {
				await expect(runtimeHost.replay(request)).rejects.toMatchObject({
					code: "RUNTIME_DRIVER_INVALID",
				});
			}
			const signal = new AbortController().signal;
			const stream = await runtimeHost.streamEvents(request, signal);
			const iterator = stream[Symbol.asyncIterator]();
			await expect(iterator.next()).resolves.toEqual({
				done: false,
				value: events[0],
			});
			if (scenario === "mixed") {
				await expect(iterator.next()).resolves.toEqual({
					done: false,
					value: events[2],
				});
				await expect(iterator.next()).resolves.toEqual({
					done: true,
					value: undefined,
				});
			} else {
				await expect(iterator.next()).rejects.toMatchObject({
					code: "RUNTIME_DRIVER_INVALID",
				});
			}
			expect(streamClosed).toBe(true);
			expect(replay).toHaveBeenCalledExactlyOnceWith(
				nativeSessionRef,
				request.executionId,
				request.afterCursor,
			);
			expect(subscribe).toHaveBeenCalledExactlyOnceWith(
				nativeSessionRef,
				request.executionId,
				request.afterCursor,
				signal,
			);
			const denied = {
				...request,
				grant: grant(submittedRequest, ["session.status"]),
			};
			await expect(runtimeHost.replay(denied)).rejects.toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
			});
			await expect(runtimeHost.streamEvents(denied)).rejects.toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
			});
			expect(replay).toHaveBeenCalledTimes(1);
			expect(subscribe).toHaveBeenCalledTimes(1);
		},
	);

	it("rejects legacy requests after close and keeps close idempotent", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await RuntimeHost.open({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});

		await runtimeHost.close();
		await expect(runtimeHost.close()).resolves.toBeUndefined();
		await expect(
			runtimeHost.submitTurn(submitRequest(), undefined),
		).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
	});

	it("binds V2 selection to replay and isolates consecutive Executions", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const store = await FileRuntimeStore.open(join(directory, "host.json"));
		const runtimeHost = await host(store, driver);
		const first = submitRequestV2();
		const accepted = await runtimeHost.submitTurnV2(first);

		expect(accepted).toMatchObject({
			schemaVersion: 2,
			result: { outcome: "accepted", status: "running" },
		});
		const nativeSessionRef = store.nativeSessionRef(accepted.hostSessionRef);
		expect(
			driver.selectionForExecution(
				nativeSessionRef ?? "missing-native-session",
				first.executionId,
			),
		).toEqual(first.selection);
		expect(
			await runtimeHost.submitTurnV2({
				...first,
				requestId: "request-conformance-v2-replay",
			}),
		).toEqual(accepted);
		await expect(
			runtimeHost.submitTurnV2({
				...first,
				requestId: "request-conformance-v2-conflict",
				selection: {
					...first.selection,
					reasoningLevel: "low",
				},
			}),
		).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
		await expect(
			runtimeHost.recoverStatusV2(
				recoveryStatusRequest(
					first,
					accepted.hostSessionRef,
					"request-conformance-v2-status-recovery",
					2,
				),
			),
		).resolves.toMatchObject({ outcome: "found", status: "running" });
		const conflictingRecovery = recoveryStatusRequest(
			first,
			accepted.hostSessionRef,
			"request-conformance-v2-status-conflict",
			3,
		);
		await expect(
			runtimeHost.recoverStatusV2({
				...conflictingRecovery,
				recovery: {
					...conflictingRecovery.recovery,
					selection: {
						...first.selection,
						reasoningLevel: "low",
					},
				},
			}),
		).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
		expect(await driver.sideEffectCount()).toBe(1);

		await driver.setOperationStatus(first.executionId, "completed");
		const secondBinding = {
			...first,
			executionId: "execution-conformance-2",
			turnId: "turn-conformance-2",
		};
		const second = {
			...secondBinding,
			requestId: "request-conformance-v2-second",
			hostSessionRef: accepted.hostSessionRef,
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "model-option-alternate",
				reasoningLevel: "low",
			},
			grant: grant(secondBinding, ["turn.submit"]),
		};
		expect((await runtimeHost.submitTurnV2(second)).result).toMatchObject({
			outcome: "accepted",
		});
		expect(
			driver.selectionForExecution(
				nativeSessionRef ?? "missing-native-session",
				second.executionId,
			),
		).toEqual(second.selection);
		expect(
			driver.selectionForExecution(
				nativeSessionRef ?? "missing-native-session",
				first.executionId,
			),
		).toEqual(first.selection);
	});

	it("rejects unsupported V2 selection without a Runtime side effect", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
		);
		const request = submitRequestV2();

		const unsupported = {
			...request,
			selection: {
				...request.selection,
				modelOptionId: "model-option-unsupported",
			},
		};
		const rejected = await runtimeHost.submitTurnV2(unsupported);
		expect(rejected.result).toEqual({
			outcome: "rejected",
			code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
			message: "Runtime model selection is unsupported",
			retryable: false,
		});
		expect(
			await runtimeHost.submitTurnV2({
				...unsupported,
				requestId: "request-conformance-v2-unsupported-replay",
			}),
		).toEqual(rejected);
		expect(await driver.sideEffectCount()).toBe(0);
	});

	it("accepts only ingress-verified canonical Grants before Driver side effects", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await RuntimeHost.open({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const request = {
			...submitRequest(),
			actorId: "actor-conformance",
			channelId: "web",
			traceId: "trace-conformance",
			grant: {
				schemaVersion: 1,
				format: "compact-jws",
				token: "header.payload.signature",
			},
		} as const;
		const claims = {
			schemaVersion: 1,
			issuer: "agent-platform",
			audience: ["runtime_host"],
			issuedAt: "2026-08-28T09:59:00Z",
			expiresAt: "2026-08-28T10:01:00Z",
			grantId: "grant-canonical",
			agentId: request.agentId,
			actorId: request.actorId,
			channelId: request.channelId,
			conversationId: request.conversationId,
			turnId: request.turnId,
			executionId: request.executionId,
			sessionGeneration: request.sessionGeneration,
			allowedCommands: ["turn.submit"],
			attachments: [],
			actionSetVersion: "actions-conformance",
			actionIds: [],
			traceId: request.traceId,
		} as const;

		expect(
			await runtimeHost.submitTurn(request, {
				token: request.grant.token,
				claims,
			}),
		).toMatchObject({ result: { outcome: "accepted" } });
		expect(await driver.sideEffectCount()).toBe(1);

		for (const verification of [
			{ token: "other.payload.signature", claims },
			{
				token: request.grant.token,
				claims: { ...claims, audience: ["connection_api"] },
			},
			{
				token: request.grant.token,
				claims: { ...claims, allowedCommands: ["session.status"] },
			},
			...(
				[
					"agentId",
					"actorId",
					"channelId",
					"conversationId",
					"turnId",
					"executionId",
					"traceId",
				] as const
			).map((binding) => ({
				token: request.grant.token,
				claims: { ...claims, [binding]: `other-${binding}` },
			})),
			{
				token: request.grant.token,
				claims: { ...claims, sessionGeneration: 2 },
			},
		]) {
			await expect(
				runtimeHost.submitTurn(request, verification),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		}
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("recovers the same opaque Host Session after Host and Driver restart", async () => {
		const directory = await runtimeDirectory();
		const firstHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			await FakeRuntimeDriver.open(join(directory, "driver.json")),
		);
		const submitted = await firstHost.submitTurn(submitRequest());

		expect(submitted).toMatchObject({
			schemaVersion: 1,
			operationId: "execution-conformance-1",
			result: { outcome: "accepted", status: "running" },
		});
		expect(submitted.hostSessionRef).not.toContain("native");
		expect(JSON.stringify(submitted)).not.toMatch(
			/native|vendor|stdio|protocol/i,
		);

		const restartedDriver = await FakeRuntimeDriver.open(
			join(directory, "driver.json"),
		);
		const restartedHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			restartedDriver,
		);
		const binding = submitRequest();
		const status = await restartedHost.status(
			statusRequest(
				binding,
				submitted.hostSessionRef,
				"request-conformance-status",
			),
		);

		expect(status).toEqual({
			schemaVersion: 1,
			hostSessionRef: submitted.hostSessionRef,
			executionId: "execution-conformance-1",
			status: "running",
		});
		await expect(
			restartedHost.recoverStatusV2(
				recoveryStatusRequest(
					binding,
					submitted.hostSessionRef,
					"request-conformance-status-takeover",
					2,
				),
			),
		).resolves.toMatchObject({ outcome: "found", status: "running" });
		await expect(
			restartedHost.status(
				statusRequest(
					binding,
					submitted.hostSessionRef,
					"request-conformance-status-stale",
				),
			),
		).rejects.toMatchObject({ code: "RUNTIME_FENCE_STALE" });
		expect(await restartedDriver.sideEffectCount()).toBe(1);
	});

	it("persists an idle fence before confirming a Turn was never accepted", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
		);
		const submitted = await runtimeHost.submitTurn(submitRequest());
		const missing = {
			...submitRequest(),
			requestId: "request-conformance-missing-status",
			executionId: "execution-conformance-missing",
			turnId: "turn-conformance-missing",
			deliveryFence: 2,
		};

		await expect(
			runtimeHost.recoverStatusV2(
				recoveryStatusRequest(
					missing,
					submitted.hostSessionRef,
					missing.requestId,
					missing.deliveryFence,
				),
			),
		).resolves.toMatchObject({ outcome: "not_found" });
		await expect(
			runtimeHost.submitTurn({
				...missing,
				hostSessionRef: submitted.hostSessionRef,
				grant: grant(missing, ["turn.submit"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_FENCE_STALE" });
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("namespaces identical operation IDs across Sessions", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
		);
		const first = submitRequest();
		const secondBinding = {
			...first,
			requestId: "request-conformance-collision",
			conversationId: "conversation-conformance-other",
			turnId: "turn-conformance-other",
		};
		const second = {
			...secondBinding,
			grant: grant(secondBinding, ["turn.submit"]),
		};

		const firstResult = await runtimeHost.submitTurn(first);
		const secondResult = await runtimeHost.submitTurn(second);

		expect(secondResult.hostSessionRef).not.toBe(firstResult.hostSessionRef);
		expect(secondResult.result).toMatchObject({ outcome: "accepted" });
		expect(await driver.sideEffectCount()).toBe(2);
	});

	it("drives the Fake Session, Turn, event, stop, status, and capability path", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
		);
		const submittedRequest = submitRequest();
		const submitted = await runtimeHost.submitTurn(submittedRequest);
		const base = {
			schemaVersion: 1 as const,
			traceId: submittedRequest.traceId,
			actorId: submittedRequest.actorId,
			channelId: submittedRequest.channelId,
			agentId: submittedRequest.agentId,
			conversationId: submittedRequest.conversationId,
			executionId: submittedRequest.executionId,
			turnId: submittedRequest.turnId,
			sessionGeneration: submittedRequest.sessionGeneration,
		};

		const capabilities = await runtimeHost.capabilities({
			...base,
			requestId: "request-capabilities",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(base, ["capabilities.read"]),
		});
		expect(capabilities.capabilities).toMatchObject({
			attachments: true,
			supplementaryInstruction: true,
		});

		const initialReplay = await runtimeHost.replay({
			...base,
			requestId: "request-replay-1",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(base, ["events.replay"]),
		});
		expect(initialReplay.events).toEqual([
			expect.objectContaining({
				adapterEventKey: "fake-event-1",
				type: "status",
				payload: { status: "running" },
			}),
		]);

		const supplemented = await runtimeHost.supplement({
			...base,
			requestId: "request-supplement-1",
			deliveryFence: 1,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			messageId: "message-supplement-1",
			grant: grant(base, ["turn.supplement"]),
			input: { text: "synthetic-supplement", attachments: [] },
		});
		expect(supplemented.result).toEqual({
			outcome: "accepted",
			status: "running",
		});

		const replayed = await runtimeHost.replay({
			...base,
			requestId: "request-replay-2",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			afterCursor: initialReplay.events[0]?.cursor,
			grant: grant(base, ["events.replay"]),
		});
		expect(replayed.events).toEqual([
			expect.objectContaining({
				type: "text",
				payload: { delta: "synthetic-supplement-accepted" },
			}),
		]);

		const secondBinding = {
			...base,
			executionId: "execution-conformance-2",
			turnId: "turn-conformance-2",
		};
		const busy = await runtimeHost.submitTurn({
			...secondBinding,
			requestId: "request-busy",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(secondBinding, ["turn.submit"]),
			input: { text: "synthetic-busy-input", attachments: [] },
		});
		expect(busy.result).toEqual({ outcome: "busy" });

		const stopped = await runtimeHost.stop({
			...base,
			requestId: "request-stop-1",
			deliveryFence: 1,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			stopRequestId: "stop-1",
			grant: grant(base, ["turn.stop"]),
		});
		expect(stopped.result).toEqual({
			outcome: "accepted",
			status: "cancelled",
		});

		const stoppedAgain = await runtimeHost.stop({
			...base,
			requestId: "request-stop-retry",
			deliveryFence: 2,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			stopRequestId: "stop-1",
			grant: grant(base, ["turn.stop"]),
		});
		expect(stoppedAgain).toEqual(stopped);
		expect(await driver.sideEffectCount()).toBe(3);

		const status = await runtimeHost.status({
			...base,
			requestId: "request-status-cancelled",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(base, ["session.status"]),
		});
		expect(status.status).toBe("cancelled");

		const rejected = await runtimeHost.supplement({
			...base,
			requestId: "request-supplement-rejected",
			deliveryFence: 1,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			messageId: "message-supplement-2",
			grant: grant(base, ["turn.supplement"]),
			input: { text: "synthetic-late-supplement", attachments: [] },
		});
		expect(rejected.result).toMatchObject({
			outcome: "rejected",
			code: "RUNTIME_TURN_NOT_ACTIVE",
		});
	});

	it("reads a bound model directory without exposing native values or creating a Turn", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const store = await FileRuntimeStore.open(join(directory, "host.json"));
		const runtimeHost = await host(store, driver);
		const submittedRequest = submitRequest();
		const submitted = await runtimeHost.submitTurn(submittedRequest);
		const readRequest = {
			schemaVersion: 1 as const,
			requestId: "request-model-directory",
			traceId: submittedRequest.traceId,
			actorId: submittedRequest.actorId,
			channelId: submittedRequest.channelId,
			agentId: submittedRequest.agentId,
			conversationId: submittedRequest.conversationId,
			executionId: submittedRequest.executionId,
			turnId: submittedRequest.turnId,
			sessionGeneration: submittedRequest.sessionGeneration,
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(submittedRequest, ["model-directory.read"]),
		};
		const result = await runtimeHost.modelDirectory(readRequest);
		expect(result).toMatchObject({
			hostSessionRef: submitted.hostSessionRef,
			executionId: submittedRequest.executionId,
			current: {
				modelOptionId: "model-option-primary",
				reasoningLevel: "high",
			},
		});
		expect(result.options).toEqual([
			{
				schemaVersion: 1,
				modelOptionId: "model-option-primary",
				modelId: "model-option-primary",
				displayName: "model-option-primary",
				reasoningLevels: ["high"],
			},
			{
				schemaVersion: 1,
				modelOptionId: "model-option-alternate",
				modelId: "model-option-alternate",
				displayName: "model-option-alternate",
				reasoningLevels: ["low"],
			},
		]);
		expect(JSON.stringify(result)).not.toContain("native");
		await expect(
			runtimeHost.modelDirectory({
				...readRequest,
				grant: grant(submittedRequest, ["capabilities.read"]),
			}),
		).rejects.toMatchObject({ httpStatus: 403 });
	});
});
