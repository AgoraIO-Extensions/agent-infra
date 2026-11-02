import { describe, expect, it } from "vitest";
import {
	assertNoWorkspaceSnapshotCredentialPatternV1,
	assertWorkspaceSnapshotArchiveEntryTypeV1,
	assertWorkspaceSnapshotArchivePathV1,
	assertWorkspaceSnapshotDeleteAllowedV1,
	assertWorkspaceSnapshotGcEligibleV1,
	assertWorkspaceSnapshotQuotaV1,
	validateWorkspaceSnapshotProvenanceV1,
	WorkspaceSnapshotSecurityErrorV1,
} from "./workspace-snapshot-security.js";

const digest = 2 * 1024 ** 2;

describe("workspace snapshot security and lifecycle", () => {
	it("requires verified Connection provenance for builder output", () => {
		expect(
			validateWorkspaceSnapshotProvenanceV1({
				ownerType: "user",
				ownerId: "user-1",
				source: { kind: "direct-upload" },
			}),
		).toMatchObject({ source: { kind: "direct-upload" } });
		expect(() =>
			validateWorkspaceSnapshotProvenanceV1({
				ownerType: "user",
				ownerId: "user-1",
				source: {
					kind: "builder-connection",
					repository: "https://github.com/acme/repo",
					commitSha: "a".repeat(40),
					connectionCallReference: "call-1",
				},
			}),
		).toThrowError(
			new WorkspaceSnapshotSecurityErrorV1("unauthorized_provenance"),
		);
		expect(() =>
			validateWorkspaceSnapshotProvenanceV1({
				ownerType: "user",
				ownerId: "user-1",
				connectionAuthorized: true,
				source: {
					kind: "builder-connection",
					repository: "https://user:secret@example.com/repo",
					commitSha: "a".repeat(40),
					connectionCallReference: "call-1",
				},
			}),
		).toThrow(WorkspaceSnapshotSecurityErrorV1);
	});

	it("rejects traversal, links and obvious credentials", () => {
		expect(() => assertWorkspaceSnapshotArchivePathV1("../secret")).toThrow(
			WorkspaceSnapshotSecurityErrorV1,
		);
		expect(() => assertWorkspaceSnapshotArchiveEntryTypeV1("symlink")).toThrow(
			WorkspaceSnapshotSecurityErrorV1,
		);
		expect(() =>
			assertNoWorkspaceSnapshotCredentialPatternV1(
				"-----BEGIN PRIVATE KEY-----",
			),
		).toThrow(WorkspaceSnapshotSecurityErrorV1);
	});

	it("enforces archive, owner and Agent quota", () => {
		expect(() =>
			assertWorkspaceSnapshotQuotaV1({
				archiveBytes: digest,
				unpackedBytes: digest,
				ownerStoredBytes: 10 * 1024 ** 3,
				agentArchiveBytes: 0,
				agentUnpackedBytes: 0,
				agentBindingCount: 0,
			}),
		).toThrow(WorkspaceSnapshotSecurityErrorV1);
		expect(() =>
			assertWorkspaceSnapshotQuotaV1({
				archiveBytes: digest,
				unpackedBytes: digest,
				ownerStoredBytes: 0,
				agentArchiveBytes: 0,
				agentUnpackedBytes: 0,
				agentBindingCount: 4,
			}),
		).toThrow(WorkspaceSnapshotSecurityErrorV1);
		expect(() =>
			assertWorkspaceSnapshotQuotaV1({
				archiveBytes: digest,
				unpackedBytes: digest,
				ownerStoredBytes: 0,
				agentArchiveBytes: 0,
				agentUnpackedBytes: 0,
				agentBindingCount: 0,
			}),
		).not.toThrow();
	});

	it("allows GC only after retention and zero bindings", () => {
		const now = new Date("2026-11-10T00:00:00Z");
		assertWorkspaceSnapshotGcEligibleV1({
			candidate: {
				snapshotId: "s",
				status: "ready",
				createdAt: "2026-11-01T00:00:00Z",
				bindings: [],
			},
			now,
			retentionMs: 7 * 24 * 60 * 60 * 1000,
		});
		expect(() =>
			assertWorkspaceSnapshotGcEligibleV1({
				candidate: {
					snapshotId: "s",
					status: "ready",
					createdAt: "2026-11-09T00:00:00Z",
					bindings: [],
				},
				now,
				retentionMs: 7 * 24 * 60 * 60 * 1000,
			}),
		).toThrow(WorkspaceSnapshotSecurityErrorV1);
		expect(() => assertWorkspaceSnapshotDeleteAllowedV1(["binding"])).toThrow(
			WorkspaceSnapshotSecurityErrorV1,
		);
	});
});
