import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	createSkillHubProjectPublicationV1,
	normalizeSkillHubProjectFilesV1,
	type SkillHubProjectPublicationDependenciesV1,
	type SkillHubProjectPublicationRecoveryV1,
} from "./skill-hub-project-content.js";
import type { SkillPackagePublicationResultV1 } from "./skill-package-publication.js";

const context = { userId: "owner-a", requestId: "r", traceId: "t" };
const archive = new TextEncoder().encode("synthetic zip");
const digest = createHash("sha256").update(archive).digest("hex");
function setup(
	change: (value: SkillHubProjectPublicationRecoveryV1) => void = () => {},
	revision = 2,
	packed = archive,
) {
	const original: SkillHubProjectPublicationRecoveryV1 = {
		key: "original-key",
		selection: {
			schemaVersion: 1,
			name: "review",
			skillId: "project-a",
			skillVersionId: `skill-version-${createHash("sha256").update("project:project-a:owner-a:original-key").digest("hex").slice(0, 48)}`,
			visibility: "PRIVATE",
			provider: "my_library",
			version: "1.0.0",
			sourceVersion: "project:project-a:r2",
			sourceDigest: digest,
			approvalRef: null,
			trustRevision: "trust",
			policyRevision: "policy",
			archiveDigest: digest,
		},
		completed: null,
	};
	change(original);
	const result = {
		replayed: false,
		version: {},
		artifacts: {},
	} as SkillPackagePublicationResultV1;
	const admit = vi.fn(
		async (
			_input: Parameters<SkillHubProjectPublicationDependenciesV1["admit"]>[0],
		) => result,
	);
	const pack = vi.fn(() => packed);
	const readRecovery = vi.fn(async () => original);
	const publication = createSkillHubProjectPublicationV1({
		readRecovery,
		pack,
		admit,
		readSource: async (_request, _project, check) => {
			const source = {
				project: {
					schemaVersion: 1 as const,
					projectId: "project-a",
					name: "review",
					ownerId: "owner-a",
					organizationId: null,
					status: "active" as const,
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				},
				revision,
				content: normalizeSkillHubProjectFilesV1([
					{ path: "SKILL.md", bytes: new TextEncoder().encode("# review") },
				]),
				organizationMember: false,
			};
			check(source);
			return source;
		},
	});
	return { original, result, admit, pack, readRecovery, publication };
}
// All I/O is local stubbed input. This is the same domain entry used by the HTTP route.
describe("original project publication recovery", () => {
	it("reuses the server-held key, revision and version through normal publication", async () => {
		const x = setup();
		expect(
			await x.publication.recover(context, "project-a", "operation-a"),
		).toBe(x.result);
		expect(x.readRecovery).toHaveBeenCalledWith(
			context,
			"project-a",
			"operation-a",
		);
		expect(x.admit).toHaveBeenCalledOnce();
		expect(x.admit.mock.calls[0]?.[0]).toMatchObject({
			key: "original-key",
			selection: {
				skillVersionId: x.original.selection.skillVersionId,
				version: "1.0.0",
			},
			source: { sourceVersion: "project:project-a:r2", sourceDigest: digest },
		});
	});
	it.each([
		"skillId",
		"skillVersionId",
		"provider",
		"sourceVersion",
		"sourceDigest",
		"approvalRef",
	])("rejects a foreign/corrupt %s before supplying objects", async (field) => {
		const x = setup((v) => {
			Object.assign(v.selection, {
				[field]: field === "sourceDigest" ? "a".repeat(64) : "foreign",
			});
		});
		await expect(
			x.publication.recover(context, "project-a", "operation-a"),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(x.admit).not.toHaveBeenCalled();
		expect(x.pack).not.toHaveBeenCalled();
	});
	it("rejects a different current Owner before package work", async () => {
		const x = setup();
		await expect(
			x.publication.recover(
				{ ...context, userId: "owner-b" },
				"project-a",
				"operation-a",
			),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(x.admit).not.toHaveBeenCalled();
	});
	it("rejects changed project revision before package work", async () => {
		const x = setup(() => {}, 3);
		await expect(
			x.publication.recover(context, "project-a", "operation-a"),
		).rejects.toMatchObject({ code: "version_conflict" });
		expect(x.admit).not.toHaveBeenCalled();
	});
	it("rejects changed archive bytes before entering supplier", async () => {
		const x = setup(() => {}, 2, new TextEncoder().encode("changed zip"));
		await expect(
			x.publication.recover(context, "project-a", "operation-a"),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(x.admit).not.toHaveBeenCalled();
	});
	it("returns the completed original result without repacking or supply", async () => {
		const x = setup();
		Object.assign(x.original, { completed: { ...x.result, replayed: true } });
		expect(
			await x.publication.recover(context, "project-a", "operation-a"),
		).toBe(x.original.completed);
		expect(x.admit).not.toHaveBeenCalled();
		expect(x.pack).not.toHaveBeenCalled();
	});
	it("fails closed if recovery storage is not assembled", async () => {
		const x = setup();
		const publication = createSkillHubProjectPublicationV1({
			pack: x.pack,
			admit: x.admit,
			readSource: vi.fn(),
		});
		await expect(
			publication.recover(context, "project-a", "operation-a"),
		).rejects.toMatchObject({ code: "unavailable" });
	});
});
