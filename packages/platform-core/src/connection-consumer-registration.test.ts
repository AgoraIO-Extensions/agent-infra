import { describe, expect, it } from "vitest";
import {
	captureConnectionConsumerRegisteredBindingV1,
	captureConnectionConsumerRegistrationPolicyV1,
	isConnectionConsumerRegistrationCurrentV1,
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

describe("registered Consumer association source", () => {
	const intent = planConnectionConsumerRegistrationV1(request);
	const receipt = {
		schemaVersion: 1 as const,
		operationId: intent.operationId,
		sourceNamespace: intent.sourceNamespace,
		sourceKey: intent.sourceKey,
		consumerId: "random-connection-consumer",
		consumerRevision: "7",
		registrationId: "random-registration",
		requestDigest: intent.requestDigest,
	};
	it("captures the original verified receipt and association revision without inventing an identity", () => {
		const binding = captureConnectionConsumerRegisteredBindingV1({
			intent,
			receipt,
			associationRevision: 3,
		});
		expect(binding.source).toEqual({ ref: intent.operationId, revision: "3" });
		expect(binding.receipt.consumerId).not.toBe(intent.platformAgentId);
		expect(Object.isFrozen(binding.intent)).toBe(true);
		expect(Object.isFrozen(binding.receipt)).toBe(true);
		expect(binding.receipt).not.toBe(receipt);
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
		"rejects an invalid association revision %s",
		(associationRevision) => {
			expect(() =>
				captureConnectionConsumerRegisteredBindingV1({
					intent,
					receipt,
					associationRevision,
				}),
			).toThrow("CONNECTION_CONSUMER_REGISTRATION_INVALID");
		},
	);
	it("rejects another Agent's receipt even when the Consumer ID is plausible", () => {
		expect(() =>
			captureConnectionConsumerRegisteredBindingV1({
				intent,
				receipt: { ...receipt, sourceKey: "agent-b" },
				associationRevision: 1,
			}),
		).toThrow("CONNECTION_CONSUMER_REGISTRATION_INVALID");
	});
	it.each([
		{ ownerId: "other-owner" },
		{ ownerCurrent: false },
		{ agentStatus: "disabled" },
		{ agentStatus: "pending_approval" },
		{ policy: { ...policy, sourceNamespace: "foreign-source" } },
		{ policy: { ...policy, revision: "new-policy" } },
		{
			policy: { ...policy, callbackUrl: "https://platform.example.test/other" },
		},
		{
			policy: { ...policy, resource: "https://connection.example.test/other" },
		},
		{ policy: { ...policy, scope: "other" } },
	])("rejects stale authority %j", (changed) => {
		expect(
			isConnectionConsumerRegistrationCurrentV1({
				intent,
				policy,
				ownerId: intent.platformOwnerId,
				ownerCurrent: true,
				agentStatus: "available",
				...changed,
			}),
		).toBe(false);
	});
});

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
		{ ...policy, sourceNamespace: "controlled:platform" },
		{ ...policy, revision: "policy 1" },
		{ ...policy, scope: "mcp/tools" },
		{ ...policy, scope: "a".repeat(101) },
		{
			...policy,
			scope: Array.from({ length: 33 }, (_, i) => `s${i}`).join(" "),
		},
		{ ...policy, scope: "mcp mcp" },
		{ ...policy, callbackUrl: "http://platform.example.test/callback" },
		{ ...policy, token: "not-allowed" },
	])("rejects missing or invalid deployment policy", (input) => {
		expect(() =>
			captureConnectionConsumerRegistrationPolicyV1(input),
		).toThrow();
	});

	it("accepts the full bounded scope list without changing original policy bytes", () => {
		const scopes = Array.from({ length: 32 }, (_, index) =>
			`scope${index}`.padEnd(100, "x"),
		).join(" ");
		const configured = { ...policy, revision: "policy~1", scope: scopes };
		expect(captureConnectionConsumerRegistrationPolicyV1(configured)).toEqual(
			configured,
		);
	});

	it.each([
		"https://platform.example.test/connection/%c3%a9",
		"https://platform.example.test/connection/%GG",
		"https://platform.example.test/connection/callback?",
		"https://platform.example.test/connection/callback?mode=oauth",
		"https://platform.example.test/connection/callback#",
		"https://platform.example.test/connection/callback#oauth",
	])(
		"rejects Connection-incompatible URL %s before creating an intent",
		(url) => {
			for (const field of ["callbackUrl", "resource"] as const) {
				const invalidPolicy = { ...policy, [field]: url };
				expect(() =>
					captureConnectionConsumerRegistrationPolicyV1(invalidPolicy),
				).toThrow();
				expect(() =>
					planConnectionConsumerRegistrationV1({
						...request,
						policy: invalidPolicy,
					}),
				).toThrow();
			}
		},
	);

	it.each([
		"https://platform.example.test/connection/%C3%A9",
		"https://platform.example.test/connection/callback/",
		"https://platform.example.test/",
	])("preserves canonical URL bytes in the original intent: %s", (url) => {
		const configured = { ...policy, callbackUrl: url, resource: url };
		expect(captureConnectionConsumerRegistrationPolicyV1(configured)).toEqual(
			configured,
		);
		const intent = planConnectionConsumerRegistrationV1({
			...request,
			policy: configured,
		});
		expect(intent.callbackUrl).toBe(url);
		expect(intent.resource).toBe(url);
		expect(parseConnectionConsumerRegistrationIntentV1(intent)).toEqual(intent);
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
