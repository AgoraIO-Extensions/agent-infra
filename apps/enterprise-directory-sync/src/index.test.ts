import { DirectorySyncError } from "@agent-infra/enterprise-directory";
import { describe, expect, it } from "vitest";
import { syncFailureLogRecord, syncLogRecord } from "./index.js";

describe("directory sync logging", () => {
	it("reports aggregate counts only for a published version", () => {
		const published = syncLogRecord(
			{
				status: "published",
				revision: "published-revision",
				fetchedAt: 100,
				validUntil: 200,
				summary: {
					baselineRevision: "previous-revision",
					departmentCount: 2,
					memberCount: 5,
					addedMembers: 2,
					removedMembers: 1,
					membershipChangedMembers: 1,
					inactiveMembers: 1,
					missingEmailMembers: 1,
					invalidEmailMembers: 0,
					duplicateEmailMembers: 2,
					unmappableMembers: 3,
				},
			},
			3,
		);
		expect(published).toMatchObject({
			event: "snapshot_published",
			revision: "published-revision",
			addedMembers: 2,
			removedMembers: 1,
			unmappableMembers: 3,
			durationMs: 3,
		});
		expect(JSON.stringify(published)).not.toContain("@example.test");
		expect(JSON.stringify(published)).not.toContain("wecom-user");
		expect(syncLogRecord({ status: "superseded" }, 4)).toEqual({
			service: "enterprise-directory-sync",
			event: "snapshot_superseded",
			durationMs: 4,
		});
	});

	it("limits failure output to a known reason", () => {
		expect(
			syncFailureLogRecord(new DirectorySyncError("source_unavailable"), 5),
		).toEqual({
			service: "enterprise-directory-sync",
			event: "snapshot_sync_failed",
			reason: "source_unavailable",
			durationMs: 5,
		});
		expect(
			syncFailureLogRecord(new Error("wecom-user secret@example.test"), 5),
		).toMatchObject({ reason: "unexpected" });
	});
});
