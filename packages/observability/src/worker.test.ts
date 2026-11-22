import { createServer } from "node:http";
import { Writable } from "node:stream";
import {
	type ConversationEventCommandV1,
	type ConversationEventDecisionV1,
	ConversationEventError,
	type ConversationEventTransactionPortV1,
	type ConversationEventWritePlanV1,
	type ConversationOperationFactV2,
} from "@agent-infra/platform-core";
import { expect, it } from "vitest";
import {
	type ModelTokenUsage,
	type OperationalEvent,
	startObservability,
} from "./index.js";
import { createObservedConversationEvents } from "./worker.js";

const command: ConversationEventCommandV1 = {
	schemaVersion: 1,
	conversationId: "123e4567-e89b-42d3-a456-426614174000",
	executionId: "123e4567-e89b-42d3-a456-426614174001",
	sessionGeneration: 3,
	deliveryFence: 5,
	adapterEventKey: "event-1",
	runtimeCursor: "PRIVATE_CURSOR_SENTINEL",
	occurredAt: "2026-09-29T00:00:00.000Z",
	event: { type: "text.delta", text: "PRIVATE_BODY_SENTINEL" },
};

/** Fake the transaction boundary while using the real Core decision/validation. */
function transactionFixture() {
	const writes: ConversationEventWritePlanV1[] = [];
	let auditCount = 0;
	const control: {
		beforeCommit?: () => Promise<void>;
		fail?: boolean;
		corrupt?: (
			decision: ConversationEventDecisionV1,
		) => ConversationEventDecisionV1;
	} = {};
	const transaction: ConversationEventTransactionPortV1 = {
		async persistEvent(request, decide) {
			const existing = writes.find(
				(write) => write.adapterEventKey === request.command.adapterEventKey,
			);
			const latest = writes.at(-1)?.event;
			const plan = decide({
				operationHistory: writes.flatMap(({ event }) =>
					event.event.type === "execution.operation" ? [event.event.fact] : [],
				),
				conversation: {
					conversationId: command.conversationId,
					sessionGeneration: command.sessionGeneration,
					lastConversationCursor: latest?.conversationCursor ?? 0,
				},
				execution: {
					executionId: command.executionId,
					conversationId: command.conversationId,
					sessionGeneration: command.sessionGeneration,
					deliveryFence: command.deliveryFence,
					lastSequence: latest?.sequence ?? 0,
				},
				existingEvent: existing
					? { event: existing.event, eventDigest: existing.eventDigest }
					: undefined,
			});
			if ("outcome" in plan) return plan;
			await control.beforeCommit?.();
			if (control.fail) throw new Error("PRIVATE_COMMIT_SENTINEL");
			writes.push(structuredClone(plan));
			auditCount++;
			const decision: ConversationEventDecisionV1 = {
				outcome: "accepted",
				event: structuredClone(plan.event),
			};
			return control.corrupt?.(decision) ?? decision;
		},
	};
	return {
		transaction,
		control,
		snapshot: () => ({
			events: writes.map((write) => structuredClone(write.event)),
			auditCount,
			runtimeCursor: writes.at(-1)?.runtimeCursor,
		}),
	};
}

it("observes acceptance only after the event/audit transaction confirms", async () => {
	const fixture = transactionFixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	fixture.control.beforeCommit = () => {
		entered.resolve();
		return release.promise;
	};
	const observations: OperationalEvent[] = [];
	const events = createObservedConversationEvents({
		transaction: fixture.transaction,
		telemetry: { record: (event) => observations.push(event) },
	});
	const pending = events.persist(command);
	await entered.promise;
	expect(observations).toEqual([]);
	expect(fixture.snapshot()).toEqual({
		events: [],
		auditCount: 0,
		runtimeCursor: undefined,
	});
	release.resolve();
	const decision = await pending;
	expect(decision).toMatchObject({
		outcome: "accepted",
		event: { sequence: 1, conversationCursor: 1, event: command.event },
	});
	expect(fixture.snapshot()).toMatchObject({
		auditCount: 1,
		runtimeCursor: command.runtimeCursor,
	});
	expect(observations).toEqual([
		{
			stage: "result_persist",
			outcome: "completed",
			operationRef: "drain.persist",
			conversationId: command.conversationId,
			executionId: command.executionId,
			durationMs: expect.any(Number),
		},
	]);
	expect(JSON.stringify(observations)).not.toContain("SENTINEL");
});

it("returns replayed and stale decisions without counting or advancing them again", async () => {
	const fixture = transactionFixture();
	const observations: OperationalEvent[] = [];
	const events = createObservedConversationEvents({
		transaction: fixture.transaction,
		telemetry: { record: (event) => observations.push(event) },
	});
	const accepted = await events.persist(command);
	if (accepted.outcome !== "accepted")
		throw new Error("Expected accepted fixture");
	expect(await events.persist(command)).toEqual({
		outcome: "replayed",
		event: accepted.event,
	});
	expect(
		await events.persist({
			...command,
			adapterEventKey: "stale-event",
			runtimeCursor: "stale-cursor",
			deliveryFence: 4,
		}),
	).toEqual({ outcome: "stale" });
	expect(observations).toHaveLength(1);
	expect(fixture.snapshot()).toEqual({
		events: [accepted.event],
		auditCount: 1,
		runtimeCursor: command.runtimeCursor,
	});
});

it.each(["commit failure", "decision mismatch"])(
	"reports %s without a success observation",
	async (mode) => {
		const fixture = transactionFixture();
		if (mode === "commit failure") fixture.control.fail = true;
		else
			fixture.control.corrupt = (decision) =>
				decision.outcome === "accepted"
					? { ...decision, event: { ...decision.event, sequence: 42 } }
					: decision;
		const observations: OperationalEvent[] = [];
		const events = createObservedConversationEvents({
			transaction: fixture.transaction,
			telemetry: { record: (event) => observations.push(event) },
		});
		await expect(events.persist(command)).rejects.toMatchObject({
			name: "ConversationEventError",
			code: "unavailable",
		});
		expect(observations).toEqual([
			{
				stage: "result_persist",
				outcome: "failed",
				code: "PERSISTENCE_UNAVAILABLE",
				protocolCode: "EVENT_PERSISTENCE_UNKNOWN",
				operationRef: "drain.persist",
				durationMs: expect.any(Number),
				conversationId: command.conversationId,
				executionId: command.executionId,
			},
		]);
		expect(JSON.stringify(observations)).not.toContain("SENTINEL");
		expect(fixture.snapshot().auditCount).toBe(
			mode === "commit failure" ? 0 : 1,
		);
	},
);

it("preserves Core acceptance and rejection when capture throws", async () => {
	const fixture = transactionFixture();
	const events = createObservedConversationEvents({
		transaction: fixture.transaction,
		telemetry: {
			record() {
				throw new Error("PRIVATE_CAPTURE_SENTINEL");
			},
		},
	});
	const accepted = await events.persist(command);
	expect(accepted).toMatchObject({
		outcome: "accepted",
		event: { event: command.event },
	});
	expect(fixture.snapshot()).toMatchObject({
		auditCount: 1,
		runtimeCursor: command.runtimeCursor,
	});
	fixture.control.fail = true;
	await expect(
		events.persist({ ...command, adapterEventKey: "failed-event" }),
	).rejects.toBeInstanceOf(ConversationEventError);
	expect(fixture.snapshot().auditCount).toBe(1);
});

function operation(
	fact: ConversationOperationFactV2,
	eventKey: string,
): ConversationEventCommandV1 {
	return {
		...command,
		adapterEventKey: eventKey,
		runtimeCursor: `cursor-${eventKey}`,
		event: { schemaVersion: 2, type: "execution.operation", fact },
	};
}

it("observes committed usage once per known attempt field, including recovery", async () => {
	const fixture = transactionFixture();
	const usage: ModelTokenUsage[] = [];
	const outcomes: OperationalEvent[] = [];
	const telemetry = {
		record: (event: OperationalEvent) => outcomes.push(event),
		recordModelUsage: (value: ModelTokenUsage) => {
			usage.push(value);
		},
	};
	const dependencies = { transaction: fixture.transaction, telemetry };
	let events = createObservedConversationEvents(dependencies);
	const fact: ConversationOperationFactV2 = {
		kind: "model",
		operationRef: "model-1",
		attemptRef: "attempt-1",
		phase: "intent",
		model: {
			configVersion: "config-1",
			modelOptionId: "option-1",
			modelId: "PRIVATE_MODEL_SENTINEL",
		},
	};
	await events.persist(operation(fact, "usage-intent"));
	await events.persist(
		operation({ ...fact, phase: "started" }, "usage-started"),
	);
	expect(usage).toEqual([]);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	fixture.control.beforeCommit = () => {
		entered.resolve();
		return release.promise;
	};
	const unknown = operation(
		{ ...fact, phase: "unknown", usage: { inputTokens: 7 } },
		"usage-unknown",
	);
	const pending = events.persist(unknown);
	await entered.promise;
	expect(usage).toEqual([]);
	release.resolve();
	await pending;
	fixture.control.beforeCommit = undefined;
	expect(usage).toEqual([{ inputTokens: 7 }]);
	// Re-create the consumer: the original locked facts, not a process cache, dedupe.
	events = createObservedConversationEvents(dependencies);
	await events.persist(unknown);
	await events.persist(
		operation(
			{
				...fact,
				phase: "completed",
				usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0 },
			},
			"usage-recovered",
		),
	);
	expect(usage).toEqual([
		{ inputTokens: 7 },
		{ outputTokens: 3, cachedInputTokens: 0 },
	]);
	expect(outcomes.filter((event) => event.stage === "model")).toHaveLength(1);
	const next = { ...fact, attemptRef: "attempt-2" };
	await events.persist(operation(next, "usage-next-intent"));
	await events.persist(
		operation({ ...next, phase: "started" }, "usage-next-started"),
	);
	const terminal = operation(
		{ ...next, phase: "completed", usage: { inputTokens: 2, outputTokens: 1 } },
		"usage-next-completed",
	);
	fixture.control.fail = true;
	await expect(events.persist(terminal)).rejects.toBeInstanceOf(
		ConversationEventError,
	);
	expect(usage).toHaveLength(2);
	fixture.control.fail = false;
	telemetry.recordModelUsage = () => {
		throw new Error("PRIVATE_CAPTURE_SENTINEL");
	};
	expect((await events.persist(terminal)).outcome).toBe("accepted");
	expect((await events.persist(terminal)).outcome).toBe("replayed");
	expect(fixture.snapshot().auditCount).toBe(7);
	expect(JSON.stringify(usage)).not.toContain("SENTINEL");
});

it.each(["model", "tool"] as const)(
	"counts the first committed %s outcome without inventing duration or usage",
	async (kind) => {
		const fixture = transactionFixture();
		const observations: OperationalEvent[] = [];
		const events = createObservedConversationEvents({
			transaction: fixture.transaction,
			telemetry: { record: (event) => observations.push(event) },
		});
		const intent: ConversationOperationFactV2 = {
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			phase: "intent",
			...(kind === "model"
				? {
						kind,
						model: {
							configVersion: "config-1",
							modelOptionId: "option-1",
							modelId: "PRIVATE_MODEL_SENTINEL",
						},
					}
				: { kind, toolId: "PRIVATE_TOOL_SENTINEL" }),
		};
		await events.persist(operation(intent, "intent"));
		await events.persist(operation({ ...intent, phase: "started" }, "started"));
		expect(observations.filter((event) => event.stage === kind)).toEqual([]);
		const terminal = operation({ ...intent, phase: "completed" }, "completed");
		await events.persist(terminal);
		await events.persist(terminal);
		expect(observations.filter((event) => event.stage === kind)).toEqual([
			{
				stage: kind,
				outcome: "completed",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				conversationId: command.conversationId,
				executionId: command.executionId,
			},
		]);
		expect(JSON.stringify(observations)).not.toContain("SENTINEL");
		expect(fixture.snapshot().auditCount).toBe(3);
	},
);

it("does not recount an unknown attempt on recovery, but counts a real new attempt", async () => {
	const fixture = transactionFixture();
	const observations: OperationalEvent[] = [];
	const dependencies = {
		transaction: fixture.transaction,
		telemetry: {
			record: (event: OperationalEvent) => observations.push(event),
		},
	};
	const events = createObservedConversationEvents(dependencies);
	const intent: ConversationOperationFactV2 = {
		kind: "model",
		operationRef: "model-operation",
		attemptRef: "attempt-1",
		phase: "intent",
		model: {
			configVersion: "config-1",
			modelOptionId: "option-1",
			modelId: "model-1",
		},
	};
	await events.persist(operation(intent, "intent-1"));
	await events.persist(operation({ ...intent, phase: "started" }, "started-1"));
	await events.persist(
		operation(
			{ ...intent, phase: "unknown", failureCode: "recovery_unconfirmed" },
			"unknown-1",
		),
	);
	const restarted = createObservedConversationEvents(dependencies);
	await restarted.persist(
		operation({ ...intent, phase: "completed", durationMs: 18 }, "confirmed-1"),
	);
	expect(observations.filter((event) => event.stage === "model")).toEqual([
		{
			stage: "model",
			outcome: "unknown",
			code: "OPERATION_UNKNOWN",
			operationRef: "model-operation",
			attemptRef: "attempt-1",
			conversationId: command.conversationId,
			executionId: command.executionId,
		},
	]);
	const retry = { ...intent, attemptRef: "attempt-2" };
	await restarted.persist(operation(retry, "intent-2"));
	await restarted.persist(
		operation({ ...retry, phase: "started" }, "started-2"),
	);
	await restarted.persist(
		operation({ ...retry, phase: "completed", durationMs: 21 }, "completed-2"),
	);
	expect(observations.filter((event) => event.stage === "model")).toHaveLength(
		2,
	);
	expect(
		observations.findLast((event) => event.stage === "model"),
	).toMatchObject({
		outcome: "completed",
		attemptRef: "attempt-2",
		durationMs: 21,
	});
	expect(fixture.snapshot().auditCount).toBe(7);
});

it("classifies Browser operation outcomes separately from ordinary tools", async () => {
	const fixture = transactionFixture();
	const observations: OperationalEvent[] = [];
	const events = createObservedConversationEvents({
		transaction: fixture.transaction,
		telemetry: { record: (event) => observations.push(event) },
	});
	const intent: ConversationOperationFactV2 = {
		kind: "tool",
		operationRef: "browser-operation",
		attemptRef: "browser-attempt",
		phase: "intent",
		toolId: "browser.click",
		browser: {
			actionId: "browser-action",
			capabilityVersion: 1,
			pageRevision: 2,
			sessionGeneration: 3,
			resourceFence: 4,
			workloadRevision: 2,
			imageDigest: `sha256:${"a".repeat(64)}`,
			sideEffect: true,
		},
	};
	await events.persist(operation(intent, "browser-intent"));
	await events.persist(
		operation({ ...intent, phase: "started" }, "browser-started"),
	);
	await events.persist(
		operation(
			{ ...intent, phase: "unknown", failureCode: "recovery_unconfirmed" },
			"browser-unknown",
		),
	);
	expect(observations.filter((event) => event.stage === "browser")).toEqual([
		expect.objectContaining({
			stage: "browser",
			outcome: "unknown",
			code: "OPERATION_UNKNOWN",
			browserCategory: "recovery",
			operationRef: "browser-operation",
			attemptRef: "browser-attempt",
		}),
	]);
});

it.each([
	["browser.navigate", "navigation"],
	["browser.snapshot", "observation"],
	["browser.click", "interaction"],
	["browser.download", "artifact_transfer"],
	["browser.handoff", "handoff"],
] as const)("classifies Browser tool %s as %s", async (toolId, category) => {
	const fixture = transactionFixture();
	const observations: OperationalEvent[] = [];
	const events = createObservedConversationEvents({
		transaction: fixture.transaction,
		telemetry: { record: (event) => observations.push(event) },
	});
	const key = category.replace("_", "-");
	const fact: ConversationOperationFactV2 = {
		kind: "tool",
		operationRef: `browser-${category.replace("_", "-")}`,
		attemptRef: "browser-attempt",
		phase: "completed",
		toolId,
		browser: {
			actionId: "browser-action",
			capabilityVersion: 1,
			pageRevision: 2,
			sessionGeneration: 3,
			resourceFence: 4,
			workloadRevision: 2,
			imageDigest: `sha256:${"a".repeat(64)}`,
			sideEffect: false,
		},
	};
	const intent = { ...fact, phase: "intent" as const };
	await events.persist(operation(intent, `category-${key}-intent`));
	await events.persist(
		operation({ ...intent, phase: "started" }, `category-${key}-started`),
	);
	await events.persist(
		operation(fact, `category-${category.replace("_", "-")}`),
	);
	expect(observations.at(-1)).toMatchObject({
		stage: "browser",
		browserCategory: category,
	});
});

it.each([
	["authorization_denied", "policy_rejection"],
	["request_rejected", "capacity_rejection"],
	["recovery_unconfirmed", "recovery"],
] as const)(
	"classifies Browser failure %s as %s",
	async (failureCode, category) => {
		const fixture = transactionFixture();
		const observations: OperationalEvent[] = [];
		const events = createObservedConversationEvents({
			transaction: fixture.transaction,
			telemetry: { record: (event) => observations.push(event) },
		});
		const key = category.replace("_", "-");
		const fact: ConversationOperationFactV2 = {
			kind: "tool",
			operationRef: `browser-${category.replace("_", "-")}`,
			attemptRef: "browser-attempt",
			phase: failureCode === "recovery_unconfirmed" ? "unknown" : "failed",
			failureCode,
			toolId: "browser.click",
			browser: {
				actionId: "browser-action",
				capabilityVersion: 1,
				pageRevision: 2,
				sessionGeneration: 3,
				resourceFence: 4,
				workloadRevision: 2,
				imageDigest: `sha256:${"a".repeat(64)}`,
				sideEffect: true,
			},
		};
		const { failureCode: _failureCode, ...factWithoutFailure } = fact;
		const intent = { ...factWithoutFailure, phase: "intent" as const };
		await events.persist(operation(intent, `failure-${key}-intent`));
		await events.persist(
			operation({ ...intent, phase: "started" }, `failure-${key}-started`),
		);
		await events.persist(
			operation(fact, `failure-${category.replace("_", "-")}`),
		);
		expect(observations.at(-1)).toMatchObject({
			stage: "browser",
			browserCategory:
				failureCode === "recovery_unconfirmed" ? "recovery" : "interaction",
		});
	},
);

it.each([
	["browser.policy_denied", "policy_rejection"],
	["browser.capacity_rejected", "capacity_rejection"],
] as const)(
	"classifies explicit Browser tool category %s",
	async (toolId, category) => {
		const fixture = transactionFixture();
		const observations: OperationalEvent[] = [];
		const events = createObservedConversationEvents({
			transaction: fixture.transaction,
			telemetry: { record: (event) => observations.push(event) },
		});
		const fact: ConversationOperationFactV2 = {
			kind: "tool",
			operationRef: `browser-${category.replace("_", "-")}`,
			attemptRef: "browser-attempt",
			phase: "failed",
			failureCode: "request_rejected",
			toolId,
			browser: {
				actionId: "browser-action",
				capabilityVersion: 1,
				pageRevision: 2,
				sessionGeneration: 3,
				resourceFence: 4,
				workloadRevision: 2,
				imageDigest: `sha256:${"a".repeat(64)}`,
				sideEffect: false,
			},
		};
		const { failureCode: _failureCode, ...factWithoutFailure } = fact;
		const key = category.replace("_", "-");
		const intent = { ...factWithoutFailure, phase: "intent" as const };
		await events.persist(operation(intent, `explicit-${key}-intent`));
		await events.persist(
			operation({ ...intent, phase: "started" }, `explicit-${key}-started`),
		);
		await events.persist(operation(fact, `explicit-${key}`));
		expect(observations.at(-1)).toMatchObject({
			stage: "browser",
			browserCategory: category,
		});
	},
);

it("does not recount later Connection metadata on a completed tool attempt", async () => {
	const fixture = transactionFixture();
	const observations: OperationalEvent[] = [];
	const events = createObservedConversationEvents({
		transaction: fixture.transaction,
		telemetry: { record: (event) => observations.push(event) },
	});
	const intent: ConversationOperationFactV2 = {
		kind: "tool",
		operationRef: "tool-operation",
		attemptRef: "tool-attempt",
		phase: "intent",
		toolId: "PRIVATE_TOOL_SENTINEL",
	};
	await events.persist(operation(intent, "intent"));
	await events.persist(operation({ ...intent, phase: "started" }, "started"));
	const completed = {
		...intent,
		phase: "completed" as const,
		resultRef: "PRIVATE_RESULT_SENTINEL",
		durationMs: 12,
	};
	await events.persist(operation(completed, "completed"));
	await events.persist({
		...operation(
			{
				...completed,
				connection: {
					serviceRef: "service-1",
					verification: "verified",
					callRef: "PRIVATE_CALL_SENTINEL",
				},
			},
			"metadata",
		),
		operationMetadataOnly: true,
	});
	expect(observations.filter((event) => event.stage === "tool")).toEqual([
		{
			stage: "tool",
			outcome: "completed",
			durationMs: 12,
			operationRef: "tool-operation",
			attemptRef: "tool-attempt",
			conversationId: command.conversationId,
			executionId: command.executionId,
		},
	]);
	expect(JSON.stringify(observations)).not.toContain("SENTINEL");
	expect(fixture.snapshot().auditCount).toBe(4);
});

it("does not publish a computed tool result before Core validates the committed reply", async () => {
	const fixture = transactionFixture();
	const observations: OperationalEvent[] = [];
	const events = createObservedConversationEvents({
		transaction: fixture.transaction,
		telemetry: { record: (event) => observations.push(event) },
	});
	const intent: ConversationOperationFactV2 = {
		kind: "tool",
		operationRef: "tool-operation",
		attemptRef: "tool-attempt",
		phase: "intent",
		toolId: "tool-1",
	};
	await events.persist(operation(intent, "intent"));
	await events.persist(operation({ ...intent, phase: "started" }, "started"));
	observations.length = 0;
	fixture.control.corrupt = (decision) =>
		decision.outcome === "accepted"
			? { ...decision, event: { ...decision.event, sequence: 42 } }
			: decision;
	await expect(
		events.persist(operation({ ...intent, phase: "completed" }, "completed")),
	).rejects.toMatchObject({ code: "unavailable" });
	expect(observations).toEqual([
		{
			stage: "result_persist",
			outcome: "failed",
			code: "PERSISTENCE_UNAVAILABLE",
			protocolCode: "EVENT_PERSISTENCE_UNKNOWN",
			operationRef: "drain.persist",
			durationMs: expect.any(Number),
			conversationId: command.conversationId,
			executionId: command.executionId,
		},
	]);
});

it("rejects invalid Core input without persistence or sensitive observations", async () => {
	const fixture = transactionFixture();
	const observations: OperationalEvent[] = [];
	const events = createObservedConversationEvents({
		transaction: fixture.transaction,
		telemetry: { record: (event) => observations.push(event) },
	});
	await expect(
		events.persist({
			...command,
			event: {
				type: "text.delta",
				text: "PRIVATE_BODY_SENTINEL",
				credential: "PRIVATE_CREDENTIAL_SENTINEL",
			},
		} as ConversationEventCommandV1),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(observations).toEqual([]);
	expect(fixture.snapshot()).toEqual({
		events: [],
		auditCount: 0,
		runtimeCursor: undefined,
	});
});

it("records one bounded batch observation without body or cursor (#3378)", async () => {
	const fixture = transactionFixture();
	const records: OperationalEvent[] = [];
	const events = createObservedConversationEvents({
		transaction: fixture.transaction,
		telemetry: { record: (event: OperationalEvent) => records.push(event) },
	});
	const batch = [1, 2, 3].map((index) => ({
		...command,
		adapterEventKey: `batch-${index}`,
		runtimeCursor: `PRIVATE_CURSOR_SENTINEL_${index}`,
	}));
	const decisions = await events.persistBatch?.(batch);
	expect(decisions?.map((decision) => decision.outcome)).toEqual([
		"accepted",
		"accepted",
		"accepted",
	]);
	expect(fixture.snapshot().events.map((event) => event.sequence)).toEqual([
		1, 2, 3,
	]);
	expect(records).toEqual([
		expect.objectContaining({
			stage: "result_persist",
			outcome: "completed",
			operationRef: "drain.persist_batch",
			conversationId: command.conversationId,
			executionId: command.executionId,
		}),
	]);
	expect(JSON.stringify(records)).not.toMatch(/PRIVATE_(BODY|CURSOR)_SENTINEL/);
	fixture.control.fail = true;
	await expect(
		events.persistBatch?.([{ ...command, adapterEventKey: "batch-failed" }]),
	).rejects.toBeInstanceOf(ConversationEventError);
	expect(records.at(-1)).toMatchObject({
		stage: "result_persist",
		outcome: "failed",
		code: "PERSISTENCE_UNAVAILABLE",
		operationRef: "drain.persist_batch",
	});
});

// #4377: diagnostics keep the failure reason, never the original event or exception.
it("reports a rejected operation successor with a fixed persistence reason (#4377)", async () => {
	const fixture = transactionFixture();
	const observations: OperationalEvent[] = [];
	const events = createObservedConversationEvents({
		transaction: fixture.transaction,
		telemetry: { record: (event) => observations.push(event) },
	});
	const fact: ConversationOperationFactV2 = {
		kind: "tool",
		operationRef: "tool-original",
		attemptRef: "attempt-original",
		toolId: "pi.read",
		phase: "intent",
	};
	const next = (phase: "intent" | "started" | "completed", key: string) => ({
		...command,
		adapterEventKey: key,
		runtimeCursor: key,
		event: {
			type: "execution.operation" as const,
			schemaVersion: 2 as const,
			fact: {
				...fact,
				phase,
				...(phase === "started" ? { startedAt: command.occurredAt } : {}),
				...(phase === "completed"
					? { finishedAt: command.occurredAt, durationMs: 0 }
					: {}),
			},
		},
	});
	await events.persist(next("intent", "tool-intent"));
	await events.persist(next("started", "tool-started"));
	await expect(
		events.persist(next("completed", "tool-end")),
	).rejects.toMatchObject({ code: "unavailable" });
	expect(observations.at(-1)).toMatchObject({
		stage: "result_persist",
		outcome: "failed",
		code: "PERSISTENCE_UNAVAILABLE",
		protocolCode: "EVENT_OPERATION_SUCCESSOR_INVALID",
		operationRef: "drain.persist",
		executionId: command.executionId,
	});
	expect(JSON.stringify(observations)).not.toContain("SENTINEL");
	expect(fixture.snapshot().events).toHaveLength(2);
});

it("exports only fixed persistence reasons to real Pino and OTLP (#4377)", async () => {
	const exported: Buffer[] = [];
	const logs: string[] = [];
	const collector = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		exported.push(Buffer.concat(chunks));
		response.end();
	});
	await new Promise<void>((resolve) =>
		collector.listen(0, "127.0.0.1", resolve),
	);
	const address = collector.address();
	if (!address || typeof address === "string")
		throw new Error("Missing local collector");
	const telemetry = startObservability({
		service: "platform-worker",
		otlpEndpoint: `http://127.0.0.1:${address.port}`,
		output: new Writable({
			write(chunk, _encoding, done) {
				logs.push(String(chunk));
				done();
			},
		}),
	});
	const canaries = [
		"PRIVATE_MESSAGE",
		"PRIVATE_QUERY",
		"PRIVATE_PARAMETERS",
		"PRIVATE_CONSTRAINT",
		"PRIVATE_KEY",
		"PRIVATE_TOKEN",
		"PRIVATE_PATH",
		"PRIVATE_STDOUT",
		"PRIVATE_REASON",
	];
	const reasons = [
		"EVENT_OPERATION_SUCCESSOR_INVALID",
		"EVENT_DATABASE_CONSTRAINT",
		"EVENT_DATABASE_DATA_INVALID",
		"EVENT_DATABASE_TRANSACTION",
		"EVENT_DATABASE_UNAVAILABLE",
	] as const;
	try {
		for (const reason of [...reasons, undefined]) {
			const events = createObservedConversationEvents({
				transaction: {
					async persistEvent() {
						const error = new ConversationEventError("unavailable", reason);
						Object.assign(error, {
							message: canaries[0],
							cause: canaries,
							parameters: canaries,
							...(reason === undefined
								? { persistenceReason: canaries[8] }
								: {}),
						});
						throw error;
					},
				},
				telemetry,
			});
			await expect(events.persist(command)).rejects.toMatchObject({
				code: "unavailable",
			});
		}
		telemetry.record({
			stage: "result_persist",
			outcome: "failed",
			code: "PERSISTENCE_UNAVAILABLE",
			protocolCode: "PRIVATE_REASON",
		});
	} finally {
		await telemetry.close();
		await new Promise<void>((resolve) => collector.close(() => resolve()));
	}
	const stdout = logs.join("");
	const otlp = Buffer.concat(exported).toString();
	for (const output of [stdout, otlp]) {
		for (const reason of [...reasons, "EVENT_PERSISTENCE_UNKNOWN"])
			expect(output).toContain(reason);
		expect(output).toContain(command.executionId);
		for (const canary of [
			...canaries,
			"PRIVATE_BODY_SENTINEL",
			"PRIVATE_CURSOR_SENTINEL",
		])
			expect(output).not.toContain(canary);
	}
});
