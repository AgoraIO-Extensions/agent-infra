import { createHash } from "node:crypto";
import { planConnectionConsumerRegistrationV1 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import { createConnectionConsumerRegistrationHttpAdapterV1 } from "./connection-registration-http.js";

const policy = {
	schemaVersion: 1 as const,
	sourceNamespace: "synthetic.platform",
	revision: "synthetic-1",
	callbackUrl: "https://platform.example.test/connection/callback",
	resource: "https://connection.example.test/mcp",
	scope: "mcp mcp:tools",
};
const intent = planConnectionConsumerRegistrationV1({
	policy,
	platformAgentId: "agent-a",
	platformOwnerId: "platform-owner-a",
	consumerName: "Agent A",
});
const digest =
	"connection-json-v2:761657db324ae502b30c09195e47881db2221b2711bfa60088275721da427919";
const owner = {
	sourceNamespace: intent.sourceNamespace,
	platformAgentId: intent.platformAgentId,
	platformOwnerId: intent.platformOwnerId,
	ownerPrincipalId: "principal-a",
	companyId: "company-a",
};
const keyHash = createHash("sha256")
	.update(intent.idempotencyKey)
	.digest("hex");
const root = `https://connection.example.test/connection/internal/v1/platform-agent-consumer-registrations/${intent.sourceNamespace}/agent-a`;
function result(): {
	receipt: Record<string, unknown>;
	operation: Record<string, unknown>;
} {
	return {
		receipt: {
			schemaVersion: 1,
			registrationId: "registration-a",
			sourceReceipt: "source-receipt-a",
			sourceNamespace: intent.sourceNamespace,
			platformAgentId: intent.platformAgentId,
			consumerId: "consumer-a",
			executionMode: "USER",
			ownerPrincipalId: owner.ownerPrincipalId,
			companyId: owner.companyId,
			consumerName: "Agent A",
			callbackUrl: policy.callbackUrl,
			resource: policy.resource,
			scopes: ["mcp", "mcp:tools"],
			policyRevision: policy.revision,
			status: "ACTIVE",
			revision: "1",
			requestKeyHash: keyHash,
			requestDigestVersion: "platform-agent-consumer-v1/connection-json-v2",
			requestDigest: digest,
		},
		operation: {
			schemaVersion: 1,
			kind: "create",
			sourceNamespace: intent.sourceNamespace,
			platformAgentId: intent.platformAgentId,
			consumerId: "consumer-a",
			registrationId: "registration-a",
			requestKeyHash: keyHash,
			requestDigestVersion: "platform-agent-consumer-v1/connection-json-v2",
			requestDigest: digest,
			expectedRevision: null,
			resultRevision: "1",
			status: "APPLIED",
			failureCode: null,
		},
	};
}
function response(value: unknown = result(), status = 200) {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
}
function fixture(reply: () => Response | Promise<Response> = () => response()) {
	const authenticatedRequest = vi.fn(async (_request: Request) => reply());
	const resolveOwnerBinding = vi.fn(async () => ({ ...owner }));
	const options = {
		publicOrigin: "https://connection.example.test",
		policy,
		authenticatedRequest,
		resolveOwnerBinding,
	};
	const adapter = createConnectionConsumerRegistrationHttpAdapterV1(options);
	if (!adapter) throw new Error("Fixture adapter is unavailable");
	return { adapter, options, authenticatedRequest, resolveOwnerBinding };
}
const signal = () => new AbortController().signal;

describe("Connection registration HTTP consumer of the fixed v1 contract", () => {
	it("stays absent when either approved deployment boundary is missing", () => {
		const f = fixture();
		for (const options of [
			{ ...f.options, authenticatedRequest: undefined },
			{ ...f.options, resolveOwnerBinding: undefined },
			{
				...f.options,
				authenticatedRequest: undefined,
				resolveOwnerBinding: undefined,
			},
		])
			expect(
				createConnectionConsumerRegistrationHttpAdapterV1(options),
			).toBeUndefined();
		expect(f.authenticatedRequest).not.toHaveBeenCalled();
	});
	it.each([
		"http://connection.example.test",
		"https://connection.example.test/",
		"https://connection.example.test/other",
	])("rejects an origin override %s", (publicOrigin) => {
		expect(() =>
			createConnectionConsumerRegistrationHttpAdapterV1({
				...fixture().options,
				publicOrigin,
			}),
		).toThrow();
	});
	it("sends only the six declared body fields to the fixed per-Agent path", async () => {
		const f = fixture();
		const outcome = await f.adapter.register(intent, signal());
		expect(outcome).toEqual({
			outcome: "registered",
			receipt: {
				schemaVersion: 1,
				operationId: intent.operationId,
				sourceNamespace: intent.sourceNamespace,
				sourceKey: intent.sourceKey,
				consumerId: "consumer-a",
				consumerRevision: "1",
				registrationId: "registration-a",
				requestDigest: intent.requestDigest,
			},
		});
		const request = f.authenticatedRequest.mock.calls[0]?.[0];
		if (!request) throw new Error("Expected the original request");
		expect(request.url).toBe(root);
		expect(request.method).toBe("POST");
		expect(request.headers.get("idempotency-key")).toBe(intent.idempotencyKey);
		expect(request.headers.has("cookie")).toBe(false);
		expect(request.headers.has("authorization")).toBe(false);
		expect(request.credentials).toBe("omit");
		expect(request.redirect).toBe("error");
		expect(await request.json()).toEqual({
			schemaVersion: 1,
			policyRevision: policy.revision,
			consumerName: "Agent A",
			callbackUrl: policy.callbackUrl,
			resource: policy.resource,
			scopes: ["mcp", "mcp:tools"],
		});
		expect(f.resolveOwnerBinding).toHaveBeenCalledWith(
			intent,
			expect.any(AbortSignal),
		);
		expect(intent.requestDigest).not.toBe(digest);
	});
	it("uses the published NFC/UTF-8 digest vector without rewriting local intent", async () => {
		const original = planConnectionConsumerRegistrationV1({
			policy,
			platformAgentId: "agent-a",
			platformOwnerId: intent.platformOwnerId,
			consumerName: "Agent e\u0301 🛰",
		});
		const value = result();
		value.receipt.consumerName = "Agent é 🛰";
		value.receipt.requestDigest =
			"connection-json-v2:f438b2194ab16295848d5415b114279c740c3681a749de365f5f8dd2989cd2c1";
		value.operation.requestDigest = value.receipt.requestDigest;
		const f = fixture(() => response(value));
		const outcome = await f.adapter.register(original, signal());
		expect(outcome.outcome).toBe("registered");
		if (outcome.outcome !== "registered")
			throw new Error("Expected a verified receipt");
		expect(outcome.receipt.requestDigest).toBe(original.requestDigest);
		expect(original.consumerName).toBe("Agent e\u0301 🛰");
		const request = f.authenticatedRequest.mock.calls[0]?.[0];
		if (!request) throw new Error("Expected the original request");
		expect(await request.json()).toMatchObject({ consumerName: "Agent é 🛰" });
	});
	it("keeps another Agent's path, command and verified Consumer distinct", async () => {
		const second = planConnectionConsumerRegistrationV1({
			policy,
			platformAgentId: "agent-b",
			platformOwnerId: intent.platformOwnerId,
			consumerName: "Agent A",
		});
		const value = result();
		const secondKey = createHash("sha256")
			.update(second.idempotencyKey)
			.digest("hex");
		for (const item of [value.receipt, value.operation]) {
			item.platformAgentId = "agent-b";
			item.consumerId = "consumer-b";
			item.registrationId = "registration-b";
			item.requestKeyHash = secondKey;
			item.requestDigest =
				"connection-json-v2:8120dc575e1315864f41c4ffcc4c7ab20c63edf2f338bafde2078007a14848c3";
		}
		const f = fixture(() => response(value));
		f.resolveOwnerBinding.mockResolvedValue({
			...owner,
			platformAgentId: "agent-b",
		});
		const outcome = await f.adapter.register(second, signal());
		expect(outcome.outcome).toBe("registered");
		if (outcome.outcome !== "registered")
			throw new Error("Expected the second Agent receipt");
		expect(outcome.receipt.consumerId).toBe("consumer-b");
		expect(f.authenticatedRequest.mock.calls[0]?.[0].url).toBe(
			root.replace("agent-a", "agent-b"),
		);
		expect(
			f.authenticatedRequest.mock.calls[0]?.[0].headers.get("idempotency-key"),
		).toBe(second.idempotencyKey);
		expect(second.idempotencyKey).not.toBe(intent.idempotencyKey);
	});
	it("performs one original-operation GET after a lost POST response", async () => {
		const f = fixture();
		f.authenticatedRequest.mockRejectedValueOnce(new Error("response-lost"));
		expect((await f.adapter.register(intent, signal())).outcome).toBe(
			"unknown",
		);
		expect((await f.adapter.reconcile(intent, signal())).outcome).toBe(
			"registered",
		);
		const requests = f.authenticatedRequest.mock.calls.map(([r]) => r);
		expect(requests.map((r) => r.method)).toEqual(["POST", "GET"]);
		expect(requests[1]?.url).toBe(`${root}/operations/create/${keyHash}`);
		expect(requests[1]?.body).toBeNull();
		expect(requests[1]?.headers.has("idempotency-key")).toBe(false);
	});
	it.each([400, 401, 404, 409, 413, 500, 503, 302])(
		"keeps HTTP %s unknown without retry or a replacement",
		async (status) => {
			const f = fixture(() =>
				response({ error: { message: "do-not-persist" } }, status),
			);
			expect((await f.adapter.reconcile(intent, signal())).outcome).toBe(
				"unknown",
			);
			expect(f.authenticatedRequest).toHaveBeenCalledOnce();
			expect(f.authenticatedRequest.mock.calls[0]?.[0].method).toBe("GET");
		},
	);
	it.each(["PENDING", "UNKNOWN"])(
		"preserves %s instead of claiming activation",
		async (status) => {
			const value = result();
			value.operation.status = status;
			value.operation.resultRevision = null;
			value.receipt.status = status;
			const f = fixture(() => response(value, 202));
			expect((await f.adapter.register(intent, signal())).outcome).toBe(
				"unknown",
			);
		},
	);
	it("accepts a fully bound original FAILED operation without claiming a Consumer activation", async () => {
		const value = result();
		value.operation.status = "FAILED";
		value.operation.failureCode = "AUTHORITY_CHANGED";
		value.operation.resultRevision = null;
		value.receipt.status = "DISABLED";
		const f = fixture(() => response(value));
		expect(await f.adapter.reconcile(intent, signal())).toEqual({
			outcome: "failed",
			failureCode: "CONNECTION_REGISTRATION_REJECTED",
		});
	});
	it("keeps a contradictory 202 plus FAILED operation unknown", async () => {
		const value = result();
		value.operation.status = "FAILED";
		value.operation.failureCode = "AUTHORITY_CHANGED";
		value.operation.resultRevision = null;
		value.receipt.status = "DISABLED";
		expect(
			(
				await fixture(() => response(value, 202)).adapter.reconcile(
					intent,
					signal(),
				)
			).outcome,
		).toBe("unknown");
	});
	it.each([
		["platformAgentId", "agent-b"],
		["sourceNamespace", "other-source"],
		["ownerPrincipalId", "principal-b"],
		["companyId", "company-b"],
		["executionMode", "FIXED"],
		["callbackUrl", "https://other.example.test/callback"],
		["resource", "https://other.example.test/mcp"],
		["policyRevision", "changed"],
		["consumerName", "Changed"],
		["scopes", ["mcp"]],
		["scopes", ["mcp", "mcp"]],
		["requestKeyHash", "0".repeat(64)],
		["requestDigest", intent.requestDigest],
		["requestDigestVersion", "connection-json-v1"],
		["revision", "0"],
		["revision", "9223372036854775808"],
		["secret", "never-return-this"],
	])(
		"rejects a receipt with mismatched or forbidden %s",
		async (field, value) => {
			const candidate = result();
			(candidate.receipt as Record<string, unknown>)[field as string] = value;
			const f = fixture(() => response(candidate));
			expect((await f.adapter.register(intent, signal())).outcome).toBe(
				"unknown",
			);
		},
	);
	it.each([
		["kind", "disable"],
		["consumerId", "consumer-b"],
		["registrationId", "registration-b"],
		["requestKeyHash", "0".repeat(64)],
		["requestDigest", `connection-json-v2:${"0".repeat(64)}`],
		["expectedRevision", "1"],
		["resultRevision", "2"],
		["failureCode", "UNEXPECTED"],
	])("rejects an operation bound to the wrong %s", async (field, value) => {
		const candidate = result();
		(candidate.operation as Record<string, unknown>)[field] = value;
		const f = fixture(() => response(candidate));
		expect((await f.adapter.reconcile(intent, signal())).outcome).toBe(
			"unknown",
		);
	});
	it.each([
		"sourceNamespace",
		"platformAgentId",
		"platformOwnerId",
		"ownerPrincipalId",
		"companyId",
	] as const)(
		"requires current trusted Owner binding for %s",
		async (field) => {
			const f = fixture();
			f.resolveOwnerBinding.mockResolvedValue({ ...owner, [field]: "other" });
			expect((await f.adapter.register(intent, signal())).outcome).toBe(
				"unknown",
			);
		},
	);
	it("does not confuse Platform Owner with Connection Principal or invent absent mapping", async () => {
		const f = fixture();
		f.resolveOwnerBinding.mockResolvedValue(
			undefined as unknown as typeof owner,
		);
		expect((await f.adapter.register(intent, signal())).outcome).toBe(
			"unknown",
		);
		expect(
			JSON.stringify(await f.adapter.reconcile(intent, signal())),
		).not.toContain(owner.ownerPrincipalId);
	});
	it("strips the optional opaque handoff reference from local persistence", async () => {
		const value = {
			...result(),
			receipt: {
				...result().receipt,
				protectedHandoffRef: `handoff_${"x".repeat(32)}`,
			},
		};
		const f = fixture(() => response(value));
		const local = await f.adapter.register(intent, signal());
		expect(local.outcome).toBe("registered");
		expect(JSON.stringify(local)).not.toContain("handoff_");
	});
	it("does not forward raw transport errors", async () => {
		const f = fixture();
		f.authenticatedRequest.mockRejectedValue(
			new Error("sensitive-upstream-text"),
		);
		expect(
			JSON.stringify(await f.adapter.register(intent, signal())),
		).not.toContain("sensitive-upstream-text");
	});
	it("rejects a changed policy or a malformed original intent before sending", async () => {
		const f = fixture();
		for (const bad of [
			{ ...intent, sourceKey: "agent-b" },
			{ ...intent, requestDigest: "0".repeat(64) },
			planConnectionConsumerRegistrationV1({
				policy: { ...policy, revision: "changed" },
				platformAgentId: "agent-a",
				platformOwnerId: intent.platformOwnerId,
				consumerName: "Agent A",
			}),
		]) {
			expect(await f.adapter.register(bad, signal())).toEqual({
				outcome: "failed",
				failureCode: "CONNECTION_REGISTRATION_REQUEST_INVALID",
			});
			expect((await f.adapter.reconcile(bad, signal())).outcome).toBe(
				"unknown",
			);
		}
		expect(f.authenticatedRequest).not.toHaveBeenCalled();
	});
	it("rejects an over-8KiB request locally without sending or truncating it", async () => {
		const callbackBase = "https://platform.example.test/";
		const resourceBase = "https://connection.example.test/";
		const largePolicy = {
			...policy,
			revision: "p".repeat(128),
			callbackUrl: callbackBase + "x".repeat(2048 - callbackBase.length),
			resource: resourceBase + "x".repeat(2048 - resourceBase.length),
			scope: Array.from({ length: 32 }, (_, i) =>
				`s${i}`.padEnd(100, "x"),
			).join(" "),
		};
		const original = planConnectionConsumerRegistrationV1({
			policy: largePolicy,
			platformAgentId: "agent-a",
			platformOwnerId: intent.platformOwnerId,
			consumerName: "🛰".repeat(200),
		});
		const f = fixture();
		const adapter = createConnectionConsumerRegistrationHttpAdapterV1({
			...f.options,
			policy: largePolicy,
		});
		expect(await adapter?.register(original, signal())).toEqual({
			outcome: "failed",
			failureCode: "CONNECTION_REGISTRATION_REQUEST_INVALID",
		});
		expect(f.authenticatedRequest).not.toHaveBeenCalled();
		expect(original.consumerName).toHaveLength(400);
	});
	it("never sends an already aborted request and rechecks after Owner I/O", async () => {
		const f = fixture();
		const controller = new AbortController();
		controller.abort();
		expect((await f.adapter.register(intent, controller.signal)).outcome).toBe(
			"unknown",
		);
		expect(f.authenticatedRequest).not.toHaveBeenCalled();
		const next = new AbortController();
		f.resolveOwnerBinding.mockImplementation(async () => {
			next.abort();
			return owner;
		});
		expect((await f.adapter.register(intent, next.signal)).outcome).toBe(
			"unknown",
		);
	});
	it("bounds JSON response bytes and cancels an oversized stream", async () => {
		let cancelled = false;
		const f = fixture(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(65537));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{
						headers: {
							"content-type": "application/json",
							"cache-control": "no-store",
						},
					},
				),
		);
		expect((await f.adapter.register(intent, signal())).outcome).toBe(
			"unknown",
		);
		expect(cancelled).toBe(true);
	});
	it("cancels a blocked response read on original-attempt abort", async () => {
		let streamController:
			| ReadableStreamDefaultController<Uint8Array>
			| undefined;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				streamController = controller;
			},
			cancel() {
				cancelled = true;
			},
		});
		const f = fixture(
			() =>
				new Response(stream, {
					headers: {
						"content-type": "application/json",
						"cache-control": "no-store",
					},
				}),
		);
		const controller = new AbortController();
		const run = f.adapter.register(intent, controller.signal);
		await vi.waitFor(() =>
			expect(f.authenticatedRequest).toHaveBeenCalledOnce(),
		);
		await Promise.resolve();
		controller.abort();
		try {
			const outcome = await Promise.race([
				run,
				new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
			]);
			expect(outcome).toEqual({
				outcome: "unknown",
				failureCode: "CONNECTION_REGISTRATION_UNCONFIRMED",
			});
			expect(cancelled).toBe(true);
		} finally {
			if (!cancelled) streamController?.close();
		}
	});
	it("discards and cancels a response arriving after attempt cancellation", async () => {
		let deliver: ((value: Response) => void) | undefined;
		let cancelled = false;
		const f = fixture(
			() =>
				new Promise<Response>((resolve) => {
					deliver = resolve;
				}),
		);
		const controller = new AbortController();
		const run = f.adapter.register(intent, controller.signal);
		await vi.waitFor(() => expect(deliver).toBeTypeOf("function"));
		controller.abort();
		deliver?.(
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
				{
					headers: {
						"content-type": "application/json",
						"cache-control": "no-store",
					},
				},
			),
		);
		expect((await run).outcome).toBe("unknown");
		expect(cancelled).toBe(true);
		expect(f.resolveOwnerBinding).not.toHaveBeenCalled();
	});
	it.each([
		() =>
			new Response("not-json", {
				headers: {
					"content-type": "application/json",
					"cache-control": "no-store",
				},
			}),
		() => Response.json(result()),
		() =>
			new Response("{}", {
				headers: { "content-type": "text/plain", "cache-control": "no-store" },
			}),
		() => response({ ...result(), token: "forbidden" }),
	])(
		"fails closed on malformed or undeclared response content",
		async (reply) => {
			expect(
				(await fixture(reply).adapter.register(intent, signal())).outcome,
			).toBe("unknown");
		},
	);
});
