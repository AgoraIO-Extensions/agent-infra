import { describe, expect, it } from "vitest";
import {
	SkillHubAppliedReceiptV1Schema,
	SkillHubSyncBindingV1Schema,
	validateSkillHubAppliedReceiptV1,
} from "./skill-hub.ts";

const digest = "a".repeat(64);
const version = {
	schemaVersion: 1 as const,
	skillId: "skill-1",
	skillVersionId: "skill-version-1",
	provider: "system" as const,
	version: "1.0.0",
	packageObjectVersion: "object-1",
	packageDigest: digest,
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
};

const pending = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	agentVersion: "agent-version-1",
	skillName: "workspace-summary",
	skillVersion: version,
	configurationRevision: 3,
	syncRevision: 1,
	state: "pending_sync" as const,
	failureReason: null,
	appliedReceipt: null,
};

const receipt = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	agentVersion: "agent-version-1",
	skillName: "workspace-summary",
	configurationRevision: 3,
	syncRevision: 2,
	skillVersionId: version.skillVersionId,
	generationId: "d".repeat(64),
	packageDigest: version.packageDigest,
	manifestDigest: version.manifestDigest,
	targetPath: ".agents/skills/workspace-summary",
	readOnly: true as const,
};

describe("Skill Hub sync and Applied contracts", () => {
	it("accepts each explicit state and binds a synced receipt", () => {
		expect(SkillHubSyncBindingV1Schema.parse(pending).state).toBe(
			"pending_sync",
		);
		const synced = SkillHubSyncBindingV1Schema.parse({
			...pending,
			syncRevision: 2,
			state: "synced",
			appliedReceipt: receipt,
			failureReason: null,
		});
		expect(validateSkillHubAppliedReceiptV1(synced, receipt)).toEqual(receipt);
		expect(
			SkillHubSyncBindingV1Schema.parse({
				...pending,
				state: "failed",
				failureReason: "materializer_unavailable",
			}).state,
		).toBe("failed");
	});

	it("rejects invalid failure and Applied receipt bindings", () => {
		expect(
			SkillHubSyncBindingV1Schema.safeParse({
				...pending,
				state: "failed",
				failureReason: null,
			}).success,
		).toBe(false);
		const synced = SkillHubSyncBindingV1Schema.parse({
			...pending,
			syncRevision: 2,
			state: "synced",
			appliedReceipt: receipt,
		});
		expect(
			SkillHubSyncBindingV1Schema.safeParse({
				...synced,
				appliedReceipt: { ...receipt, agentId: "other-agent" },
			}).success,
		).toBe(false);
		try {
			validateSkillHubAppliedReceiptV1(synced, {
				...receipt,
				manifestDigest: "e".repeat(64),
			});
			throw new Error("expected mismatch");
		} catch (error) {
			expect((error as { message?: string }).message).toContain(
				"binding mismatch",
			);
		}
		try {
			validateSkillHubAppliedReceiptV1(synced, {
				...receipt,
				generationId: "e".repeat(64),
			});
			throw new Error("expected generation mismatch");
		} catch (error) {
			expect((error as { message?: string }).message).toContain(
				"binding mismatch",
			);
		}
		expect(
			SkillHubAppliedReceiptV1Schema.safeParse({
				...receipt,
				readOnly: false,
			}).success,
		).toBe(false);
	});
});
