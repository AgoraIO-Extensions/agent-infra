import { describe, expect, it } from "vitest";
import { FakeNativeCapabilityMetadataRevalidationV1 } from "./fake-native-capability-admission.ts";
import {
	createNativeCapabilityAdmissionUseCaseV1,
	type NativeCapabilityAdmissionStateV1,
	type NativeCapabilityAdmissionTransactionPortV1,
	type NativeCapabilityMetadataRevalidationPortV1,
	parseNativeCapabilityAdmissionRequestV1,
} from "./native-capability-admission.ts";

const authority = {
	schemaVersion: 1 as const,
	actorId: "actor-1",
	agentId: "agent-1",
	channelId: "web",
	authorizationRevision: "auth-1",
	supportsSupplementaryInstruction: false,
};

const conversation = {
	schemaVersion: 1 as const,
	conversationId: "conversation-1",
	agentId: "agent-1",
	actorId: "actor-1",
	channelId: "web",
	status: "ready" as const,
	sessionGeneration: 3,
	hostSessionRef: "host-session-1",
	authorizationRevision: "auth-1",
	lastConversationCursor: 0,
	selectedModelOptionId: null,
	selectedReasoningLevel: null,
	createdAt: new Date("2026-10-13T00:00:00.000Z"),
	updatedAt: new Date("2026-10-13T00:00:00.000Z"),
};

const capabilityId = "a".repeat(64);
const directoryRevision = "b".repeat(64);
const request = {
	schemaVersion: 1 as const,
	conversationId: "conversation-1",
	capabilityId,
	directoryRevision,
	parameters: "summary of the workspace",
	idempotencyKey: "invoke-1",
	requestId: "request-1",
	traceId: "trace-1",
};

const projection = {
	selector: "skills" as const,
	revision: directoryRevision,
	capabilities: [
		{
			id: capabilityId,
			kind: "skill" as const,
			name: "workspace-summary",
			description: "Summarize the current workspace",
			source: { name: "skillhub", version: "1.0.0" },
			availability: "discovered" as const,
		},
	],
};

function transaction(
	state: NativeCapabilityAdmissionStateV1,
): NativeCapabilityAdmissionTransactionPortV1 {
	return {
		async admitNativeCapability(_request, decide) {
			const decision = await decide(state);
			if ("outcome" in decision) return decision;
			return {
				outcome: "accepted",
				result: decision.result,
				plan: decision,
			};
		},
	};
}

function useCase(
	metadata: NativeCapabilityMetadataRevalidationPortV1 = new FakeNativeCapabilityMetadataRevalidationV1(
		{ projection },
	),
	state: NativeCapabilityAdmissionStateV1 = {
		conversation,
		activeExecution: null,
		authorizationRevision: "auth-1",
	},
) {
	return createNativeCapabilityAdmissionUseCaseV1({
		authorization: {
			async authorize() {
				return { outcome: "allowed", authority };
			},
		},
		metadata,
		transaction: transaction(state),
		newId: (() => {
			let next = 0;
			return () => `generated-${++next}`;
		})(),
	});
}

describe("native capability admission contract", () => {
	it("strictly snapshots bounded requests and rejects extra fields", () => {
		expect(parseNativeCapabilityAdmissionRequestV1(request)).toEqual(request);
		expect(() =>
			parseNativeCapabilityAdmissionRequestV1({ ...request, extra: true }),
		).toThrow();
		expect(() =>
			parseNativeCapabilityAdmissionRequestV1({
				...request,
				parameters: "x\0",
			}),
		).toThrow();
	});

	it("revalidates the directory before producing a frozen plan", async () => {
		const decision = await useCase().admit(request);
		expect(decision.outcome).toBe("accepted");
		if (decision.outcome !== "accepted") return;
		expect(decision.plan.capability).toMatchObject({
			id: capabilityId,
			kind: "skill",
			directoryRevision,
		});
		expect(Object.isFrozen(decision.plan)).toBe(true);
		expect(Object.isFrozen(decision.plan.capability)).toBe(true);
	});

	it("fails closed for a stale directory revision", async () => {
		const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
			projection: { ...projection, revision: "c".repeat(64) },
		});
		const decision = await useCase(metadata).admit(request);
		expect(decision.outcome).toBe("stale");
	});

	it("fails closed for an unknown capability", async () => {
		const unknownId = "d".repeat(64);
		const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
			projection: {
				...projection,
				capabilities: projection.capabilities.map((capability) => ({
					...capability,
					id: unknownId,
				})),
			},
		});
		const decision = await useCase(metadata).admit(request);
		expect(decision.outcome).toBe("unknown");
	});

	it("returns busy before reading metadata for an active or unknown execution", async () => {
		const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
			projection,
		});
		const state = {
			conversation,
			activeExecution: {
				executionId: "execution-1",
				status: "unknown" as const,
			},
			authorizationRevision: "auth-1",
		};
		const decision = await useCase(metadata, state).admit(request);
		expect(decision).toEqual({ outcome: "busy" });
	});

	it("rejects a metadata response whose scope changed during revalidation", async () => {
		const metadata = {
			async revalidate() {
				const selected = projection.capabilities[0];
				if (!selected) throw new Error("Expected test capability");
				return {
					outcome: "allowed" as const,
					capability: {
						...selected,
						directoryRevision,
					},
					scope: {
						agentId: authority.agentId,
						actorId: "other-actor",
						channelId: authority.channelId,
						conversationId: request.conversationId,
						sessionGeneration: conversation.sessionGeneration,
						authorizationRevision: authority.authorizationRevision,
					},
				};
			},
		};
		const decision = await useCase(metadata).admit(request);
		expect(decision).toEqual({
			outcome: "unavailable",
			reason: "metadata_unavailable",
		});
	});

	it("rechecks authorization after metadata revalidation", async () => {
		let calls = 0;
		const decision = await createNativeCapabilityAdmissionUseCaseV1({
			authorization: {
				async authorize() {
					calls += 1;
					return {
						outcome: "allowed" as const,
						authority:
							calls === 1
								? authority
								: { ...authority, authorizationRevision: "auth-2" },
					};
				},
			},
			metadata: new FakeNativeCapabilityMetadataRevalidationV1({ projection }),
			transaction: transaction({
				conversation,
				activeExecution: null,
				authorizationRevision: "auth-1",
			}),
			newId: () => "generated",
		}).admit(request);
		expect(decision).toEqual({
			outcome: "denied",
			reason: "authorization_lost",
		});
	});

	it("rejects a directory invalidation after the final authorization check", async () => {
		let metadataCalls = 0;
		const fake = new FakeNativeCapabilityMetadataRevalidationV1({ projection });
		const metadata: NativeCapabilityMetadataRevalidationPortV1 = {
			async revalidate(input) {
				metadataCalls += 1;
				if (metadataCalls === 1) return fake.revalidate(input);
				return { outcome: "stale" };
			},
		};
		const decision = await useCase(metadata).admit(request);
		expect(decision).toEqual({ outcome: "stale" });
	});

	it("rejects authorization lost after the final metadata read", async () => {
		let calls = 0;
		const decision = await createNativeCapabilityAdmissionUseCaseV1({
			authorization: {
				async authorize() {
					calls += 1;
					return calls < 3
						? { outcome: "allowed" as const, authority }
						: { outcome: "denied" as const };
				},
			},
			metadata: new FakeNativeCapabilityMetadataRevalidationV1({ projection }),
			transaction: transaction({
				conversation,
				activeExecution: null,
				authorizationRevision: "auth-1",
			}),
			newId: () => "generated",
		}).admit(request);
		expect(decision).toEqual({
			outcome: "denied",
			reason: "authorization_lost",
		});
	});
});
