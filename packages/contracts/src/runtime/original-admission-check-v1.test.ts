import { describe, expect, it } from "vitest";
import {
	RuntimeOriginalAdmissionCheckBindingV1Schema,
	RuntimeOriginalAdmissionCheckResponseV1Schema,
	runtimeOriginalAdmissionCheckBindingPayloadV1,
} from "./original-admission-check-v1.ts";

const binding = {
	schemaVersion: 1,
	checkId: "check-1",
	challenge: "A".repeat(43),
	issuedAt: 1_000,
	expiresAt: 31_000,
	scope: {
		principal: { kind: "user", id: "user-1" },
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		originalOperationId: "execution-1",
		authorizationRecordId: "authorization-1",
		sessionGeneration: 1,
		executionDeliveryFence: 1,
		podUid: "0f4a7c52-9b3e-4d1a-8c7f-2e6b5a4d3c21",
	},
	platform: { sessionGeneration: 1, resourceFence: 1 },
} as const;

const response = {
	schemaVersion: 1,
	checkId: "check-1",
	challenge: "A".repeat(43),
	decision: "denied",
	reason: "stale_generation",
	checkedSurface: "original_call_admission_predicate",
	original: { sessionGeneration: 1, executionDeliveryFence: 1 },
	current: {
		platformSessionGeneration: 2,
		platformResourceFence: 1,
		hostBarrier: "confirmed",
		hostExecutionFence: 2,
	},
	checkedAt: 2_000,
	clockId: "A".repeat(22),
	dispatchAttempted: false,
} as const;

describe("original admission check contract (#4358 I3)", () => {
	it("bounds the proof lifetime to 30 seconds and keeps a fixed field order", () => {
		expect(
			RuntimeOriginalAdmissionCheckBindingV1Schema.safeParse(binding).success,
		).toBe(true);
		expect(
			RuntimeOriginalAdmissionCheckBindingV1Schema.safeParse({
				...binding,
				expiresAt: 31_001,
			}).success,
		).toBe(false);
		expect(
			RuntimeOriginalAdmissionCheckBindingV1Schema.safeParse({
				...binding,
				expiresAt: binding.issuedAt,
			}).success,
		).toBe(false);
		const reordered = Object.fromEntries(
			Object.entries({
				...binding,
				scope: Object.fromEntries(Object.entries(binding.scope).reverse()),
			}).reverse(),
		) as unknown as typeof binding;
		expect(runtimeOriginalAdmissionCheckBindingPayloadV1(reordered)).toBe(
			runtimeOriginalAdmissionCheckBindingPayloadV1(binding),
		);
	});

	it("only accepts a fixed decision, reason and dispatch claim", () => {
		expect(
			RuntimeOriginalAdmissionCheckResponseV1Schema.safeParse(response).success,
		).toBe(true);
		for (const invalid of [
			{ ...response, decision: "admissible" },
			{ ...response, decision: "unproven" },
			{ ...response, reason: undefined },
			{ ...response, dispatchAttempted: true },
			{ ...response, message: "sk-canary" },
			{ ...response, checkedSurface: "business_wire" },
		])
			expect(
				RuntimeOriginalAdmissionCheckResponseV1Schema.safeParse(invalid)
					.success,
			).toBe(false);
	});
});
