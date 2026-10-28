import { expect, it } from "vitest";
import { conversationExecutionKeySubjectV1 } from "./conversation-execution-types.js";
import {
	isTaskApiChannelV1,
	parseTaskAuthorizationBoundaryV1,
} from "./task-authorization.js";

const evaluation = {
	schemaVersion: 1,
	experimentId: "experiment",
	sampleId: "sample",
	variantId: "baseline",
	datasetId: "dataset",
	versionId: "version",
	grantId: "run-grant",
	grantRevision: 1,
	policyId: "policy",
	policyRevision: 1,
	configurationRevision: 1,
	modelOptionId: "model",
	reasoningLevel: "low",
	toolEnvironment: "synthetic",
	expiresAt: "2027-01-01T00:00:00.000Z",
};
const boundary = {
	schemaVersion: 1,
	principal: { kind: "application", id: "app" },
	agentId: "agent",
	channelId: "eval",
	identityRevision: "identity-1",
	agentAuthorizationRevision: "agent-1",
	accessSources: [{ kind: "eval-use", useGrantRevision: "use-1" }],
	evaluation,
};
it("keeps Eval application identity and default Agent Key source distinct from API", () => {
	const parsed = parseTaskAuthorizationBoundaryV1(boundary);
	expect(isTaskApiChannelV1(parsed.channelId, parsed.principal)).toBe(false);
	const authority = {
		schemaVersion: 1 as const,
		actorId: "app",
		agentId: "agent",
		channelId: "eval",
		authorizationRevision: "agent-1",
		supportsSupplementaryInstruction: false,
		taskBoundary: parsed,
	};
	expect(
		conversationExecutionKeySubjectV1(authority, "standard", {
			schemaVersion: 1,
			applicationId: "app",
			status: "active",
			authorizationRevision: "identity-1",
			useGrant: {
				principal: { kind: "application", id: "app" },
				grantType: "use",
				agentId: "agent",
				authorizationRevision: "use-1",
				revoked: false,
			},
		}),
	).toEqual({
		executionSource: "eval",
		purpose: "agent-default",
		subjectId: "agent",
	});
});
it("rejects missing/cross-channel bindings, copied API grants, Owner fallback and caller additions", () => {
	const { evaluation: _ignored, ...unbound } = boundary;
	for (const invalid of [
		unbound,
		{ ...boundary, channelId: "api:application" },
		{
			...boundary,
			accessSources: [{ kind: "api-use", useGrantRevision: "use-1" }],
		},
		{
			...boundary,
			principal: { kind: "user", id: "app" },
			accessSources: [{ kind: "owner", userId: "app" }],
		},
		{ ...boundary, evaluation: { ...evaluation, operatorId: "admin" } },
	])
		expect(() => parseTaskAuthorizationBoundaryV1(invalid)).toThrow();
});
