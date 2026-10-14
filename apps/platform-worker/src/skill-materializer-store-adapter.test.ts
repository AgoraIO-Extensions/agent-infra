import type {
	SkillHubAppliedReceiptV1,
	SkillHubSyncBindingV1,
} from "@agent-infra/contracts";
import { expect, it, vi } from "vitest";
import {
	createSkillHubStoreMaterializationAdapterV1,
	type SkillHubMaterializationStoreV1,
	type SkillHubPackageObjectResolverV1,
} from "./skill-materializer-store-adapter.js";

const digest = (char: string) => char.repeat(64);
const packageObject = {
	objectRef: "11111111-1111-4111-8111-111111111111",
	version: "object-version-a",
	etag: "etag-a",
	sizeBytes: 12,
	mediaType: "application/zip",
	sha256: digest("a"),
} as const;
const binding = {
	schemaVersion: 1,
	agentId: "agent-1",
	agentVersion: "agent-version-1",
	skillName: "workspace-summary",
	skillVersion: {
		schemaVersion: 1,
		skillId: "skill-1",
		skillVersionId: "skill-version-1",
		provider: "my_library",
		version: "1.0.0",
		packageObjectVersion: packageObject.version,
		packageDigest: packageObject.sha256,
		manifestDigest: digest("b"),
		signatureDigest: digest("c"),
	},
	grant: {
		schemaVersion: 1,
		tools: [],
		connections: [],
		fileRoots: [],
		networkOrigins: [],
		scripts: false,
	},
	configurationRevision: 4,
	syncRevision: 2,
	state: "pending_sync",
	failureReason: null,
	appliedReceipt: null,
} satisfies SkillHubSyncBindingV1;

const input = {
	agentId: "agent-1",
	configurationRevision: 4,
	workloadRevision: 7,
	fence: 3,
};

function storeFixture(
	bindings: readonly SkillHubSyncBindingV1[] = [binding],
): SkillHubMaterializationStoreV1 & {
	receipts: SkillHubAppliedReceiptV1[];
	lastResolve: unknown;
} {
	const receipts: SkillHubAppliedReceiptV1[] = [];
	const result = {
		receipts,
		lastResolve: undefined as unknown,
		async resolveSyncBindings(value: unknown) {
			result.lastResolve = value;
			return bindings;
		},
		async recordAppliedReceipt(value: unknown) {
			receipts.push(value as SkillHubAppliedReceiptV1);
			return value as SkillHubAppliedReceiptV1;
		},
	};
	return result;
}

function adapterFor(
	store: SkillHubMaterializationStoreV1,
	resolvePackageObject: SkillHubPackageObjectResolverV1 = async () =>
		packageObject,
) {
	return createSkillHubStoreMaterializationAdapterV1({
		store,
		agentVersion: "agent-version-1",
		actor: {
			actorId: "owner-1",
			organizationIds: ["org-1"],
			isAdministrator: false,
		},
		resolvePackageObject,
	});
}

it("maps Store bindings and keeps fixed actor facts out of Workload input", async () => {
	const store = storeFixture();
	const resolvePackageObject = vi.fn(async () => packageObject);
	const adapter = adapterFor(store, resolvePackageObject);
	await expect(adapter.resolveBindings(input)).resolves.toEqual([
		{
			agentId: "agent-1",
			name: "workspace-summary",
			agentVersion: "agent-version-1",
			skillVersion: binding.skillVersion,
			packageObject,
			grant: binding.grant,
			syncRevision: 2,
		},
	]);
	expect(store.lastResolve).toEqual({
		agentId: "agent-1",
		agentVersion: "agent-version-1",
		configurationRevision: 4,
		actorId: "owner-1",
		organizationIds: ["org-1"],
		isAdministrator: false,
		workloadRevision: 7,
		fence: 3,
	});
	expect(resolvePackageObject).toHaveBeenCalledWith({
		skillVersionId: "skill-version-1",
		packageObjectVersion: "object-version-a",
		signal: expect.any(AbortSignal),
	});
});

it.each([
	["failed", { ...binding, state: "failed", failureReason: "materialize" }],
	["revoked", { ...binding, state: "revoked", failureReason: null }],
	["stale configuration", { ...binding, configurationRevision: 3 }],
	["cross Agent", { ...binding, agentId: "agent-2" }],
	["cross Agent Version", { ...binding, agentVersion: "agent-version-2" }],
])("rejects %s bindings", async (_label, candidate) => {
	const adapter = adapterFor(
		storeFixture([candidate as SkillHubSyncBindingV1]),
	);
	await expect(adapter.resolveBindings(input)).rejects.toMatchObject({
		code: "unavailable",
	});
});

it("rejects duplicate names, missing objects and immutable object mismatches", async () => {
	const duplicate = { ...binding, syncRevision: 3 };
	await expect(
		adapterFor(storeFixture([binding, duplicate])).resolveBindings(input),
	).rejects.toThrow("Duplicate Skill name");
	await expect(
		adapterFor(storeFixture(), async () => undefined).resolveBindings(input),
	).rejects.toThrow("Skill package object unavailable");
	await expect(
		adapterFor(storeFixture(), async () => ({
			...packageObject,
			sha256: digest("d"),
		})).resolveBindings(input),
	).rejects.toThrow("Skill package object mismatch");
	await expect(
		adapterFor(storeFixture(), async () => ({
			...packageObject,
			mediaType: "text/plain",
		})).resolveBindings(input),
	).rejects.toThrow("Skill package object mismatch");
});

it("delegates validated Applied receipts to Store", async () => {
	const store = storeFixture();
	const adapter = adapterFor(store);
	const receipt: SkillHubAppliedReceiptV1 = {
		schemaVersion: 1,
		agentId: "agent-1",
		agentVersion: "agent-version-1",
		skillName: "workspace-summary",
		configurationRevision: 4,
		syncRevision: 2,
		skillVersionId: "skill-version-1",
		generationId: digest("e"),
		packageDigest: digest("a"),
		manifestDigest: digest("b"),
		targetPath: ".agents/skills/workspace-summary",
		readOnly: true,
	};
	await expect(adapter.recordAppliedReceipt(receipt)).resolves.toBeUndefined();
	expect(store.receipts).toEqual([receipt]);
	await expect(
		adapter.recordAppliedReceipt({ ...receipt, targetPath: "/tmp/escape" }),
	).rejects.toMatchObject({ code: "unavailable" });
});
