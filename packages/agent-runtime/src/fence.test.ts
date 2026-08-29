import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	ExecutionGrantCommandV1,
	ExecutionGrantV1,
	RuntimeSubmitTurnRequestV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it } from "vitest";

import {
	openIngressVerifiedRuntimeHost,
	runtimeGrantFixture,
	runtimeGrantRequestContext,
} from "./grant-fixture.test-support.js";
import { FakeRuntimeDriver, FileRuntimeStore } from "./index.js";

const directories: string[] = [];

function signedGrant(
	binding: Pick<
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
	commands: ExecutionGrantCommandV1[],
): ExecutionGrantV1 {
	return runtimeGrantFixture(binding, commands, {
		actionSetVersion: "actions-fence",
	});
}
function submitRequest(): RuntimeSubmitTurnRequestV1 {
	const binding = {
		agentId: "agent-fence",
		actorId: "actor-fence",
		channelId: "web",
		conversationId: "conversation-fence",
		executionId: "execution-fence",
		turnId: "turn-fence",
		sessionGeneration: 1,
		traceId: "trace-fence",
	};
	return {
		schemaVersion: 1,
		requestId: "request-fence",
		...binding,
		deliveryFence: 1,
		grant: signedGrant(binding, ["turn.submit"]),
		input: { text: "synthetic-fence-input", attachments: [] },
	};
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((value) => rm(value, { recursive: true })),
	);
});

describe("RuntimeHost generation and delivery fencing", () => {
	it("serializes ref-less submit and ref-bound commands for one Session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agent-runtime-ordering-"));
		directories.push(directory);
		const prepared: string[] = [];
		let releaseSubmit: () => void = () => undefined;
		const submitReleased = new Promise<void>((resolve) => {
			releaseSubmit = resolve;
		});
		let submitPrepared: () => void = () => undefined;
		const submitPreparedPromise = new Promise<void>((resolve) => {
			submitPrepared = resolve;
		});
		let supplementPrepared: () => void = () => undefined;
		const supplementPreparedPromise = new Promise<void>((resolve) => {
			supplementPrepared = resolve;
		});
		const runtimeHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver: await FakeRuntimeDriver.open(join(directory, "driver.json")),
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
			afterOperationPrepared: async (operationId) => {
				prepared.push(operationId);
				if (operationId === "execution-fence-next") {
					submitPrepared();
					await submitReleased;
				}
				if (operationId === "message-fence-ordered") supplementPrepared();
			},
		});
		const original = submitRequest();
		const submitted = await runtimeHost.submitTurn(original);
		prepared.length = 0;
		const next = {
			...original,
			requestId: "request-fence-next",
			executionId: "execution-fence-next",
			turnId: "turn-fence-next",
			grant: signedGrant(
				{
					...original,
					executionId: "execution-fence-next",
					turnId: "turn-fence-next",
				},
				["turn.submit"],
			),
		};
		const nextSubmit = runtimeHost.submitTurn(next);
		await submitPreparedPromise;
		const supplement = runtimeHost.supplement({
			...original,
			requestId: "request-fence-ordered-supplement",
			deliveryFence: 1,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			messageId: "message-fence-ordered",
			grant: signedGrant(original, ["turn.supplement"]),
			input: { text: "synthetic-ordered-supplement", attachments: [] },
		});
		const supplementEnteredWhileSubmitBlocked = await Promise.race([
			supplementPreparedPromise.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
		]);
		releaseSubmit();
		await Promise.all([nextSubmit, supplement]);
		await supplementPreparedPromise;
		expect(supplementEnteredWhileSubmitBlocked).toBe(false);
		expect(prepared).toEqual(["execution-fence-next", "message-fence-ordered"]);
	});

	it("deduplicates concurrent delivery and rejects stale or mismatched requests before side effects", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agent-runtime-fence-"));
		directories.push(directory);
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const original = submitRequest();
		const [first, duplicate] = await Promise.all([
			runtimeHost.submitTurn(original),
			runtimeHost.submitTurn({
				...original,
				requestId: "request-fence-duplicate",
			}),
		]);
		expect(duplicate).toEqual(first);
		expect(await driver.sideEffectCount()).toBe(1);

		const takeover = await runtimeHost.submitTurn({
			...original,
			requestId: "request-fence-takeover",
			deliveryFence: 2,
			hostSessionRef: first.hostSessionRef,
		});
		expect(takeover).toEqual(first);
		expect(await driver.sideEffectCount()).toBe(1);

		await expect(
			runtimeHost.supplement({
				schemaVersion: 1,
				requestId: "request-stale-supplement",
				...runtimeGrantRequestContext(original),
				agentId: original.agentId,
				conversationId: original.conversationId,
				executionId: original.executionId,
				turnId: original.turnId,
				sessionGeneration: 1,
				deliveryFence: 1,
				executionDeliveryFence: 1,
				hostSessionRef: first.hostSessionRef,
				messageId: "message-stale",
				grant: signedGrant(original, ["turn.supplement"]),
				input: { text: "synthetic-stale-supplement", attachments: [] },
			}),
		).rejects.toMatchObject({ code: "RUNTIME_FENCE_STALE" });

		await expect(
			runtimeHost.stop({
				schemaVersion: 1,
				requestId: "request-stale-stop",
				...runtimeGrantRequestContext(original),
				agentId: original.agentId,
				conversationId: original.conversationId,
				executionId: original.executionId,
				turnId: original.turnId,
				sessionGeneration: 1,
				deliveryFence: 1,
				executionDeliveryFence: 1,
				hostSessionRef: first.hostSessionRef,
				stopRequestId: "stop-stale",
				grant: signedGrant(original, ["turn.stop"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_FENCE_STALE" });

		const otherConversation = {
			...original,
			conversationId: "conversation-other",
		};
		await expect(
			runtimeHost.replay({
				schemaVersion: 1,
				requestId: "request-cross-conversation",
				...runtimeGrantRequestContext(otherConversation),
				agentId: otherConversation.agentId,
				conversationId: otherConversation.conversationId,
				executionId: otherConversation.executionId,
				turnId: otherConversation.turnId,
				sessionGeneration: 1,
				deliveryFence: 2,
				hostSessionRef: first.hostSessionRef,
				grant: signedGrant(otherConversation, ["events.replay"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_SESSION_BINDING_MISMATCH" });

		const nextGeneration = { ...original, sessionGeneration: 2 };
		await expect(
			runtimeHost.status({
				schemaVersion: 1,
				requestId: "request-wrong-generation",
				...runtimeGrantRequestContext(nextGeneration),
				agentId: nextGeneration.agentId,
				conversationId: nextGeneration.conversationId,
				executionId: nextGeneration.executionId,
				turnId: nextGeneration.turnId,
				sessionGeneration: 2,
				deliveryFence: 2,
				hostSessionRef: first.hostSessionRef,
				grant: signedGrant(nextGeneration, ["session.status"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_SESSION_BINDING_MISMATCH" });

		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("binds status, replay, supplement, and stop to the persisted Execution and Turn", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agent-runtime-binding-"));
		directories.push(directory);
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const original = submitRequest();
		const submitted = await runtimeHost.submitTurn(original);
		const wrongExecution = {
			...original,
			executionId: "execution-other",
			turnId: "turn-other",
		};
		const wrongTurn = { ...original, turnId: "turn-other" };

		await expect(
			runtimeHost.status({
				schemaVersion: 1,
				requestId: "request-status-wrong-execution",
				...runtimeGrantRequestContext(wrongExecution),
				agentId: wrongExecution.agentId,
				conversationId: wrongExecution.conversationId,
				executionId: wrongExecution.executionId,
				turnId: wrongExecution.turnId,
				sessionGeneration: wrongExecution.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: submitted.hostSessionRef,
				grant: signedGrant(wrongExecution, ["session.status"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_EXECUTION_BINDING_MISMATCH" });
		await expect(
			runtimeHost.replay({
				schemaVersion: 1,
				requestId: "request-replay-wrong-turn",
				...runtimeGrantRequestContext(wrongTurn),
				agentId: wrongTurn.agentId,
				conversationId: wrongTurn.conversationId,
				executionId: wrongTurn.executionId,
				turnId: wrongTurn.turnId,
				sessionGeneration: wrongTurn.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: submitted.hostSessionRef,
				grant: signedGrant(wrongTurn, ["events.replay"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_EXECUTION_BINDING_MISMATCH" });
		await expect(
			runtimeHost.supplement({
				schemaVersion: 1,
				requestId: "request-supplement-wrong-turn",
				...runtimeGrantRequestContext(wrongTurn),
				agentId: wrongTurn.agentId,
				conversationId: wrongTurn.conversationId,
				executionId: wrongTurn.executionId,
				turnId: wrongTurn.turnId,
				sessionGeneration: wrongTurn.sessionGeneration,
				deliveryFence: 1,
				executionDeliveryFence: 1,
				hostSessionRef: submitted.hostSessionRef,
				messageId: "message-wrong-turn",
				grant: signedGrant(wrongTurn, ["turn.supplement"]),
				input: { text: "synthetic-wrong-turn", attachments: [] },
			}),
		).rejects.toMatchObject({ code: "RUNTIME_EXECUTION_BINDING_MISMATCH" });
		await expect(
			runtimeHost.stop({
				schemaVersion: 1,
				requestId: "request-stop-wrong-turn",
				...runtimeGrantRequestContext(wrongTurn),
				agentId: wrongTurn.agentId,
				conversationId: wrongTurn.conversationId,
				executionId: wrongTurn.executionId,
				turnId: wrongTurn.turnId,
				sessionGeneration: wrongTurn.sessionGeneration,
				deliveryFence: 1,
				executionDeliveryFence: 1,
				hostSessionRef: submitted.hostSessionRef,
				stopRequestId: "stop-wrong-turn",
				grant: signedGrant(wrongTurn, ["turn.stop"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_EXECUTION_BINDING_MISMATCH" });
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("reuses the one current Host Session when a new Execution omits its ref", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agent-runtime-session-"));
		directories.push(directory);
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const original = submitRequest();
		const first = await runtimeHost.submitTurn(original);
		const nextExecution = {
			...original,
			requestId: "request-next-execution",
			executionId: "execution-next",
			turnId: "turn-next",
		};
		const second = await runtimeHost.submitTurn({
			...nextExecution,
			grant: signedGrant(nextExecution, ["turn.submit"]),
		});

		expect(second.hostSessionRef).toBe(first.hostSessionRef);
		expect(second.result).toEqual({ outcome: "busy" });
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("stops a live event stream when a higher Execution fence takes over", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "agent-runtime-stream-fence-"),
		);
		directories.push(directory);
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const original = submitRequest();
		const submitted = await runtimeHost.submitTurn(original);
		const events = await runtimeHost.streamEvents({
			schemaVersion: 1,
			requestId: "request-stream-fence-1",
			...runtimeGrantRequestContext(original),
			agentId: original.agentId,
			conversationId: original.conversationId,
			executionId: original.executionId,
			turnId: original.turnId,
			sessionGeneration: original.sessionGeneration,
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			afterCursor: "fake-cursor-1",
			grant: signedGrant(original, ["events.replay"]),
		});
		const iterator = events[Symbol.asyncIterator]();
		await runtimeHost.submitTurn({
			...original,
			requestId: "request-stream-fence-2",
			deliveryFence: 2,
			hostSessionRef: submitted.hostSessionRef,
		});
		await runtimeHost.supplement({
			schemaVersion: 1,
			requestId: "request-stream-event",
			...runtimeGrantRequestContext(original),
			agentId: original.agentId,
			conversationId: original.conversationId,
			executionId: original.executionId,
			turnId: original.turnId,
			sessionGeneration: original.sessionGeneration,
			deliveryFence: 1,
			executionDeliveryFence: 2,
			hostSessionRef: submitted.hostSessionRef,
			messageId: "message-stream-event",
			grant: signedGrant(original, ["turn.supplement"]),
			input: { text: "synthetic-stream-event", attachments: [] },
		});

		await expect(iterator.next()).rejects.toMatchObject({
			code: "RUNTIME_FENCE_STALE",
		});
	});

	it("activates a durable generation barrier before confirming cancellation", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "agent-runtime-generation-"),
		);
		directories.push(directory);
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const original = submitRequest();
		const submitted = await runtimeHost.submitTurn(original);
		const cancellation = {
			schemaVersion: 1 as const,
			requestId: "request-generation-cancel",
			...runtimeGrantRequestContext(original),
			agentId: original.agentId,
			conversationId: original.conversationId,
			executionId: original.executionId,
			turnId: original.turnId,
			sessionGeneration: original.sessionGeneration,
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			tombstoneId: "generation-tombstone-1",
			grant: signedGrant(original, ["generation.cancel"]),
		};

		const cancelled = await runtimeHost.cancelGeneration(cancellation);
		expect(cancelled.result).toEqual({
			outcome: "accepted",
			status: "cancelled",
		});
		expect(
			await runtimeHost.cancelGeneration({
				...cancellation,
				requestId: "request-generation-cancel-retry",
				deliveryFence: 2,
			}),
		).toEqual(cancelled);
		expect(await driver.sideEffectCount()).toBe(2);

		await expect(
			runtimeHost.submitTurn({
				...original,
				requestId: "request-after-generation-cancel",
				deliveryFence: 2,
				hostSessionRef: submitted.hostSessionRef,
			}),
		).rejects.toMatchObject({ code: "RUNTIME_GENERATION_CANCELLED" });
		expect(await driver.sideEffectCount()).toBe(2);
	});

	it("confirms an active generation barrier after a crash persisted cancellation", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "agent-runtime-barrier-crash-"),
		);
		directories.push(directory);
		const hostPath = join(directory, "host.json");
		const driverPath = join(directory, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		const original = submitRequest();
		const firstHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(hostPath),
			driver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const submitted = await firstHost.submitTurn(original);
		const tombstoneId = "generation-tombstone-crash";
		const crashingHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(hostPath),
			driver: await FakeRuntimeDriver.open(driverPath),
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
			afterOperationResolved: (operationId) => {
				if (operationId === tombstoneId) {
					throw new Error("simulated crash before barrier confirmation");
				}
			},
		});

		await expect(
			crashingHost.cancelGeneration({
				schemaVersion: 1,
				requestId: "request-generation-crash",
				...runtimeGrantRequestContext(original),
				agentId: original.agentId,
				conversationId: original.conversationId,
				executionId: original.executionId,
				turnId: original.turnId,
				sessionGeneration: original.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: submitted.hostSessionRef,
				tombstoneId,
				grant: signedGrant(original, ["generation.cancel"]),
			}),
		).rejects.toThrow("simulated crash before barrier confirmation");
		const activeState = JSON.parse(await readFile(hostPath, "utf8")) as {
			sessions: Record<string, { generationBarrier?: { state: string } }>;
		};
		expect(
			activeState.sessions[submitted.hostSessionRef]?.generationBarrier?.state,
		).toBe("active");

		await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(hostPath),
			driver: await FakeRuntimeDriver.open(driverPath),
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const recoveredState = JSON.parse(await readFile(hostPath, "utf8")) as {
			sessions: Record<string, { generationBarrier?: { state: string } }>;
		};
		expect(
			recoveredState.sessions[submitted.hostSessionRef]?.generationBarrier
				?.state,
		).toBe("confirmed");
		await expect(
			(await FakeRuntimeDriver.open(driverPath)).sideEffectCount(),
		).resolves.toBe(2);
	});
});
