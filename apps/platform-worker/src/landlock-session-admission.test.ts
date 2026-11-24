import { expect, it } from "vitest";
import {
	admitLandlockSessionV1,
	landlockSessionPodPlacementV1,
} from "./landlock-session-admission.js";

const scope = {
	principalDigest: "subject-a",
	channelId: "web",
	agentId: "a",
	sessionId: "s",
	sandboxId: "b",
	namespace: "test",
	generation: 1,
	resourceFence: 2,
	imageDigest: `sha256:${"a".repeat(64)}`,
	resourceConfigurationHash: "hash",
	driver: "claude" as const,
};
const policy = {
	enabled: true as const,
	revision: "review-1",
	verify: async () => ({
		scope,
		approvalRef: "review-1",
		expiresAt: 2000,
		nodeNames: ["worker-a"],
		architecture: "amd64" as const,
	}),
};
it("leaves default-off deployments unchanged", async () => {
	expect(await admitLandlockSessionV1(undefined, scope)).toBeUndefined();
});
it("pins only verified nodes and architecture", async () => {
	const p = await admitLandlockSessionV1(policy, scope, () => 1000);
	expect(p).toBeDefined();
	if (!p) throw new Error();
	expect(landlockSessionPodPlacementV1(p)).toMatchObject({
		nodeSelector: { "kubernetes.io/arch": "amd64" },
		affinity: {
			nodeAffinity: {
				requiredDuringSchedulingIgnoredDuringExecution: {
					nodeSelectorTerms: [{ matchFields: [{ values: ["worker-a"] }] }],
				},
			},
		},
	});
});
it.each([
	"principalDigest",
	"channelId",
	"agentId",
	"sessionId",
	"sandboxId",
	"namespace",
	"generation",
	"resourceFence",
	"imageDigest",
	"resourceConfigurationHash",
	"driver",
] as const)("rejects another original %s", async (field) => {
	await expect(
		admitLandlockSessionV1(
			policy,
			{
				...scope,
				[field]:
					field === "generation" || field === "resourceFence" ? 3 : "other",
			},
			() => 1000,
		),
	).rejects.toThrow("LANDLOCK_SESSION_SCOPE_REJECTED");
});
it("refuses expired evidence and empty node sets", async () => {
	await expect(
		admitLandlockSessionV1(policy, scope, () => 3000),
	).rejects.toThrow("LANDLOCK_SESSION_EVIDENCE_REJECTED");
	await expect(
		admitLandlockSessionV1(
			{
				...policy,
				verify: async () => ({ ...(await policy.verify()), nodeNames: [] }),
			},
			scope,
			() => 1000,
		),
	).rejects.toThrow("LANDLOCK_SESSION_EVIDENCE_REJECTED");
});
it("cannot use a caller-made projection to schedule a Pod", () => {
	expect(() =>
		landlockSessionPodPlacementV1({
			approvalRef: "fake",
			digest: "f",
			nodeNames: ["worker-a"],
			architecture: "amd64",
		}),
	).toThrow("LANDLOCK_SESSION_EVIDENCE_REJECTED");
});
