import { describe, expect, it } from "vitest";
import {
	parseSessionInstanceJsonV1,
	SessionInstanceReadBodyV1Schema,
	sessionInstanceReadSigningPayloadV1,
} from "./session-instance.js";

const body = {
	schemaVersion: 1,
	requestId: "request",
	traceId: "trace",
	nonce: "123e4567-e89b-42d3-a456-426614174099",
	workerId: "worker",
	namespace: "runtime",
	agentId: "agent",
	sessionId: "session",
	sandboxId: "sandbox",
	podUid: "pod",
	generation: 1,
	resourceFence: 1,
	startupRef: "executor-v2-ref",
	bindingDigest: "a".repeat(64),
	profileDigest: "b".repeat(64),
	scope: {
		phase: "reserve",
		reserveRef: "reserve:sandbox",
		reserveDeliveryFence: 2,
	},
};
describe("Session instance read V1 approved wire", () => {
	it("rejects unknown and business fields while retaining the exact reserve scope", () => {
		expect(SessionInstanceReadBodyV1Schema.parse(body)).toEqual(body);
		expect(
			SessionInstanceReadBodyV1Schema.safeParse({
				...body,
				principal: { kind: "user", id: "borrowed" },
			}).success,
		).toBe(false);
		expect(
			SessionInstanceReadBodyV1Schema.safeParse({
				...body,
				scope: { ...body.scope, claimRef: "claimed" },
			}).success,
		).toBe(false);
		expect(sessionInstanceReadSigningPayloadV1(body)).toBe(
			sessionInstanceReadSigningPayloadV1(
				Object.fromEntries(Object.entries(body).reverse()),
			),
		);
	});
	it("rejects duplicate including escaped JSON keys", () => {
		expect(
			parseSessionInstanceJsonV1('{"x":"ok:y", "nested":{"a":1}}'),
		).toEqual({ x: "ok:y", nested: { a: 1 } });
		for (const text of [
			'{"x":1,"x":2}',
			'{"x":1,"\\u0078":2}',
			'{"nested":{"a":1,"a":2}}',
		])
			expect(() => parseSessionInstanceJsonV1(text)).toThrow();
	});
});
