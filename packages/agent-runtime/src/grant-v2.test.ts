import { describe, expect, it } from "vitest";
import { validateRuntimeExecutionGrantV2 } from "./grant-v2.js";
import {
	fixtureNow,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";

const options = {
	expectedIssuer: "platform-fixture",
	expectedWorkerId: "worker-fixture",
	now: () => fixtureNow,
};

describe("Runtime V2 grant trust boundary", () => {
	it("verifies a domain-separated signature and binds all semantic request fields", () => {
		const request = signV3Fixture(submitV3Fixture(), "turn.submit");
		const verified = verifyRuntimeV2Fixture(request.grant);
		expect(
			validateRuntimeExecutionGrantV2(request, "turn.submit", verified, options)
				.purpose,
		).toBe("business");
		for (const changed of [
			{
				...request,
				principal: { kind: "application" as const, id: request.principal.id },
			},
			{ ...request, principal: { kind: "user" as const, id: "another-user" } },
			{ ...request, input: { text: "changed", attachments: [] } },
			{ ...request, operation: { ...request.operation, deliveryFence: 2 } },
			{ ...request, hostSessionRef: "another-host" },
			{ ...request, channelId: "application" },
			{ ...request, requestId: "retry-request" },
		])
			expect(() =>
				validateRuntimeExecutionGrantV2(
					changed,
					"turn.submit",
					verified,
					options,
				),
			).toThrow();
		const retry = signV3Fixture(
			{ ...submitV3Fixture(), requestId: "retry-request" },
			"turn.submit",
		);
		expect(() =>
			validateRuntimeExecutionGrantV2(
				retry,
				"turn.submit",
				verifyRuntimeV2Fixture(retry.grant),
				options,
			),
		).not.toThrow();
	});

	it.each([
		{ workerId: "another-worker" },
		{ issuer: "another-issuer" },
		{ issuedAt: fixtureNow + 1 },
		{ expiresAt: fixtureNow },
		{ expiresAt: fixtureNow + 30_001 },
		{
			operation: {
				kind: "execution",
				id: "other-execution",
				deliveryFence: 1,
				executionDeliveryFence: 1,
			},
		},
	])("rejects inconsistent signed claims %j", (claims) => {
		const request = signV3Fixture(submitV3Fixture(), "turn.submit", { claims });
		expect(() =>
			validateRuntimeExecutionGrantV2(
				request,
				"turn.submit",
				verifyRuntimeV2Fixture(request.grant),
				options,
			),
		).toThrow();
	});

	it("rejects a readiness signature domain and a forged signature", () => {
		const request = signV3Fixture(submitV3Fixture(), "turn.submit");
		const [, payload, signature] = request.grant.token.split(".");
		const wrongHeader = Buffer.from(
			JSON.stringify({
				alg: "EdDSA",
				kid: "fixture",
				typ: "workload-readiness+jws",
			}),
		).toString("base64url");
		expect(() =>
			verifyRuntimeV2Fixture({
				...request.grant,
				token: `${wrongHeader}.${payload}.${signature}`,
			}),
		).toThrow();
		expect(() =>
			verifyRuntimeV2Fixture({
				...request.grant,
				token: `${request.grant.token.slice(0, -10)}AAAAAAAAAA`,
			}),
		).toThrow();
	});

	it("rejects compact tokens with extra JWS segments", () => {
		const request = signV3Fixture(submitV3Fixture(), "turn.submit");
		expect(() =>
			verifyRuntimeV2Fixture({
				...request.grant,
				token: `${request.grant.token}.extra`,
			}),
		).toThrow();
	});

	it("rejects duplicate attachment IDs in the request", () => {
		const request = signV3Fixture(submitV3Fixture(), "turn.submit");
		expect(() =>
			validateRuntimeExecutionGrantV2(
				{
					...request,
					input: {
						text: "synthetic input",
						attachments: ["attachment-1", "attachment-1"],
					},
				},
				"turn.submit",
				verifyRuntimeV2Fixture(request.grant),
				options,
			),
		).toThrow();
	});
});
