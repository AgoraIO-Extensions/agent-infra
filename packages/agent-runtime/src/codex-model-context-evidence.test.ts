import {
	RuntimeIsolationEvidenceV1Schema,
	type RuntimeSafetyEvidenceWindowV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";
import {
	buildCodexModelContextEvidenceV1,
	type RuntimeSafetyEvidenceBindingSourceV1,
} from "./codex-model-context-evidence.js";
import {
	type CodexModelContextReceiptV1,
	codexModelContextProducerVersionV1,
	codexModelContextScenarioV1,
} from "./codex-model-context-observation.js";
import {
	codexNativeIsolationLeafResultV1,
	codexNativeIsolationLeafV1,
} from "./codex-native-isolation-leaf.js";

const window: RuntimeSafetyEvidenceWindowV1 = {
	schemaVersion: 1,
	windowRef: "window-1",
	opensAt: "2026-11-22T00:00:00.000Z",
	closesAt: "2026-11-22T02:00:00.000Z",
	agentIds: ["agent-1"],
	principalRefs: ["p1-principal"],
	scenarios: [
		{
			id: codexModelContextScenarioV1.id,
			version: codexModelContextScenarioV1.version,
			resourceClasses: ["model_context"],
			actionClasses: ["model_request"],
		},
	],
	producers: [
		{ kind: "model_transport", version: codexModelContextProducerVersionV1 },
	],
};

const binding: RuntimeSafetyEvidenceBindingSourceV1 = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	principalRef: "p1-principal",
	purposeRef: "business",
	authorization: { recordId: "auth-1", revision: "identity-8" },
	sessionGeneration: 1,
	executionDeliveryFence: 2,
	sandbox: {
		ref: "sandbox-1",
		podUid: "11111111-2222-4333-8444-555555555555",
		resourceFence: 3,
	},
	host: {
		instanceRef: "host-1",
		startRef: "start-1",
		configurationRevision: "7",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	clockId: "clock-1",
};

const receipt = (
	change: Partial<CodexModelContextReceiptV1> = {},
): CodexModelContextReceiptV1 => ({
	operationRef: "operation-1",
	attemptRef: "attempt-1",
	challengeRef: "challenge-1",
	selfMarkerPresent: true,
	foreignMarkerAbsent: true,
	observationComplete: true,
	observed: true,
	...change,
});

function build(
	receipts: readonly CodexModelContextReceiptV1[],
	change: Partial<Parameters<typeof buildCodexModelContextEvidenceV1>[0]> = {},
) {
	let sequence = 0;
	let ref = 0;
	return buildCodexModelContextEvidenceV1({
		receipts,
		binding,
		window,
		now: new Date("2026-11-22T01:00:00.000Z"),
		nextSequence: () => ++sequence,
		randomRef: () => `evidence-${++ref}`,
		...change,
	});
}

describe("model context evidence records (Spec §18.5.2 字段)", () => {
	it("binds one record per attempt to its original operation and the arrival challenge", () => {
		const [record] = build([receipt()]);
		expect(RuntimeIsolationEvidenceV1Schema.parse(record)).toEqual(record);
		expect(record).toMatchObject({
			resourceClass: "model_context",
			actionClass: "model_request",
			targetScope: "self",
			resultClass: "allowed",
			nativeObserved: true,
			modelContext: {
				selfMarkerPresent: true,
				foreignMarkerAbsent: true,
				observationComplete: true,
			},
			binding: {
				operation: { ref: "operation-1", attemptRef: "attempt-1" },
				challengeRef: "challenge-1",
				producer: {
					kind: "model_transport",
					version: codexModelContextProducerVersionV1,
				},
				windowRef: "window-1",
				sequence: 1,
			},
		});
	});

	it.each([
		[
			"an incomplete observation",
			{ observationComplete: false },
			"unproven",
			"io_unavailable",
		],
		[
			"a foreign marker",
			{ foreignMarkerAbsent: false },
			"isolation_violation",
			undefined,
		],
		[
			"a complete request without the own marker",
			{ selfMarkerPresent: false },
			"unproven",
			"unknown",
		],
	])("records %s", (_name, change, resultClass, failureClass) => {
		const [record] = build([receipt(change)]);
		expect(record?.resultClass).toBe(resultClass);
		expect(record?.failureClass).toBe(failureClass);
	});

	const otherScenario: RuntimeSafetyEvidenceWindowV1 = {
		...window,
		scenarios: [
			{
				id: "other",
				version: 1,
				resourceClasses: ["model_context"],
				actionClasses: ["model_request"],
			},
		],
	};
	const otherProducer: RuntimeSafetyEvidenceWindowV1 = {
		...window,
		producers: [{ kind: "model_transport", version: "old" }],
	};
	it.each([
		["no window", { window: undefined }],
		["another Agent", { binding: { ...binding, agentId: "agent-2" } }],
		["another subject", { binding: { ...binding, principalRef: "p1-other" } }],
		["a closed window", { now: new Date("2026-11-22T03:00:00.000Z") }],
		["a window without the scenario", { window: otherScenario }],
		["a window without this producer version", { window: otherProducer }],
	] as const)("produces nothing for %s", (_name, change) => {
		expect(build([receipt()], change)).toEqual([]);
	});

	it("never carries a marker or body", () => {
		const text = JSON.stringify(
			build([receipt(), receipt({ attemptRef: "attempt-2" })]),
		);
		for (const secret of [
			codexModelContextScenarioV1.selfMarker,
			codexModelContextScenarioV1.foreignMarker,
		])
			expect(text).not.toContain(secret);
	});
});

describe("Codex native leaf in M1 (Spec §18.5.2, #4358 AC-3)", () => {
	it("is always UNPROVEN/unsupported and has no positive path", () => {
		expect(codexNativeIsolationLeafV1).toEqual({
			adapter: "codex",
			status: "unsupported",
		});
		for (const resourceClass of [
			"file",
			"env",
			"proc",
			"workspace",
			"memory_file",
		] as const)
			expect(codexNativeIsolationLeafResultV1(resourceClass)).toEqual({
				resourceClass,
				resultClass: "unproven",
				failureClass: "unsupported",
				nativeObserved: false,
			});
	});
});
