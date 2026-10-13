import {
	createNativeCapabilityAdmissionUseCaseV1,
	FakeNativeCapabilityMetadataRevalidationV1,
} from "@agent-infra/platform-core";
import { describe, expect, it } from "vitest";
import {
	type FakeNativeCapabilityAdmissionStoreOptionsV1,
	FakeNativeCapabilityAdmissionStoreV1,
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

function createHarness(
	options: Partial<FakeNativeCapabilityAdmissionStoreOptionsV1> = {},
) {
	const store = new FakeNativeCapabilityAdmissionStoreV1({
		conversation,
		...options,
	});
	const metadata = new FakeNativeCapabilityMetadataRevalidationV1({
		projection,
	});
	const useCase = createNativeCapabilityAdmissionUseCaseV1({
		authorization: {
			async authorize() {
				return { outcome: "allowed", authority };
			},
		},
		metadata,
		transaction: store,
		newId: (() => {
			let next = 0;
			return () => `generated-${++next}`;
		})(),
	});
	return { metadata, store, useCase };
}

describe("native capability admission Store seam", () => {
	it("replays the same key and rejects changed parameters without another plan", async () => {
		const harness = createHarness();
		const first = await harness.useCase.admit(request);
		const replay = await harness.useCase.admit({
			...request,
			requestId: "request-2",
		});
		const conflict = await harness.useCase.admit({
			...request,
			parameters: "different parameters",
			requestId: "request-3",
		});
		expect(first.outcome).toBe("accepted");
		expect(replay.outcome).toBe("replayed");
		expect(conflict).toEqual({
			outcome: "conflict",
			reason: "idempotency_conflict",
		});
		expect(harness.store.plans).toHaveLength(1);
	});

	it("fails closed for stale or disabled metadata", async () => {
		const stale = createHarness();
		stale.metadata.setProjection({ ...projection, revision: "c".repeat(64) });
		expect((await stale.useCase.admit(request)).outcome).toBe("stale");

		const disabled = createHarness();
		disabled.metadata.setProjection({
			...projection,
			capabilities: projection.capabilities.map((capability) => ({
				...capability,
				availability: "available" as const,
			})),
		});
		expect((await disabled.useCase.admit(request)).outcome).toBe("disabled");
	});

	it("returns busy for active and unknown executions before creating a plan", async () => {
		for (const status of ["submitted", "unknown"] as const) {
			const harness = createHarness({
				activeExecution: { executionId: "execution-existing", status },
			});
			expect(await harness.useCase.admit(request)).toEqual({ outcome: "busy" });
			expect(harness.store.plans).toHaveLength(0);
		}
	});

	it("rejects authorization loss before replay or metadata reads", async () => {
		const harness = createHarness();
		harness.store.setAuthorizationRevision("auth-revoked");
		expect(await harness.useCase.admit(request)).toEqual({
			outcome: "denied",
			reason: "authorization_lost",
		});
		expect(harness.store.plans).toHaveLength(0);
	});

	it("rejects an empty Skill parameter while preserving command empty parameters", async () => {
		const skill = createHarness();
		expect(
			(await skill.useCase.admit({ ...request, parameters: "" })).outcome,
		).toBe("invalid_parameters");

		const commandProjection = {
			selector: "commands" as const,
			revision: directoryRevision,
			capabilities: [
				{
					id: capabilityId,
					kind: "command" as const,
					name: "status",
					description: "Read status",
					source: { name: "codex", version: "1.0.0" },
					availability: "available" as const,
				},
			],
		};
		const command = createHarness();
		command.metadata.setProjection(commandProjection);
		expect(
			(await command.useCase.admit({ ...request, parameters: "" })).outcome,
		).toBe("unsupported");
	});
});
