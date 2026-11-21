import { expect, it } from "vitest";
import {
	advanceConversationArchiveV1,
	parseConversationArchiveStateV1,
	projectConversationArchiveV1,
} from "./conversation-archive.js";

const state = {
	schemaVersion: 1 as const,
	ref: "archive-1",
	revision: 1,
	status: "pending" as const,
	startedAtMs: 1000,
	deadlineAtMs: 2000,
	lastProgressAtMs: null,
	cursor: null,
	acknowledgedCursor: null,
};
it("projects only the independent bounded gap and hides private references", () => {
	expect(projectConversationArchiveV1(state)).toEqual({
		schemaVersion: 1,
		status: "pending",
		deadlineAt: new Date(2000).toISOString(),
	});
	expect(
		projectConversationArchiveV1({ ...state, status: "complete" }),
	).toBeUndefined();
	expect(
		projectConversationArchiveV1({ ...state, status: "unavailable" }),
	).toMatchObject({ status: "unavailable" });
});
it.each([
	{ ...state, deadlineAtMs: 1000 },
	{ ...state, revision: 0 },
	{ ...state, privateKey: "not-a-field" },
	{ ...state, lastProgressAtMs: 999 },
])("rejects malformed or secret-bearing archive state", (value) => {
	expect(() => parseConversationArchiveStateV1(value)).toThrow();
});

it("keeps the original absolute deadline across progress, retry and restart", () => {
	const first = advanceConversationArchiveV1({
		ref: "original",
		nowMs: 1000,
		budgetMs: 1000,
		cursor: null,
	});
	const progress = advanceConversationArchiveV1({
		previous: first,
		ref: "ignored",
		nowMs: 1500,
		budgetMs: 999999,
		cursor: "cursor-1",
		acknowledgedCursor: "cursor-1",
	});
	expect(progress).toMatchObject({
		ref: "original",
		startedAtMs: 1000,
		deadlineAtMs: 2000,
		lastProgressAtMs: 1500,
	});
	const expired = advanceConversationArchiveV1({
		previous: progress,
		ref: "ignored",
		nowMs: 2000,
		budgetMs: 999999,
		cursor: "cursor-1",
	});
	expect(expired).toMatchObject({
		status: "unavailable",
		deadlineAtMs: 2000,
		lastProgressAtMs: 1500,
	});
});

it("does not turn late ACK/progress into an extended archive budget", () => {
	const previous = advanceConversationArchiveV1({
		ref: "original",
		nowMs: 1000,
		budgetMs: 1000,
		cursor: null,
	});
	expect(
		advanceConversationArchiveV1({
			previous,
			ref: "ignored",
			nowMs: 2000,
			budgetMs: 999999,
			cursor: "late",
			acknowledgedCursor: "late",
			complete: true,
		}).status,
	).toBe("unavailable");
});
