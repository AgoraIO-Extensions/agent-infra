import { describe, expect, it } from "vitest";
import {
	parseSessionInstanceJsonV1,
	SessionInstanceEvidenceV1Schema,
	SessionInstanceReadBodyV1Schema,
	SessionInstanceReadRequestV1Schema,
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

const request = {
	schemaVersion: 1 as const,
	requestId: "read",
	traceId: "trace",
	nonce: "0123456789abcdef0123456789abcdef",
	workerId: "worker",
	namespace: "ns",
	agentId: "agent",
	sessionId: "session",
	sandboxId: "sandbox",
	podUid: "pod",
	generation: 2,
	resourceFence: 3,
	startupRef: "start",
	bindingDigest: "a".repeat(64),
	profileDigest: "b".repeat(64),
	scope: {
		phase: "reserve" as const,
		reserveRef: "reserve",
		reserveDeliveryFence: 7,
	},
	authorization: "e30.e30.AA",
};
it("uses the HLD version/method/path tuple and a recursively sorted body without authorization", () => {
	const { authorization: _authorization, ...requestBody } = request;
	expect(sessionInstanceReadSigningPayloadV1(requestBody)).toBe(
		'[1,"POST","/internal/runtime/v1/session-instance/read",{"agentId":"agent","bindingDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generation":2,"namespace":"ns","nonce":"0123456789abcdef0123456789abcdef","podUid":"pod","profileDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requestId":"read","resourceFence":3,"sandboxId":"sandbox","schemaVersion":1,"scope":{"phase":"reserve","reserveDeliveryFence":7,"reserveRef":"reserve"},"sessionId":"session","startupRef":"start","traceId":"trace","workerId":"worker"}]',
	);
	expect(() => sessionInstanceReadSigningPayloadV1(request)).toThrow();
});
it.each([
	{ extra: true },
	{ scope: { ...request.scope, allocationRef: "not-reserve" } },
	{ generation: 0 },
	{ resourceFence: 1.1 },
	{ generation: Number.MAX_SAFE_INTEGER + 1 },
	{ profileDigest: "B".repeat(64) },
	{ scope: { phase: "claimed", claimRef: "claim" } },
	{ schemaVersion: 2 },
])("rejects non-contract evidence read shape %j", (change) => {
	expect(
		SessionInstanceReadRequestV1Schema.safeParse({ ...request, ...change })
			.success,
	).toBe(false);
});

it.each(["123e4567-e89b-42d3-a456-426614174099", "runner-original"])(
	"accepts the contract opaque runner epoch %s",
	(runnerEpoch) => {
		expect(
			SessionInstanceEvidenceV1Schema.parse({
				...body,
				requestDigest: "c".repeat(64),
				hostKeyId: "host-key",
				runnerEpoch,
				observedAt: 1000,
				expiresAt: 2000,
				checks: {
					hostIdentityConsumed: true,
					runnerIdentityConsumed: true,
					deliveryFilesRemoved: true,
					executorReady: true,
					emptyBusinessState: true,
				},
				signature: "e30.e30.AA",
			}).runnerEpoch,
		).toBe(runnerEpoch);
	},
);
