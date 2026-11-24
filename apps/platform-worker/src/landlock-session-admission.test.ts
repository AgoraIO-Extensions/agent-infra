import { expect, it } from "vitest";
import {
	admitLandlockSessionV1,
	assertLandlockSessionCreationV1,
	landlockSessionPodPlacementV1,
	restoreLandlockSessionV1,
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
		nodeUids: ["node-a"],
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
			schemaVersion: 1,
			revision: "fake",
			scope,
			approvalRef: "fake",
			nodeNames: ["worker-a"],
			nodeUids: ["node-a"],
			architecture: "amd64",
		}),
	).toThrow("LANDLOCK_SESSION_EVIDENCE_REJECTED");
});
it("restores the original placement for drain after expiry without granting creation", async () => {
	const admitted = await admitLandlockSessionV1(policy, scope, () => 1000);
	const persisted = JSON.parse(JSON.stringify(admitted));
	const restored = restoreLandlockSessionV1(persisted, scope);
	expect(landlockSessionPodPlacementV1(restored)).toEqual(
		landlockSessionPodPlacementV1(admitted!),
	);
	expect(() => assertLandlockSessionCreationV1(restored)).toThrow(
		"LANDLOCK_SESSION_EVIDENCE_REJECTED",
	);
});
it("revalidates the persisted nodes rather than moving an original instance to today's nodes", async () => {
	const original = await admitLandlockSessionV1(policy, scope, () => 1000);
	await expect(
		admitLandlockSessionV1(
			{
				...policy,
				verify: async () => ({
					...(await policy.verify()),
					nodeNames: ["worker-b"],
				}),
			},
			scope,
			() => 1000,
			original,
		),
	).rejects.toThrow("LANDLOCK_SESSION_PLACEMENT_CHANGED");
});
it.each([
	"principalDigest",
	"agentId",
	"sessionId",
	"generation",
	"resourceFence",
] as const)(
	"cannot restore a persisted placement for another %s",
	async (field) => {
		const original = await admitLandlockSessionV1(policy, scope, () => 1000);
		expect(() =>
			restoreLandlockSessionV1(original, {
				...scope,
				[field]: typeof scope[field] === "number" ? 99 : "other",
			}),
		).toThrow("LANDLOCK_SESSION_SCOPE_REJECTED");
	},
);
it("does not let a caller mutate verified nodes after admission", async () => {
	const p = await admitLandlockSessionV1(policy, scope, () => 1000);
	expect(() => {
		p!.nodeNames[0] = "other";
	}).toThrow();
});

it("expiry remains bounded when the verifier later mutates its response", async () => {
	const result = await policy.verify();
	let clock = 1000;
	const plan = await admitLandlockSessionV1(
		{ ...policy, verify: async () => result },
		scope,
		() => clock,
	);
	result.expiresAt = Number.MAX_SAFE_INTEGER;
	clock = 3000;
	expect(() => assertLandlockSessionCreationV1(plan!)).toThrow(
		"LANDLOCK_SESSION_EVIDENCE_REJECTED",
	);
});
it("revalidates the same node/UID pairs in another read order without changing the persisted render", async () => {
	const pairPolicy = {
		...policy,
		verify: async () => ({
			...(await policy.verify()),
			nodeNames: ["worker-b", "worker-a"],
			nodeUids: ["uid-b", "uid-a"],
		}),
	};
	const original = await admitLandlockSessionV1(pairPolicy, scope, () => 1000);
	const refreshed = await admitLandlockSessionV1(
		{
			...pairPolicy,
			verify: async () => ({
				...(await pairPolicy.verify()),
				nodeNames: ["worker-a", "worker-b"],
				nodeUids: ["uid-a", "uid-b"],
			}),
		},
		scope,
		() => 1000,
		original,
	);
	expect(refreshed).toEqual(original);
	expect(landlockSessionPodPlacementV1(refreshed!)).toEqual(
		landlockSessionPodPlacementV1(original!),
	);
	await expect(
		admitLandlockSessionV1(
			{
				...pairPolicy,
				verify: async () => ({
					...(await pairPolicy.verify()),
					nodeUids: ["uid-a", "uid-b"],
				}),
			},
			scope,
			() => 1000,
			original,
		),
	).rejects.toThrow("LANDLOCK_SESSION_PLACEMENT_CHANGED");
});
it("keeps the placement revision captured before the asynchronous verification", async () => {
	const live = {
		...policy,
		revision: "original-revision",
		verify: async () => {
			live.revision = "later-revision";
			return policy.verify();
		},
	};
	expect(
		(await admitLandlockSessionV1(live, scope, () => 1000))?.revision,
	).toBe("original-revision");
});
