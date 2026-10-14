import { describe, expect, it } from "vitest";
import {
	parseMessageOutbox,
	parseRegenerationOutbox,
	parseStopOutbox,
} from "./conversation-execution-payloads.js";

const traceParent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const base = {
	conversationId: "conversation",
	executionId: "execution",
	traceId: "trace",
	requestId: "request",
	occurredAt: new Date("2026-09-04T00:00:00.000Z"),
};
const turn = {
	...base,
	messageId: "message",
	turnId: "turn",
	sessionGeneration: 1,
	modelConfigurationRevision: null,
	modelOptionId: null,
	reasoningLevel: null,
};
const cases = [
	{
		name: "message",
		parse: parseMessageOutbox,
		record: { ...turn, operation: "conversation.turn.submit.v1" },
	},
	{
		name: "supplement",
		parse: parseMessageOutbox,
		record: { ...turn, operation: "conversation.turn.supplement.v1" },
	},
	{
		name: "regeneration",
		parse: parseRegenerationOutbox,
		record: { ...turn, operation: "conversation.turn.regenerate.v1" },
	},
	{
		name: "stop",
		parse: parseStopOutbox,
		record: {
			...base,
			operation: "conversation.turn.stop.v1",
			sessionGeneration: 1,
			stopRequestId: "stop",
		},
	},
] as const;

describe("durable command outbox records (#2473)", () => {
	describe.each(cases)("$name", ({ parse, record }) => {
		it("accepts a record without a traceparent and does not invent one", () => {
			expect(parse(record)).not.toHaveProperty("traceParent");
		});

		it("keeps a valid W3C traceparent", () => {
			expect(parse({ ...record, traceParent })).toMatchObject({ traceParent });
		});

		it.each([
			["not a string", 7],
			["too short", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331"],
			["wrong version", `01${traceParent.slice(2)}`],
			["all-zero trace id", `00-${"0".repeat(32)}-b7ad6b7169203331-01`],
			[
				"all-zero span id",
				`00-0af7651916cd43dd8448eb211c80319c-${"0".repeat(16)}-01`,
			],
			["null", null],
			["empty", ""],
		])("rejects a malformed traceparent (%s)", (_name, value) => {
			expect(() => parse({ ...record, traceParent: value })).toThrow(
				expect.objectContaining({ code: "unavailable" }),
			);
		});

		it("still rejects unknown keys", () => {
			expect(() => parse({ ...record, traceParent, extra: true })).toThrow();
			expect(() => parse({ ...record, surprise: 1 })).toThrow();
		});
	});
});
