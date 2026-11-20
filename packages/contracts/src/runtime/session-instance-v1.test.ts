import { expect, it } from "vitest";
import {
	SessionInstanceReadRequestV1Schema,
	sessionInstanceRequestSigningPayloadV1,
} from "./session-instance-v1.js";

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
	authorization: "not-in-the-digest",
};
it("uses the HLD version/method/path tuple and recursively sorted body, excluding authorization", () => {
	expect(sessionInstanceRequestSigningPayloadV1(request)).toBe(
		'[1,"POST","/internal/runtime/v1/session-instance/read",{"agentId":"agent","bindingDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generation":2,"namespace":"ns","nonce":"0123456789abcdef0123456789abcdef","podUid":"pod","profileDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requestId":"read","resourceFence":3,"sandboxId":"sandbox","schemaVersion":1,"scope":{"phase":"reserve","reserveDeliveryFence":7,"reserveRef":"reserve"},"sessionId":"session","startupRef":"start","traceId":"trace","workerId":"worker"}]',
	);
	expect(
		sessionInstanceRequestSigningPayloadV1({
			...request,
			authorization: "other",
		}),
	).toBe(sessionInstanceRequestSigningPayloadV1(request));
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
