import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	ConnectionConsumerDisableErrorV1,
	isConnectionConsumerRevisionV1,
	parseConnectionConsumerDisableDeliveryV1,
	parseConnectionConsumerDisableIntentV1,
	planConnectionConsumerDisableIdentityV1,
	planConnectionConsumerDisableV1,
} from "./connection-consumer-disable.js";
import {
	isConnectionConsumerRegistrationCurrentV1,
	planConnectionConsumerRegistrationV1,
} from "./connection-consumer-registration.js";

const policy = {
	schemaVersion: 1 as const,
	sourceNamespace: "platform-test",
	revision: "policy-1",
	callbackUrl: "https://platform.example.test/connection/callback",
	resource: "https://connection.example.test/mcp",
	scope: "mcp:tools",
};

function registration(agentId: string, consumerRevision = "4") {
	const intent = planConnectionConsumerRegistrationV1({
		policy,
		platformAgentId: agentId,
		platformOwnerId: "owner-1",
		consumerName: `Agent ${agentId}`,
	});
	return {
		intent,
		receipt: {
			schemaVersion: 1 as const,
			operationId: intent.operationId,
			sourceNamespace: intent.sourceNamespace,
			sourceKey: intent.sourceKey,
			consumerId: `consumer-${agentId}`,
			consumerRevision,
			registrationId: `registration-${agentId}`,
			requestDigest: intent.requestDigest,
		},
	};
}

describe("Connection Consumer disable intent (Spec §13.5.7)", () => {
	it("derives a stable per-Agent identity distinct from the registration key", () => {
		const a = registration("agent-a");
		const identity = planConnectionConsumerDisableIdentityV1({
			registrationOperationId: a.intent.operationId,
			sourceNamespace: policy.sourceNamespace,
			platformAgentId: "agent-a",
		});
		expect(identity.operationId).toMatch(
			/^connection-consumer-disable:[a-f0-9]{64}$/,
		);
		expect(identity.idempotencyKey).toMatch(/^ccd-v1\.[a-f0-9]{64}$/);
		expect(identity.idempotencyKey).not.toBe(a.intent.idempotencyKey);
		expect(
			identity.operationId.slice("connection-consumer-disable:".length),
		).toBe(identity.idempotencyKey.slice("ccd-v1.".length));
		const b = planConnectionConsumerDisableIdentityV1({
			registrationOperationId: registration("agent-b").intent.operationId,
			sourceNamespace: policy.sourceNamespace,
			platformAgentId: "agent-b",
		});
		expect(b.operationId).not.toBe(identity.operationId);
	});

	it("binds the command to the same Agent's verified Consumer, revision and create key", () => {
		const a = registration("agent-a", "9");
		const intent = planConnectionConsumerDisableV1({ policy, registration: a });
		expect(intent).toMatchObject({
			platformAgentId: "agent-a",
			sourceNamespace: policy.sourceNamespace,
			registrationOperationId: a.intent.operationId,
			consumerId: "consumer-agent-a",
			registrationId: "registration-agent-a",
			expectedRevision: "9",
			policyRevision: "policy-1",
			registrationKeyHash: createHash("sha256")
				.update(a.intent.idempotencyKey)
				.digest("hex"),
		});
		expect(parseConnectionConsumerDisableIntentV1(intent)).toEqual(intent);
		// A rotated approved revision changes only the never-sent digest, not the identity.
		const rotated = planConnectionConsumerDisableV1({
			policy: { ...policy, revision: "policy-2" },
			registration: a,
		});
		expect(rotated.idempotencyKey).toBe(intent.idempotencyKey);
		expect(rotated.requestDigest).not.toBe(intent.requestDigest);
	});

	it.each([
		["another policy source", { ...policy, sourceNamespace: "other" }],
		["a receipt from another Agent", policy],
		["a non-lifecycle revision", policy],
	])("refuses %s", (reason, selected) => {
		const a = registration(
			"agent-a",
			reason === "a non-lifecycle revision" ? "r-1" : "4",
		);
		const receipt =
			reason === "a receipt from another Agent"
				? { ...a.receipt, sourceKey: "agent-b" }
				: a.receipt;
		expect(() =>
			planConnectionConsumerDisableV1({
				policy: selected,
				registration: { intent: a.intent, receipt },
			}),
		).toThrow(ConnectionConsumerDisableErrorV1);
	});

	it("rejects tampered or secret-bearing persisted commands", () => {
		const intent = planConnectionConsumerDisableV1({
			policy,
			registration: registration("agent-a"),
		});
		for (const changed of [
			{ ...intent, consumerId: "consumer-agent-b" },
			{ ...intent, platformAgentId: "agent-b" },
			{ ...intent, idempotencyKey: "ccd-v1.other" },
			{ ...intent, expectedRevision: "0" },
			{ ...intent, token: "forbidden" },
		])
			expect(() => parseConnectionConsumerDisableIntentV1(changed)).toThrow(
				ConnectionConsumerDisableErrorV1,
			);
	});

	it("accepts only an exact, advanced disable receipt", () => {
		const intent = planConnectionConsumerDisableV1({
			policy,
			registration: registration("agent-a", "4"),
		});
		const receipt = {
			schemaVersion: 1,
			operationId: intent.operationId,
			consumerId: intent.consumerId,
			registrationId: intent.registrationId,
			resultRevision: "5",
			requestDigest: intent.requestDigest,
		};
		expect(
			parseConnectionConsumerDisableDeliveryV1(
				{ outcome: "disabled", receipt },
				intent,
			),
		).toEqual({ outcome: "disabled", receipt });
		for (const changed of [
			{ ...receipt, consumerId: "consumer-agent-b" },
			{ ...receipt, resultRevision: "4" },
			{ ...receipt, requestDigest: "0".repeat(64) },
			{ ...receipt, secret: "forbidden" },
		])
			expect(() =>
				parseConnectionConsumerDisableDeliveryV1(
					{ outcome: "disabled", receipt: changed },
					intent,
				),
			).toThrow(ConnectionConsumerDisableErrorV1);
		expect(
			parseConnectionConsumerDisableDeliveryV1(
				{ outcome: "unknown", failureCode: "CONNECTION_DISABLE_UNCONFIRMED" },
				intent,
			),
		).toEqual({
			outcome: "unknown",
			failureCode: "CONNECTION_DISABLE_UNCONFIRMED",
		});
	});

	it("validates lifecycle revisions as positive signed 64-bit decimals", () => {
		expect(
			["1", "9223372036854775807", "0", "01", "9223372036854775808", 1].map(
				isConnectionConsumerRevisionV1,
			),
		).toEqual([true, true, false, false, false, false]);
	});

	it("only read-only registration recovery stays eligible for a disabled Agent", () => {
		const { intent } = registration("agent-a");
		const input = {
			intent,
			policy,
			ownerId: "owner-1",
			ownerCurrent: true,
			agentStatus: "disabled",
		};
		expect(isConnectionConsumerRegistrationCurrentV1(input)).toBe(false);
		expect(
			isConnectionConsumerRegistrationCurrentV1({ ...input, readOnly: true }),
		).toBe(true);
		expect(
			isConnectionConsumerRegistrationCurrentV1({
				...input,
				readOnly: true,
				ownerCurrent: false,
			}),
		).toBe(false);
	});
});
