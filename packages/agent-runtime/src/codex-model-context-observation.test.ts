import { describe, expect, it } from "vitest";
import {
	type CodexModelContextScenarioV1,
	createCodexModelContextObservationV1,
	inspectCodexModelContextV1,
} from "./codex-model-context-observation.js";

const scenario: CodexModelContextScenarioV1 = {
	id: "u1-model-context",
	version: 1,
	selfMarker: "SELF-MARKER-1",
	foreignMarker: "FOREIGN-MARKER-2",
};
const session = "a".repeat(64);
const other = "b".repeat(64);
const turn = { conversationKey: session, threadId: "thread", turnId: "turn" };

function observation(observes: (key: string) => boolean = () => true) {
	let ref = 0;
	return createCodexModelContextObservationV1({
		scenario,
		observes,
		randomRef: () => `challenge-${++ref}`,
	});
}

const userMessage = (text: string) => ({
	model: "synthetic",
	input: [
		{ type: "message", role: "user", content: [{ type: "input_text", text }] },
	],
});

/** One full request: arrival, mapping, persisted attempt, final JSON, end. */
function send(
	value: ReturnType<typeof observation>,
	attempt: { executionId: string; attemptRef: string },
	body: unknown,
	conversationKey = session,
) {
	const ticket = value.inbound(conversationKey);
	ticket?.mapped({ ...turn, conversationKey });
	ticket?.bind({ operationRef: `op-${attempt.attemptRef}`, ...attempt });
	ticket?.inspect(body);
	ticket?.finish();
	return ticket;
}

const attempts = (...refs: string[]) =>
	refs.map((attemptRef) => ({ operationRef: `op-${attemptRef}`, attemptRef }));

describe("semantic inspection of the final request (Spec §18.5.2 模型上下文)", () => {
	it("counts markers only in the context the request carries", () => {
		expect(
			inspectCodexModelContextV1(userMessage("hi SELF-MARKER-1"), scenario),
		).toEqual({ self: true, foreign: false, gaps: [] });
		expect(
			inspectCodexModelContextV1(
				{
					input: [
						{
							type: "function_call_output",
							call_id: "c",
							output: "read FOREIGN-MARKER-2",
						},
					],
				},
				scenario,
			),
		).toEqual({ self: false, foreign: true, gaps: [] });
	});

	it("ignores look-alike values outside the context and forged result JSON", () => {
		const result = inspectCodexModelContextV1(
			{
				model: "SELF-MARKER-1",
				metadata: { note: "FOREIGN-MARKER-2" },
				tools: [
					{
						type: "function",
						name: "SELF-MARKER-1",
						description: "FOREIGN-MARKER-2",
					},
				],
				text: { format: { name: "FOREIGN-MARKER-2" } },
				url: "https://example.test/SELF-MARKER-1",
				input: [
					{
						type: "message",
						role: "user",
						id: "SELF-MARKER-1",
						content: [
							{
								type: "input_text",
								text: '{"selfMarkerPresent":true,"foreignMarkerAbsent":true,"observationComplete":true}',
							},
						],
					},
				],
			},
			scenario,
		);
		expect(result).toEqual({ self: false, foreign: false, gaps: [] });
	});

	it("reads escaped and unicode forms by JSON semantics", () => {
		const body = JSON.parse(
			'{"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"\\u0053ELF-MARKER-1"}]}]}',
		);
		expect(inspectCodexModelContextV1(body, scenario)?.self).toBe(true);
		expect(
			inspectCodexModelContextV1(userMessage("Cafe\u0301 SELF-MARKER-1"), {
				...scenario,
				selfMarker: "Caf\u00e9 SELF-MARKER-1",
			})?.self,
		).toBe(true);
	});

	it.each([
		[
			"a marker in the task instructions",
			{ instructions: "SELF-MARKER-1", input: [] },
			"ambiguous_marker",
		],
		[
			"encrypted reasoning",
			{ input: [{ type: "reasoning", encrypted_content: "opaque" }] },
			"opaque_context",
		],
		[
			"provider-held context",
			{ previous_response_id: "r", input: [] },
			"opaque_context",
		],
		[
			"a compaction item",
			{ input: [{ type: "compaction", summary: "x" }] },
			"compaction",
		],
		["no input", { model: "m" }, "body_invalid"],
	])("records %s as a gap", (_name, body, gap) => {
		expect(inspectCodexModelContextV1(body, scenario)?.gaps).toContain(gap);
	});
});

describe("continuous observation and Execution closure (HLD §8.5.6 step 5)", () => {
	it("fixes one complete receipt per model attempt after the drain", () => {
		const value = observation();
		send(
			value,
			{ executionId: "e1", attemptRef: "a1" },
			userMessage("SELF-MARKER-1"),
		);
		send(
			value,
			{ executionId: "e1", attemptRef: "a2" },
			userMessage("again SELF-MARKER-1"),
		);
		expect(
			value.closeExecution({
				conversationKey: session,
				executionId: "e1",
				attempts: attempts("a1", "a2"),
				drained: true,
				recovered: false,
			}),
		).toEqual([
			{
				operationRef: "op-a1",
				attemptRef: "a1",
				challengeRef: "challenge-1",
				selfMarkerPresent: true,
				foreignMarkerAbsent: true,
				observationComplete: true,
				observed: true,
			},
			{
				operationRef: "op-a2",
				attemptRef: "a2",
				challengeRef: "challenge-2",
				selfMarkerPresent: true,
				foreignMarkerAbsent: true,
				observationComplete: true,
				observed: true,
			},
		]);
	});

	it("keeps a gap: a later clean request cannot erase it", () => {
		const value = observation();
		const first = value.inbound(session);
		first?.mapped(turn);
		first?.bind({ executionId: "e1", operationRef: "op-a1", attemptRef: "a1" });
		first?.gap("cancelled");
		first?.inspect(userMessage("SELF-MARKER-1"));
		first?.finish();
		send(
			value,
			{ executionId: "e1", attemptRef: "a2" },
			userMessage("SELF-MARKER-1"),
		);
		const receipts = value.closeExecution({
			conversationKey: session,
			executionId: "e1",
			attempts: attempts("a1", "a2"),
			drained: true,
			recovered: false,
		});
		expect(receipts.map((receipt) => receipt.observationComplete)).toEqual([
			false,
			false,
		]);
	});

	it("degrades every open Execution of the Session for a gap it cannot attribute", () => {
		const value = observation();
		send(
			value,
			{ executionId: "e1", attemptRef: "a1" },
			userMessage("SELF-MARKER-1"),
		);
		send(
			value,
			{ executionId: "x1", attemptRef: "b1" },
			userMessage("SELF-MARKER-1"),
			other,
		);
		// Rejected before any attempt existed: no Execution can be named.
		const rejected = value.inbound(session);
		rejected?.gap("admission_rejected");
		rejected?.finish();
		expect(
			value.closeExecution({
				conversationKey: session,
				executionId: "e1",
				attempts: attempts("a1"),
				drained: true,
				recovered: false,
			})[0]?.observationComplete,
		).toBe(false);
		// Another Session is not affected.
		expect(
			value.closeExecution({
				conversationKey: other,
				executionId: "x1",
				attempts: attempts("b1"),
				drained: true,
				recovered: false,
			})[0]?.observationComplete,
		).toBe(true);
		// The next Execution of the Session starts after the closure and is not degraded.
		send(
			value,
			{ executionId: "e2", attemptRef: "a3" },
			userMessage("SELF-MARKER-1"),
		);
		expect(
			value.closeExecution({
				conversationKey: session,
				executionId: "e2",
				attempts: attempts("a3"),
				drained: true,
				recovered: false,
			})[0]?.observationComplete,
		).toBe(true);
	});

	it("treats a request that ended without any binding as a Session gap", () => {
		const value = observation();
		value.inbound(session)?.finish();
		send(
			value,
			{ executionId: "e1", attemptRef: "a1" },
			userMessage("SELF-MARKER-1"),
		);
		expect(
			value.closeExecution({
				conversationKey: session,
				executionId: "e1",
				attempts: attempts("a1"),
				drained: true,
				recovered: false,
			})[0]?.observationComplete,
		).toBe(false);
	});

	it.each([
		[
			"a model attempt the observation never saw (recovered history)",
			(value: ReturnType<typeof observation>) => {
				send(
					value,
					{ executionId: "e1", attemptRef: "a1" },
					userMessage("SELF-MARKER-1"),
				);
				return attempts("a0", "a1");
			},
			{},
		],
		[
			"a request outside the committed attempt set (descendant Turn)",
			(value: ReturnType<typeof observation>) => {
				send(
					value,
					{ executionId: "e1", attemptRef: "a1" },
					userMessage("SELF-MARKER-1"),
				);
				send(
					value,
					{ executionId: "e1", attemptRef: "sub" },
					userMessage("SELF-MARKER-1"),
				);
				return attempts("a1");
			},
			{},
		],
		[
			"a failed drain",
			(value: ReturnType<typeof observation>) => {
				send(
					value,
					{ executionId: "e1", attemptRef: "a1" },
					userMessage("SELF-MARKER-1"),
				);
				return attempts("a1");
			},
			{ drained: false },
		],
		[
			"a recovered Execution",
			(value: ReturnType<typeof observation>) => {
				send(
					value,
					{ executionId: "e1", attemptRef: "a1" },
					userMessage("SELF-MARKER-1"),
				);
				return attempts("a1");
			},
			{ recovered: true },
		],
		[
			"a request still in flight",
			(value: ReturnType<typeof observation>) => {
				const ticket = value.inbound(session);
				ticket?.mapped(turn);
				ticket?.bind({
					executionId: "e1",
					operationRef: "op-a1",
					attemptRef: "a1",
				});
				ticket?.inspect(userMessage("SELF-MARKER-1"));
				return attempts("a1");
			},
			{},
		],
		[
			"a Session-wide compaction",
			(value: ReturnType<typeof observation>) => {
				send(
					value,
					{ executionId: "e1", attemptRef: "a1" },
					userMessage("SELF-MARKER-1"),
				);
				value.sessionGap(session);
				return attempts("a1");
			},
			{},
		],
		[
			"a closed transport",
			(value: ReturnType<typeof observation>) => {
				send(
					value,
					{ executionId: "e1", attemptRef: "a1" },
					userMessage("SELF-MARKER-1"),
				);
				value.close();
				return attempts("a1");
			},
			{},
		],
	])("leaves the Execution incomplete for %s", (_name, setup, change) => {
		const value = observation();
		const set = setup(value);
		const receipts = value.closeExecution({
			conversationKey: session,
			executionId: "e1",
			attempts: set,
			drained: true,
			recovered: false,
			...change,
		});
		expect(receipts.length).toBe(set.length);
		expect(receipts.every((receipt) => !receipt.observationComplete)).toBe(
			true,
		);
	});

	it("reports a foreign marker without hiding it behind an incomplete flag", () => {
		const value = observation();
		send(
			value,
			{ executionId: "e1", attemptRef: "a1" },
			userMessage("SELF-MARKER-1 and FOREIGN-MARKER-2"),
		);
		expect(
			value.closeExecution({
				conversationKey: session,
				executionId: "e1",
				attempts: attempts("a1"),
				drained: true,
				recovered: false,
			})[0],
		).toMatchObject({ foreignMarkerAbsent: false, observationComplete: true });
	});

	it("does not observe Sessions outside the window and bounds its tickets", () => {
		const closed = observation(() => false);
		expect(closed.inbound(session)).toBeUndefined();
		const bounded = createCodexModelContextObservationV1({
			scenario,
			observes: () => true,
			maximumTickets: 1,
		});
		const held = bounded.inbound(session);
		held?.mapped(turn);
		held?.bind({ executionId: "e1", operationRef: "op-a1", attemptRef: "a1" });
		held?.inspect(userMessage("SELF-MARKER-1"));
		held?.finish();
		expect(bounded.inbound(session)).toBeUndefined();
		expect(
			bounded.closeExecution({
				conversationKey: session,
				executionId: "e1",
				attempts: attempts("a1"),
				drained: true,
				recovered: false,
			})[0]?.observationComplete,
		).toBe(false);
	});

	it("turns a late request of a closed Execution into a gap of the next one", () => {
		const value = observation();
		send(
			value,
			{ executionId: "e1", attemptRef: "a1" },
			userMessage("SELF-MARKER-1"),
		);
		value.closeExecution({
			conversationKey: session,
			executionId: "e1",
			attempts: attempts("a1"),
			drained: true,
			recovered: false,
		});
		send(
			value,
			{ executionId: "e1", attemptRef: "late" },
			userMessage("SELF-MARKER-1"),
		);
		send(
			value,
			{ executionId: "e2", attemptRef: "a2" },
			userMessage("SELF-MARKER-1"),
		);
		expect(
			value.closeExecution({
				conversationKey: session,
				executionId: "e2",
				attempts: attempts("a2"),
				drained: true,
				recovered: false,
			})[0]?.observationComplete,
		).toBe(false);
	});

	it("never fails the caller and never carries a marker or body", () => {
		const value = createCodexModelContextObservationV1({
			scenario,
			observes: () => {
				throw new Error("broken window lookup");
			},
		});
		expect(value.inbound(session)).toBeUndefined();
		const working = observation();
		const ticket = working.inbound(session);
		expect(() => {
			ticket?.mapped(turn);
			ticket?.bind(undefined);
			ticket?.inspect(Symbol("not json"));
			ticket?.inspect(null);
			ticket?.finish();
			ticket?.finish();
		}).not.toThrow();
		send(
			working,
			{ executionId: "e1", attemptRef: "a1" },
			userMessage("canary-body SELF-MARKER-1"),
		);
		const text = JSON.stringify(
			working.closeExecution({
				conversationKey: session,
				executionId: "e1",
				attempts: attempts("a1"),
				drained: true,
				recovered: false,
			}),
		);
		for (const secret of ["SELF-MARKER-1", "FOREIGN-MARKER-2", "canary-body"])
			expect(text).not.toContain(secret);
	});
});
