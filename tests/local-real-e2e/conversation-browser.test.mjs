import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConversationDetailProjectionV2Schema } from "../../packages/contracts/src/pilot/operation-v2.ts";
import {
	assertAcceptance,
	assistantDeliveryEvidence,
	currentExecutionEvents,
	currentExecutionFrames,
	modelStartObservationMs,
	restoredHistoryPreservesEvents,
} from "./conversation-browser-validation.mjs";

const script = join(import.meta.dirname, "conversation-browser.mjs");

const modelStarted = {
	eventId: "model-start-1",
	executionId: "execution-1",
	type: "execution.operation",
	payload: { kind: "model", phase: "started" },
};
const modelStartedFrame = {
	id: modelStarted.eventId,
	executionId: modelStarted.executionId,
	type: modelStarted.type,
	at: 140.5,
};

test("model-start timing uses the first persisted attempt and earliest matching observation", () => {
	const second = { ...modelStarted, eventId: "model-start-2" };
	assert.equal(
		modelStartObservationMs(
			[modelStarted, second],
			[
				{ ...modelStartedFrame, at: 180 },
				{ ...modelStartedFrame, id: second.eventId, at: 160 },
				modelStartedFrame,
			],
			100,
		),
		40.5,
	);
	assert.equal(
		modelStartObservationMs(
			[modelStarted, second],
			[{ ...modelStartedFrame, id: second.eventId, at: 160 }],
			100,
		),
		null,
	);
});

test("model-start timing cannot substitute intent, processing, completion or tool starts", () => {
	for (const event of [
		{ ...modelStarted, payload: { kind: "model", phase: "intent" } },
		{ ...modelStarted, payload: { kind: "model", phase: "completed" } },
		{ ...modelStarted, payload: { kind: "tool", phase: "started" } },
		{
			...modelStarted,
			type: "execution.status",
			payload: { status: "processing" },
		},
	]) {
		assert.equal(
			modelStartObservationMs([event], [modelStartedFrame], 100),
			null,
		);
	}
});

test("model-start timing rejects absent, foreign and invalid-clock observations", () => {
	for (const frame of [
		{ ...modelStartedFrame, id: "unpersisted-event" },
		{ ...modelStartedFrame, executionId: "another-execution" },
		{ ...modelStartedFrame, type: "text.delta" },
		{ ...modelStartedFrame, at: 99 },
		{ ...modelStartedFrame, at: Number.NaN },
		{ ...modelStartedFrame, at: Number.POSITIVE_INFINITY },
	]) {
		assert.equal(modelStartObservationMs([modelStarted], [frame], 100), null);
	}
	assert.equal(modelStartObservationMs([modelStarted], [], 100), null);
	assert.equal(modelStartObservationMs([], [modelStartedFrame], 100), null);
	for (const clickedAt of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(
			modelStartObservationMs([modelStarted], [modelStartedFrame], clickedAt),
			null,
		);
	}
});

test("coalesced text and completion wait for the current reply to render after delivery", () => {
	const frames = [
		{ type: "text.delta", textLength: 5, at: 10, chunkSequence: 1 },
		{ type: "execution.status", status: "completed", at: 10, chunkSequence: 1 },
	];
	assert.equal(assistantDeliveryEvidence(frames, []), null);
	assert.deepEqual(
		assistantDeliveryEvidence(frames, [{ at: 11, visibleTextLength: 5 }]),
		{ mode: "coalesced", renderedBeforeTerminal: false },
	);
	assert.equal(
		assistantDeliveryEvidence(frames, [{ at: 9, visibleTextLength: 5 }]),
		null,
	);
	assert.equal(
		assistantDeliveryEvidence(frames, [{ at: 11, visibleTextLength: 5 }], 5),
		null,
	);
});

test("separate SSE chunks still require an incremental render before completion", () => {
	const frames = [
		{ type: "text.delta", textLength: 5, at: 10, chunkSequence: 1 },
		{ type: "execution.status", status: "completed", at: 30, chunkSequence: 2 },
	];
	assert.deepEqual(
		assistantDeliveryEvidence(frames, [{ at: 15, visibleTextLength: 5 }]),
		{ mode: "incremental", renderedBeforeTerminal: true },
	);
	assert.equal(
		assistantDeliveryEvidence(frames, [{ at: 31, visibleTextLength: 5 }]),
		null,
	);
	assert.equal(
		assistantDeliveryEvidence([...frames].reverse(), [
			{ at: 15, visibleTextLength: 5 },
		]),
		null,
	);
	assert.equal(
		assistantDeliveryEvidence(frames.slice(0, 1), [
			{ at: 15, visibleTextLength: 5 },
		]),
		null,
	);
	assert.equal(
		assistantDeliveryEvidence(frames.slice(1), [
			{ at: 31, visibleTextLength: 5 },
		]),
		null,
	);
	assert.equal(
		assistantDeliveryEvidence(
			frames.map(({ chunkSequence: _, ...f }) => f),
			[{ at: 15, visibleTextLength: 5 }],
		),
		null,
	);
});

function persistedEvent(eventId, executionId) {
	return {
		schemaVersion: 1,
		kind: "event",
		eventId,
		conversationId: "conversation-1",
		executionId,
		sequence: 1,
		conversationCursor: eventId,
		occurredAt: "2026-09-29T00:00:00.000Z",
		type: "execution.status",
		payload: { status: "completed" },
	};
}

function mixedHistoryDetail() {
	return {
		schemaVersion: 2,
		conversation: {
			schemaVersion: 1,
			conversationId: "conversation-1",
			agentId: "agent-1",
			title: null,
			status: "ready",
			selectedModelOptionId: null,
			selectedReasoningLevel: null,
			lastConversationCursor: "current-event",
			createdAt: "2026-09-29T00:00:00.000Z",
			updatedAt: "2026-09-29T00:00:00.000Z",
		},
		messages: [
			{
				messageId: "conversation-message",
				role: "user",
				text: "synthetic history message",
				executionId: null,
				replyToMessageId: null,
				answerVersion: null,
				isCurrentAnswer: null,
				createdAt: "2026-09-29T00:00:00.000Z",
				status: "completed",
				error: null,
			},
		],
		events: [
			persistedEvent("earlier-event", "execution-old"),
			persistedEvent("current-event", "execution-1"),
		],
	};
}

test("conversation detail keeps earlier execution events outside the submitted execution subset", () => {
	const detail = ConversationDetailProjectionV2Schema.parse(
		mixedHistoryDetail(),
	);
	assert.deepEqual(
		currentExecutionEvents(detail, "conversation-1", "execution-1"),
		[detail.events[1]],
	);
	assert.equal(detail.messages[0].executionId, null);
	assert.equal(detail.events.length, 2);
});

test("conversation messages may have no execution while persisted events may not", () => {
	const detail = mixedHistoryDetail();
	assert.equal(
		ConversationDetailProjectionV2Schema.safeParse(detail).success,
		true,
	);
	const invalidEvent = {
		...detail,
		events: [{ ...detail.events[0], executionId: null }, detail.events[1]],
	};
	assert.equal(
		ConversationDetailProjectionV2Schema.safeParse(invalidEvent).success,
		false,
	);
	assert.equal(
		currentExecutionEvents(invalidEvent, "conversation-1", "execution-1"),
		null,
	);
});

test("older execution frames cannot prove the submitted execution streamed", () => {
	const detail = ConversationDetailProjectionV2Schema.parse(
		mixedHistoryDetail(),
	);
	const events = currentExecutionEvents(
		detail,
		"conversation-1",
		"execution-1",
	);
	const frames = [
		{ id: "earlier-event", type: "execution.status", status: "completed" },
		{ id: "current-event", type: "execution.status", status: "submitted" },
	];
	assert.deepEqual(currentExecutionFrames(events, frames), [frames[1]]);
	assert.deepEqual(currentExecutionFrames(events, null), []);
	assert.deepEqual(currentExecutionFrames(null, frames), []);
	assert.deepEqual(currentExecutionFrames(events, [null, ...frames]), [
		frames[1],
	]);
});

test("persisted event validation rejects missing execution IDs in either history subset", () => {
	for (const index of [0, 1]) {
		for (const executionId of [undefined, null, "", 0, {}]) {
			const detail = mixedHistoryDetail();
			detail.events[index] = { ...detail.events[index], executionId };
			assert.equal(
				currentExecutionEvents(detail, "conversation-1", "execution-1"),
				null,
				`event ${index} with executionId=${String(executionId)} must be rejected`,
			);
		}
	}
});

test("persisted event validation binds the conversation and unique event identities", () => {
	const detail = mixedHistoryDetail();
	assert.equal(
		currentExecutionEvents(
			{
				...detail,
				conversation: { ...detail.conversation, conversationId: "other" },
			},
			"conversation-1",
			"execution-1",
		),
		null,
	);
	for (const index of [0, 1]) {
		const events = [...detail.events];
		events[index] = { ...events[index], conversationId: "other" };
		assert.equal(
			currentExecutionEvents(
				{ ...detail, events },
				"conversation-1",
				"execution-1",
			),
			null,
		);
	}
	assert.equal(
		currentExecutionEvents(
			{
				...detail,
				events: [
					{ ...detail.events[0], eventId: "current-event" },
					detail.events[1],
				],
			},
			"conversation-1",
			"execution-1",
		),
		null,
	);
});

test("persisted event validation requires an event from the submitted execution", () => {
	const detail = mixedHistoryDetail();
	assert.equal(
		currentExecutionEvents(detail, "conversation-1", "execution-2"),
		null,
	);
});

test("reload preserves mixed history while allowing later events for the submitted execution", () => {
	const before = mixedHistoryDetail();
	const after = {
		...before,
		events: [...before.events, persistedEvent("later-event", "execution-1")],
	};
	assert.equal(
		restoredHistoryPreservesEvents(
			before,
			after,
			"conversation-1",
			"execution-1",
		),
		true,
	);
	assert.equal(
		restoredHistoryPreservesEvents(
			before,
			{ ...after, events: [after.events[1], after.events[0], after.events[2]] },
			"conversation-1",
			"execution-1",
		),
		false,
	);
	assert.equal(
		restoredHistoryPreservesEvents(
			before,
			{ ...after, events: after.events.slice(1) },
			"conversation-1",
			"execution-1",
		),
		false,
	);
	for (const index of [0, 1]) {
		const events = [...after.events];
		events[index] = {
			...events[index],
			executionId: index === 0 ? "execution-1" : "execution-old",
		};
		assert.equal(
			restoredHistoryPreservesEvents(
				before,
				{ ...after, events },
				"conversation-1",
				"execution-1",
			),
			false,
			`event ${index} must retain its execution binding after reload`,
		);
	}
	for (const changed of [
		{ type: "execution.status", payload: { status: "failed" } },
		{ type: "text.delta", payload: { text: "changed history" } },
	]) {
		const events = [
			{ ...after.events[0], ...changed },
			...after.events.slice(1),
		];
		const altered = ConversationDetailProjectionV2Schema.parse({
			...after,
			events,
		});
		assert.equal(
			restoredHistoryPreservesEvents(
				before,
				altered,
				"conversation-1",
				"execution-1",
			),
			false,
			"persisted event content must remain unchanged after reload",
		);
	}
});

async function fixtureDirectory() {
	const directory = await mkdtemp(
		join(tmpdir(), "agent-infra-conversation-config-"),
	);
	const ownerState = join(directory, "owner-state.json");
	const otherState = join(directory, "other-state.json");
	const config = join(directory, "journey.json");
	const storageState = JSON.stringify({ cookies: [], origins: [] });
	await writeFile(ownerState, storageState, { mode: 0o600 });
	await writeFile(otherState, storageState, { mode: 0o600 });
	await writeFile(
		config,
		JSON.stringify({
			origin: "http://127.0.0.1:3511",
			agentId: "agent-under-test",
			prompt: "synthetic smoke prompt",
			owner: { userId: "owner", stateFile: ownerState },
			other: { userId: "other", stateFile: otherState },
		}),
		{ mode: 0o600 },
	);
	return { config, ownerState, otherState, directory };
}

test("configuration-only smoke validates private Playwright state without an endpoint", async () => {
	const fixture = await fixtureDirectory();
	try {
		const result = spawnSync(
			process.execPath,
			[script, "--check-config", fixture.config],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		if (result.error) throw result.error;
		if (result.status !== 0)
			throw new Error(`${result.stderr}\n${result.stdout}`);
		const summary = JSON.parse(result.stdout);
		assert.equal(summary.mode, "configuration-only");
		assert.equal(summary.endpointChecked, false);
		assert.equal(summary.origin, "http://127.0.0.1:3511");
		assert.match(summary.agentHash, /^[a-f0-9]{64}$/);
		assert.match(summary.ownerUserHash, /^[a-f0-9]{64}$/);
		assert.match(summary.otherUserHash, /^[a-f0-9]{64}$/);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("configuration-only smoke rejects a state file readable by other users", async () => {
	const fixture = await fixtureDirectory();
	try {
		await chmod(fixture.otherState, 0o644);
		const result = spawnSync(
			process.execPath,
			[script, "--check-config", fixture.config],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		if (result.error) throw result.error;
		assert.notEqual(result.status, 0);
		assert.match(`${result.stderr}${result.stdout}`, /must be private/);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("configuration-only smoke validates real acceptance gates", async () => {
	const fixture = await fixtureDirectory();
	try {
		const parsed = JSON.parse(await readFile(fixture.config, "utf8"));
		parsed.acceptance = {
			requireThinking: true,
			requireResultFile: true,
			requireSkillMetadata: true,
			requiredSkillName: "workspace-summary",
			requireToolOperation: true,
			requiredToolId: "workspace-summary",
		};
		await writeFile(fixture.config, JSON.stringify(parsed), { mode: 0o600 });
		const result = spawnSync(
			process.execPath,
			[script, "--check-config", fixture.config],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		if (result.error) throw result.error;
		assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

		parsed.acceptance.requireThinking = "yes";
		await writeFile(fixture.config, JSON.stringify(parsed), { mode: 0o600 });
		const invalid = spawnSync(
			process.execPath,
			[script, "--check-config", fixture.config],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		if (invalid.error) throw invalid.error;
		assert.notEqual(invalid.status, 0);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("configuration-only smoke does not expose malformed state file contents", async () => {
	const fixture = await fixtureDirectory();
	try {
		const secret = "cookie-secret-must-not-leak";
		await writeFile(fixture.ownerState, `not-json ${secret}`, { mode: 0o600 });
		const result = spawnSync(
			process.execPath,
			[script, "--check-config", fixture.config],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		if (result.error) throw result.error;
		assert.notEqual(result.status, 0);
		assert.match(`${result.stderr}${result.stdout}`, /must contain valid JSON/);
		assert.doesNotMatch(`${result.stderr}${result.stdout}`, new RegExp(secret));
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("configuration-only smoke does not expose malformed config contents", async () => {
	const fixture = await fixtureDirectory();
	try {
		const secret = "prompt-secret-must-not-leak";
		await writeFile(fixture.config, `not-json ${secret}`, { mode: 0o600 });
		const result = spawnSync(
			process.execPath,
			[script, "--check-config", fixture.config],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		if (result.error) throw result.error;
		assert.notEqual(result.status, 0);
		assert.match(`${result.stderr}${result.stdout}`, /must contain valid JSON/);
		assert.doesNotMatch(`${result.stderr}${result.stdout}`, new RegExp(secret));
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("terminal acceptance keeps the named Skill projection without a Sandbox request", () => {
	const evidence = {};
	assertAcceptance(
		{
			acceptance: {
				requireSkillMetadata: true,
				requiredSkillName: "workspace-summary",
			},
		},
		[],
		evidence,
		{ capabilities: [{ name: "workspace-summary" }] },
	);
	assert.equal(evidence.acceptance.skillMetadataCount, 1);
});

for (const acceptance of [
	{ requireSkillMetadata: true },
	{ requiredSkillName: "workspace-summary" },
]) {
	test(`terminal acceptance rejects missing or invalid active Skill evidence: ${JSON.stringify(acceptance)}`, () => {
		for (const metadata of [
			undefined,
			null,
			{},
			{ capabilities: null },
			{ capabilities: {} },
		]) {
			assert.throws(
				() => assertAcceptance({ acceptance }, [], {}, metadata),
				/Expected Skill metadata from the active Execution/,
			);
		}
	});
}

test("a cached projection must still contain the required Skill name", () => {
	for (const capabilities of [
		[],
		[{ name: "other-skill" }],
		[null, {}, "workspace-summary"],
	]) {
		assert.throws(
			() =>
				assertAcceptance(
					{ acceptance: { requiredSkillName: "workspace-summary" } },
					[],
					{},
					{ capabilities },
				),
			/Expected Skill workspace-summary/,
		);
	}
});

test("a journey without a Skill requirement does not need metadata", () => {
	const evidence = {};
	assertAcceptance({}, [], evidence, undefined);
	assert.equal(evidence.acceptance.skillMetadataCount, undefined);
});

test("model operations cannot satisfy the real tool requirement", () => {
	assert.throws(
		() =>
			assertAcceptance(
				{ acceptance: { requireToolOperation: true } },
				[{ type: "execution.operation", payload: { kind: "model" } }],
				{},
				undefined,
			),
		/Expected a real tool operation event/,
	);
});
