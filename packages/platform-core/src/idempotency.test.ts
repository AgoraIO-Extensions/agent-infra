import { describe, expect, it } from "vitest";
import { FakePlatformIdempotencyDatabaseV1 } from "./fake-idempotency.ts";
import { platformIdempotencyPortV1Conformance } from "./idempotency.conformance.ts";
import { platformIdempotencyV1 } from "./idempotency.ts";

describe("Platform idempotency domain", () => {
	it("creates a bounded canonical request digest independent of object key order", () => {
		const first = platformIdempotencyV1.canonicalRequestDigest({
			model: { name: "gpt", reasoning: "medium" },
			revision: 2,
		});
		const equivalent = platformIdempotencyV1.canonicalRequestDigest({
			revision: 2,
			model: { reasoning: "medium", name: "gpt" },
		});

		expect(first).toBe(
			"cb98ab4afba53affc423e04e8e664ceff90ade16df64aa997d5d38d3f1b5771d",
		);
		expect(equivalent).toBe(first);
		expect(() =>
			platformIdempotencyV1.canonicalRequestDigest({
				value: "x".repeat(64 * 1024),
			}),
		).toThrow(
			expect.objectContaining({
				name: "PlatformIdempotencyError",
				code: "invalid_input",
			}),
		);
	});

	it("accepts only the current Platform operation, resources, and result shape", () => {
		const scope = {
			schemaVersion: 1 as const,
			operation: "platform.agent-application.submit.v1" as const,
			resourceType: "agent_application" as const,
			resourceId: "application_01",
			actorId: "user_01",
		};
		const result = {
			schemaVersion: 1 as const,
			outcome: "accepted" as const,
			references: [
				{
					resourceType: "agent_application" as const,
					resourceId: "application_01",
					revision: null,
				},
				{
					resourceType: "agent" as const,
					resourceId: "agent_01",
					revision: 1,
				},
			],
		};

		expect(platformIdempotencyV1.parseScope(scope)).toEqual(scope);
		expect(platformIdempotencyV1.parseResult(result)).toEqual(result);

		for (const invalidScope of [
			{ ...scope, operation: "platform.update-agent" },
			{ ...scope, operation: "platform.agent.lifecycle.restart.v1" },
			{ ...scope, operation: "runtime.submit" },
			{ ...scope, operation: "connection.invoke" },
			{ ...scope, resourceType: "conversation" },
			{ ...scope, resourceType: "connection" },
			{ ...scope, callerActorId: "attacker" },
		]) {
			expect(() => platformIdempotencyV1.parseScope(invalidScope)).toThrow(
				expect.objectContaining({ code: "invalid_input" }),
			);
		}

		for (const invalidResult of [
			{ ...result, accessToken: "credential-value" },
			{ ...result, providerResponse: { remoteId: "remote_01" } },
			{ ...result, sqlError: { query: "select secret" } },
			{ ...result, schemaVersion: 2 },
			{ ...result, references: [] },
			{
				...result,
				references: [
					{ resourceType: "conversation", resourceId: "c_01", revision: null },
				],
			},
		]) {
			expect(() => platformIdempotencyV1.parseResult(invalidResult)).toThrow(
				expect.objectContaining({ code: "invalid_input" }),
			);
		}
	});
});

describe("Fake Platform idempotency Port", () => {
	platformIdempotencyPortV1Conformance(async () => {
		const database = new FakePlatformIdempotencyDatabaseV1();
		return {
			open: (scope) => database.open(scope),
			close: () => Promise.resolve(),
		};
	});
});
