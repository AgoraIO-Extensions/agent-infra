import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SkillHubOperationErrorV1 } from "./skill-hub-management.js";
import type { SkillHubProjectV1 } from "./skill-hub-project.js";
import {
	createSkillHubProjectPublicationV1,
	normalizeSkillHubProjectFilesV1,
	parseSkillHubProjectContentUpdateV1,
	parseSkillHubProjectPublicationRequestV1,
	projectSkillHubProjectContentV1,
	type SkillHubProjectPublicationDependenciesV1,
	skillHubProjectContentLimitsV1,
} from "./skill-hub-project-content.js";

const encoder = new TextEncoder();
const file = (path: string, content: string | Uint8Array = "x") => ({
	path,
	bytes: typeof content === "string" ? encoder.encode(content) : content,
});
const update = (files: unknown[], baseRevision = 0) => ({
	schemaVersion: 1,
	baseRevision,
	files,
});
const text = (path: string, content = "x") => ({
	path,
	encoding: "utf8",
	content,
});
const invalid = { code: "invalid_input" };

describe("Skill Hub project content (#2906)", () => {
	it("normalizes text and binary files in path byte order with a stable digest", () => {
		const parsed = parseSkillHubProjectContentUpdateV1(
			update([
				text("scripts/run.sh", "echo run\n"),
				text("SKILL.md", "# 摘要\n"),
				{
					path: "assets/logo.png",
					encoding: "base64",
					content: "iVBORw0KGgo=",
				},
			]),
		);
		expect(parsed.baseRevision).toBe(0);
		expect(parsed.content.files.map((entry) => entry.path)).toEqual([
			"SKILL.md",
			"assets/logo.png",
			"scripts/run.sh",
		]);
		expect(parsed.content.fileCount).toBe(3);
		expect(parsed.content.totalBytes).toBe(
			encoder.encode("# 摘要\n").byteLength + 8 + 9,
		);
		// 同一组文件不论提交顺序，摘要相同；内容变化时摘要变化。
		const reordered = parseSkillHubProjectContentUpdateV1(
			update([
				{
					path: "assets/logo.png",
					encoding: "base64",
					content: "iVBORw0KGgo=",
				},
				text("SKILL.md", "# 摘要\n"),
				text("scripts/run.sh", "echo run\n"),
			]),
		);
		expect(reordered.content.contentDigest).toBe(parsed.content.contentDigest);
		expect(
			parseSkillHubProjectContentUpdateV1(
				update([text("SKILL.md", "# 摘要 v2\n")]),
			).content.contentDigest,
		).not.toBe(parsed.content.contentDigest);
		const projection = projectSkillHubProjectContentV1({
			projectId: "project-a",
			revision: 1,
			updatedAt: "2026-10-01T08:00:00.000Z",
			content: parsed.content,
		});
		expect(projection.files).toEqual([
			{
				path: "SKILL.md",
				encoding: "utf8",
				content: "# 摘要\n",
				sizeBytes: encoder.encode("# 摘要\n").byteLength,
			},
			{
				path: "assets/logo.png",
				encoding: "base64",
				content: "iVBORw0KGgo=",
				sizeBytes: 8,
			},
			{
				path: "scripts/run.sh",
				encoding: "utf8",
				content: "echo run\n",
				sizeBytes: 9,
			},
		]);
		expect(
			projectSkillHubProjectContentV1({
				projectId: "project-a",
				revision: 0,
				updatedAt: null,
				content: null,
			}),
		).toMatchObject({ revision: 0, contentDigest: null, files: [] });
	});

	it.each([
		["a missing SKILL.md", [text("references/guide.md")]],
		["an empty SKILL.md", [text("SKILL.md", "")]],
		[
			"a non UTF-8 SKILL.md",
			[{ path: "SKILL.md", encoding: "base64", content: "/w==" }],
		],
		[
			"a path outside the canonical layout",
			[text("SKILL.md"), text("notes.md")],
		],
		["a backslash path", [text("SKILL.md"), text("scripts\\run.sh")]],
		["a parent segment", [text("SKILL.md"), text("scripts/../SKILL.md")]],
		["a current segment", [text("SKILL.md"), text("assets/./a")]],
		["a duplicate path", [text("SKILL.md"), text("SKILL.md")]],
		[
			"a file and directory with the same name",
			[text("SKILL.md"), text("scripts/a"), text("scripts/a/b")],
		],
		[
			"non-canonical base64",
			[
				text("SKILL.md"),
				{ path: "assets/a", encoding: "base64", content: "YQ" },
			],
		],
		[
			"an unknown encoding",
			[text("SKILL.md"), { path: "assets/a", encoding: "hex", content: "00" }],
		],
		["an extra field", [{ ...text("SKILL.md"), mode: "0755" }]],
		["a lone surrogate", [text("SKILL.md", "\ud800")]],
	])("rejects %s", (_label, files) => {
		expect(() => parseSkillHubProjectContentUpdateV1(update(files))).toThrow(
			expect.objectContaining(invalid),
		);
	});

	it("enforces the file count, per-file and total size limits", () => {
		const limits = skillHubProjectContentLimitsV1;
		const many = [
			text("SKILL.md"),
			...Array.from({ length: limits.maxFiles }, (_, index) =>
				text(`references/${index}.md`),
			),
		];
		expect(() => parseSkillHubProjectContentUpdateV1(update(many))).toThrow(
			expect.objectContaining(invalid),
		);
		expect(
			parseSkillHubProjectContentUpdateV1(
				update(many.slice(0, limits.maxFiles)),
			).content.fileCount,
		).toBe(limits.maxFiles);
		const big = "x".repeat(limits.maxFileBytes);
		expect(
			parseSkillHubProjectContentUpdateV1(update([text("SKILL.md", big)]))
				.content.totalBytes,
		).toBe(limits.maxFileBytes);
		expect(() =>
			parseSkillHubProjectContentUpdateV1(
				update([text("SKILL.md", `${big}x`)]),
			),
		).toThrow(expect.objectContaining(invalid));
		// 每个文件都在上限内，但合计超出总量上限。
		expect(() =>
			parseSkillHubProjectContentUpdateV1(
				update([
					text("SKILL.md", big),
					text("references/a.md", big),
					text("references/b.md", "x"),
				]),
			),
		).toThrow(expect.objectContaining(invalid));
		for (const baseRevision of [-1, 1.5, 2_147_483_647])
			expect(() =>
				parseSkillHubProjectContentUpdateV1(
					update([text("SKILL.md")], baseRevision),
				),
			).toThrow(expect.objectContaining(invalid));
	});

	it("accepts only the content revision, version and scope for publication", () => {
		const request = {
			schemaVersion: 1,
			contentRevision: 2,
			version: "1.0.0",
			visibility: "MARKET",
		};
		expect(parseSkillHubProjectPublicationRequestV1(request)).toEqual({
			contentRevision: 2,
			version: "1.0.0",
			visibility: "MARKET",
		});
		for (const change of [
			{ contentRevision: 0 },
			{ version: "../1" },
			{ visibility: "PUBLIC" },
			{ packageDigest: "a".repeat(64) },
			{ organizationId: "org-a" },
		])
			expect(() =>
				parseSkillHubProjectPublicationRequestV1({ ...request, ...change }),
			).toThrow(expect.objectContaining(invalid));
	});
});

describe("Skill Hub project publication use case (#2906)", () => {
	const context = { userId: "owner-a", requestId: "r", traceId: "t" };
	const project: SkillHubProjectV1 = {
		schemaVersion: 1,
		projectId: "project-a",
		name: "summary",
		ownerId: "owner-a",
		organizationId: "org-a",
		status: "active",
		createdAt: "2026-10-01T08:00:00.000Z",
		updatedAt: "2026-10-01T08:00:00.000Z",
	};
	const content = normalizeSkillHubProjectFilesV1([
		file("SKILL.md", "# summary\n"),
		file("scripts/run.sh", "echo run\n"),
	]);
	const archive = encoder.encode("zip-bytes");
	function setup(
		source: Partial<
			Awaited<
				ReturnType<SkillHubProjectPublicationDependenciesV1["readSource"]>
			>
		> = {},
	) {
		const admit = vi.fn(async (_input: unknown) => ({}) as never);
		const pack = vi.fn(() => archive);
		const checked = vi.fn();
		const publication = createSkillHubProjectPublicationV1({
			// 与 Store 一样在读取事务内执行用例检查。
			readSource: async (_context, _projectId, check) => {
				const value = {
					project,
					revision: 3,
					content,
					organizationMember: true,
					...source,
				};
				checked();
				check(value);
				return value;
			},
			pack,
			admit,
		});
		return { admit, pack, publication, checked };
	}
	const request = (visibility = "MEMBER", contentRevision = 3) => ({
		schemaVersion: 1,
		contentRevision,
		version: "1.0.0",
		visibility,
	});

	it("packs the stored revision as a my_library source and derives the version id from the key", async () => {
		const { admit, pack, publication } = setup();
		await publication.publish(context, "project-a", "key-1", request());
		expect(pack).toHaveBeenCalledWith(content.files);
		expect(admit).toHaveBeenCalledWith({
			context,
			key: "key-1",
			selection: {
				name: "summary",
				skillId: "project-a",
				skillVersionId: `skill-version-${createHash("sha256")
					.update("project:project-a:owner-a:key-1")
					.digest("hex")
					.slice(0, 48)}`,
				visibility: "MEMBER",
				provider: "my_library",
				version: "1.0.0",
			},
			source: {
				sourceVersion: "project:project-a:r3",
				sourceDigest: createHash("sha256").update(archive).digest("hex"),
				approvalRef: null,
			},
			archiveBytes: archive,
		});
		// ORGANIZATION 的组织只取项目所属组织。
		await publication.publish(
			context,
			"project-a",
			"key-2",
			request("ORGANIZATION"),
		);
		expect(admit.mock.calls[1]?.[0]).toMatchObject({
			selection: { visibility: "ORGANIZATION", organizationId: "org-a" },
		});
	});

	it.each([
		[
			"a changed content revision",
			{},
			request("MEMBER", 2),
			"version_conflict",
		],
		[
			"a project without saved content",
			{ content: null, revision: 0 },
			request(),
			"version_conflict",
		],
		[
			"a disabled project",
			{ project: { ...project, status: "disabled" as const } },
			request(),
			"forbidden",
		],
		[
			"another owner's project",
			{ project: { ...project, ownerId: "owner-b" } },
			request(),
			"unavailable",
		],
		[
			"an organization scope without a project organization",
			{ project: { ...project, organizationId: null } },
			request("ORGANIZATION"),
			"invalid_input",
		],
		[
			"an organization scope after the owner left the project organization",
			{ organizationMember: false },
			request("ORGANIZATION"),
			"forbidden",
		],
		[
			"stored content that no longer matches its digest",
			{ content: { ...content, contentDigest: "f".repeat(64) } },
			request(),
			"unavailable",
		],
	])("refuses %s before packing", async (_label, source, input, code) => {
		const { admit, pack, publication, checked } = setup(source);
		await expect(
			publication.publish(context, "project-a", "key-1", input),
		).rejects.toEqual(new SkillHubOperationErrorV1(code as "invalid_input"));
		expect(checked).toHaveBeenCalledOnce();
		expect(pack).not.toHaveBeenCalled();
		expect(admit).not.toHaveBeenCalled();
	});
});
