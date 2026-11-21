import { describe, expect, it } from "vitest";

import {
	projectIsolationEvidenceForOperatorV1,
	projectIsolationEvidenceForPrincipalV1,
	RuntimeIsolationEvidencePrincipalProjectionV1Schema,
	RuntimeIsolationEvidenceV1Schema,
	RuntimePersistedSafetyEvidenceV1Schema,
	RuntimeSafetyEvidenceLogReadRequestV1Schema,
} from "./safety-evidence-v1.ts";

const binding = (
	producer: "native_helper" | "model_transport" = "native_helper",
) => ({
	evidenceId: "evidence-1",
	scenario: { id: "u1-file-self", version: 1 },
	windowRef: "window-1",
	challengeRef: "challenge-1",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	operation: { ref: "operation-1", attemptRef: "attempt-1" },
	principalRef: "principal-ref-1",
	purposeRef: "purpose-ref-1",
	sessionGeneration: 1,
	executionDeliveryFence: 1,
	sandbox: {
		ref: "sandbox-1",
		podUid: "11111111-2222-4333-8444-555555555555",
		resourceFence: 1,
	},
	host: {
		instanceRef: "host-1",
		startRef: "start-1",
		configurationRevision: "config-1",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	producer: { kind: producer, version: "u1-helper-1" },
	observedAt: "2026-11-22T00:00:00.000Z",
	clockId: "clock-1",
	sequence: 3,
});

const selfWrite = {
	schemaVersion: 1,
	code: "RUNTIME_ISOLATION_EVIDENCE_V1",
	kind: "isolation_observation",
	binding: binding(),
	resourceClass: "file",
	actionClass: "write",
	targetScope: "self",
	resultClass: "allowed",
	nativeObserved: true,
	syntheticFile: { byteLength: 42, sha256: "b".repeat(64) },
	durationMonoMs: 4,
} as const;

const foreignRead = {
	...selfWrite,
	binding: {
		...binding(),
		evidenceId: "evidence-2",
		challengeRef: "challenge-2",
	},
	actionClass: "read",
	targetScope: "foreign",
	resultClass: "denied",
	failureClass: "permission_denied",
	syntheticFile: undefined,
} as const;

const context = (
	booleans: {
		selfMarkerPresent: boolean;
		foreignMarkerAbsent: boolean;
		observationComplete: boolean;
	},
	resultClass: string,
	failureClass?: string,
) => ({
	schemaVersion: 1,
	code: "RUNTIME_ISOLATION_EVIDENCE_V1",
	kind: "isolation_observation",
	binding: binding("model_transport"),
	resourceClass: "model_context",
	actionClass: "model_request",
	targetScope: "self",
	resultClass,
	nativeObserved: true,
	...(failureClass ? { failureClass } : {}),
	modelContext: booleans,
});

describe("isolation observation record (Spec §18.5.2)", () => {
	it("accepts the own synthetic file positive with length and hash, and a foreign denial without them", () => {
		expect(
			RuntimeIsolationEvidenceV1Schema.parse(selfWrite).syntheticFile,
		).toEqual({
			byteLength: 42,
			sha256: "b".repeat(64),
		});
		const denied = RuntimeIsolationEvidenceV1Schema.parse(foreignRead);
		expect(denied.syntheticFile).toBeUndefined();
	});

	it.each([
		[
			"a foreign result with length/hash",
			{
				...foreignRead,
				syntheticFile: { byteLength: 1, sha256: "c".repeat(64) },
			},
		],
		[
			"a foreign access reported as allowed",
			{ ...foreignRead, resultClass: "allowed", failureClass: undefined },
		],
		[
			"a positive without an observed native action",
			{ ...selfWrite, nativeObserved: false },
		],
		["length/hash on env", { ...selfWrite, resourceClass: "env" }],
		[
			"length/hash on a denial",
			{
				...selfWrite,
				resultClass: "denied",
				failureClass: "permission_denied",
			},
		],
		[
			"a denial without a fixed failure class",
			{ ...foreignRead, failureClass: undefined },
		],
		[
			"a denial with an unproven failure class",
			{ ...foreignRead, failureClass: "unknown" },
		],
		[
			"unproven with a denial failure class",
			{ ...foreignRead, resultClass: "unproven", failureClass: "not_found" },
		],
		[
			"context booleans on a file",
			{
				...selfWrite,
				modelContext: {
					selfMarkerPresent: true,
					foreignMarkerAbsent: true,
					observationComplete: true,
				},
			},
		],
		[
			"a file result from the model transport",
			{ ...selfWrite, binding: binding("model_transport") },
		],
		[
			"a context result from the native helper",
			{
				...context(
					{
						selfMarkerPresent: true,
						foreignMarkerAbsent: true,
						observationComplete: true,
					},
					"allowed",
				),
				binding: binding(),
			},
		],
		[
			"an extra field such as a path",
			{ ...selfWrite, path: "/workspace/secret.txt" },
		],
		[
			"an extra binding field such as a native item id",
			{ ...selfWrite, binding: { ...binding(), nativeItemId: "item-1" } },
		],
		[
			"an epoch-like invented value",
			{
				...selfWrite,
				binding: {
					...binding(),
					sandbox: { ...binding().sandbox, executorEpoch: 0 },
				},
			},
		],
	])("rejects %s", (_name, value) => {
		expect(RuntimeIsolationEvidenceV1Schema.safeParse(value).success).toBe(
			false,
		);
	});

	it("derives the model context result from its three booleans; gaps are UNPROVEN", () => {
		const ok = (
			booleans: Parameters<typeof context>[0],
			result: string,
			failure?: string,
		) =>
			RuntimeIsolationEvidenceV1Schema.safeParse(
				context(booleans, result, failure),
			).success;
		expect(
			ok(
				{
					selfMarkerPresent: true,
					foreignMarkerAbsent: true,
					observationComplete: true,
				},
				"allowed",
			),
		).toBe(true);
		expect(
			ok(
				{
					selfMarkerPresent: true,
					foreignMarkerAbsent: false,
					observationComplete: true,
				},
				"isolation_violation",
			),
		).toBe(true);
		expect(
			ok(
				{
					selfMarkerPresent: true,
					foreignMarkerAbsent: true,
					observationComplete: false,
				},
				"unproven",
				"io_unavailable",
			),
		).toBe(true);
		expect(
			ok(
				{
					selfMarkerPresent: false,
					foreignMarkerAbsent: true,
					observationComplete: true,
				},
				"unproven",
				"unknown",
			),
		).toBe(true);
		// An incomplete observation never reads as isolated, and a foreign marker is never allowed.
		expect(
			ok(
				{
					selfMarkerPresent: true,
					foreignMarkerAbsent: true,
					observationComplete: false,
				},
				"allowed",
			),
		).toBe(false);
		expect(
			ok(
				{
					selfMarkerPresent: true,
					foreignMarkerAbsent: false,
					observationComplete: true,
				},
				"allowed",
			),
		).toBe(false);
		expect(
			ok(
				{
					selfMarkerPresent: true,
					foreignMarkerAbsent: true,
					observationComplete: true,
				},
				"denied",
				"policy_denied",
			),
		).toBe(false);
	});

	it("rejects unknown evidence kinds instead of dropping fields", () => {
		expect(
			RuntimePersistedSafetyEvidenceV1Schema.safeParse({
				...selfWrite,
				kind: "original_admission_check",
			}).success,
		).toBe(false);
		expect(
			RuntimeSafetyEvidenceLogReadRequestV1Schema.safeParse({
				schemaVersion: 1,
				capability: "runtime-safety-evidence-v2",
				after: null,
				limit: 10,
			}).success,
		).toBe(false);
	});
});

describe("projections (Spec §18.5.1 投影, #4358 P1)", () => {
	it("keeps nativeObserved, the own file length/hash and the context booleans for the original subject", () => {
		const projection = projectIsolationEvidenceForPrincipalV1(
			RuntimeIsolationEvidenceV1Schema.parse(selfWrite),
		);
		expect(projection).toMatchObject({
			evidenceRef: "evidence-1",
			resultClass: "allowed",
			nativeObserved: true,
			syntheticFile: { byteLength: 42, sha256: "b".repeat(64) },
		});
		const contextProjection = projectIsolationEvidenceForPrincipalV1(
			RuntimeIsolationEvidenceV1Schema.parse(
				context(
					{
						selfMarkerPresent: true,
						foreignMarkerAbsent: true,
						observationComplete: true,
					},
					"allowed",
				),
			),
		);
		expect(contextProjection.modelContext).toEqual({
			selfMarkerPresent: true,
			foreignMarkerAbsent: true,
			observationComplete: true,
		});
	});

	it("leaves technical bindings out of the subject projection and only in the operator projection", () => {
		const record = RuntimeIsolationEvidenceV1Schema.parse(selfWrite);
		const principal = JSON.stringify(
			projectIsolationEvidenceForPrincipalV1(record),
		);
		for (const technical of [
			"11111111-2222-4333-8444-555555555555",
			"host-1",
			"operation-1",
			"attempt-1",
			"principal-ref-1",
			"challenge-1",
			"u1-helper-1",
		])
			expect(principal).not.toContain(technical);
		expect(
			RuntimeIsolationEvidencePrincipalProjectionV1Schema.safeParse({
				...projectIsolationEvidenceForPrincipalV1(record),
				binding: record.binding,
			}).success,
		).toBe(false);
		const operator = projectIsolationEvidenceForOperatorV1(record);
		expect(operator.binding.sandbox.podUid).toBe(
			"11111111-2222-4333-8444-555555555555",
		);
		expect(operator.syntheticFile).toEqual(record.syntheticFile);
	});

	it("never carries the subject projection of a foreign object's existence, length or digest", () => {
		const projection = projectIsolationEvidenceForPrincipalV1(
			RuntimeIsolationEvidenceV1Schema.parse(foreignRead),
		);
		expect(projection.syntheticFile).toBeUndefined();
		expect(Object.keys(projection)).not.toContain("byteLength");
	});
});
