import { describe, expect, it } from "vitest";
import {
	captureConnectionConsumerRegistrationPolicyV1,
	parseConnectionConsumerRegistrationDeliveryV1,
	parseConnectionConsumerRegistrationIntentV1,
	planConnectionConsumerRegistrationForTransitionV1,
	planConnectionConsumerRegistrationV1,
} from "./connection-consumer-registration.js";

const policy = {
	schemaVersion: 1 as const,
	sourceNamespace: "controlled-platform-test",
	revision: "policy-1",
	callbackUrl: "https://platform.example.test/connection/callback",
	resource: "https://connection.example.test/mcp",
	scope: "mcp:tools",
};
const request = {
	policy,
	platformAgentId: "agent-a",
	platformOwnerId: "owner-a",
	consumerName: "Agent A",
};

describe("durable Connection Consumer registration intent", () => {
	it("uses the same formal creating rule for approved Web and direct API creation", () => {
		for (const transition of [
			{
				operation: "approve_application",
				creationChannel: "web" as const,
				from: "pending_approval",
				to: "creating",
			},
			{
				operation: "api_create",
				creationChannel: "api" as const,
				from: null,
				to: "creating",
			},
		])
			expect(
				planConnectionConsumerRegistrationForTransitionV1({
					...request,
					transition,
				}),
			).toEqual(planConnectionConsumerRegistrationV1(request));
		for (const transition of [
			{
				operation: "submit_application",
				creationChannel: "web" as const,
				from: null,
				to: "pending_approval",
			},
			{
				operation: "reject_application",
				creationChannel: "web" as const,
				from: "pending_approval",
				to: "rejected",
			},
			{
				operation: "retry_agent_creation",
				creationChannel: "web" as const,
				from: "creation_failed",
				to: "creating",
			},
		])
			expect(
				planConnectionConsumerRegistrationForTransitionV1({
					...request,
					transition,
				}),
			).toBeUndefined();
	});
	it("keeps a stable original operation and gives two Agents different source keys", () => {
		const first = planConnectionConsumerRegistrationV1(request);
		expect(planConnectionConsumerRegistrationV1(request)).toEqual(first);
		const second = planConnectionConsumerRegistrationV1({
			...request,
			platformAgentId: "agent-b",
		});
		expect(second.sourceNamespace).toBe(first.sourceNamespace);
		expect(second.sourceKey).not.toBe(first.sourceKey);
		expect(second.operationId).not.toBe(first.operationId);
		expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
	});
	it("keeps the key but changes digest when immutable registration input conflicts", () => {
		const first = planConnectionConsumerRegistrationV1(request);
		const changed = planConnectionConsumerRegistrationV1({
			...request,
			platformOwnerId: "other-owner",
		});
		expect(changed.idempotencyKey).toBe(first.idempotencyKey);
		expect(changed.requestDigest).not.toBe(first.requestDigest);
	});

	it.each([
		undefined,
		{ ...policy, sourceNamespace: "" },
		{ ...policy, callbackUrl: "http://platform.example.test/callback" },
		{ ...policy, token: "not-allowed" },
	])("rejects missing or invalid deployment policy", (input) => {
		expect(() =>
			captureConnectionConsumerRegistrationPolicyV1(input),
		).toThrow();
	});

	it("rejects extra secret fields and tampered identity/digest before persistence", () => {
		const intent = planConnectionConsumerRegistrationV1(request);
		expect(parseConnectionConsumerRegistrationIntentV1(intent)).toEqual(intent);
		for (const bad of [
			{ ...intent, serviceSecret: "not-allowed" },
			{ ...intent, sourceKey: "agent-b" },
			{ ...intent, requestDigest: "0".repeat(64) },
		])
			expect(() => parseConnectionConsumerRegistrationIntentV1(bad)).toThrow();
	});

	it("accepts only the matching nonsecret receipt and preserves unknown", () => {
		const intent = planConnectionConsumerRegistrationV1(request);
		const receipt = {
			schemaVersion: 1,
			operationId: intent.operationId,
			sourceNamespace: intent.sourceNamespace,
			sourceKey: intent.sourceKey,
			requestDigest: intent.requestDigest,
			consumerId: "actual-connection-consumer",
			consumerRevision: "remote-1",
			registrationId: "remote-registration-1",
		};
		expect(
			parseConnectionConsumerRegistrationDeliveryV1(
				{ outcome: "registered", receipt },
				intent,
			),
		).toEqual({ outcome: "registered", receipt });
		for (const bad of [
			{ ...receipt, sourceKey: "agent-b" },
			{ ...receipt, sourceNamespace: "other-source" },
			{ ...receipt, secretRef: "not-allowed" },
		])
			expect(() =>
				parseConnectionConsumerRegistrationDeliveryV1(
					{ outcome: "registered", receipt: bad },
					intent,
				),
			).toThrow();
		expect(
			parseConnectionConsumerRegistrationDeliveryV1(
				{ outcome: "unknown", failureCode: "ADAPTER_UNAVAILABLE" },
				intent,
			),
		).toEqual({ outcome: "unknown", failureCode: "ADAPTER_UNAVAILABLE" });
	});
});
