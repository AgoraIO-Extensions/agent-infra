import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConversationDetailProjectionV2Schema } from "../../packages/contracts/src/pilot/operation-v2.ts";
import {
	currentExecutionEvents,
	restoredHistoryPreservesEvents,
} from "./conversation-browser-validation.mjs";

const script = join(import.meta.dirname, "conversation-browser.mjs");

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
