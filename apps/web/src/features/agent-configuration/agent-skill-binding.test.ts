import { describe, expect, it } from "vitest";
import {
	minimalSkillGrant,
	nextSkillBindingCollection,
	type RuntimeSkill,
	type SkillBindingStatus,
	skillBindingView,
	skillGrantSummary,
} from "./agent-skill-binding.js";
import { digest, skillBinding } from "./agent-skill-binding-test-fixtures.js";

const assembled: RuntimeSkill[] = [
	{
		schemaVersion: 1,
		name: "workspace-summary",
		version: "1.0.0",
		packageDigest: digest("a"),
		manifestSha256: digest("b"),
		readOnly: true,
	},
];

const states = (binding: SkillBindingStatus, runtime?: RuntimeSkill[]) =>
	skillBindingView(binding, runtime).stages?.map((stage) => stage.state) ??
	null;

describe("Agent Skill binding stages (O-02)", () => {
	it("maps every server state, with and without Runtime assembly, to four stages", () => {
		for (const runtime of [undefined, assembled]) {
			expect(states(skillBinding("pending_sync"), runtime)).toEqual([
				"完成",
				"等待",
				"未开始",
				"未开始",
			]);
			expect(states(skillBinding("failed"), runtime)).toEqual([
				"完成",
				"失败",
				"未开始",
				"未开始",
			]);
			expect(states(skillBinding("revoked"), runtime)).toBeNull();
		}
		expect(states(skillBinding("synced"))).toEqual([
			"完成",
			"完成",
			"完成",
			"进行中",
		]);
		expect(states(skillBinding("synced"), assembled)).toEqual([
			"完成",
			"完成",
			"完成",
			"完成",
		]);
	});

	it("only calls a binding usable when the Runtime summary has the same package", () => {
		expect(skillBindingView(skillBinding("synced"), assembled)).toMatchObject({
			chip: { label: "对话可用", tone: "gray" },
			usable: true,
			settling: false,
		});
		const otherPackage = [
			{ ...assembled[0], packageDigest: digest("e") },
		] as RuntimeSkill[];
		expect(
			skillBindingView(skillBinding("synced"), otherPackage),
		).toMatchObject({
			chip: { label: "等待确认" },
			usable: false,
			settling: true,
		});
		expect(skillBindingView(skillBinding("failed"), assembled)).toMatchObject({
			chip: { label: "同步失败", tone: "red" },
			error: "内容同步失败，这个版本不会在对话中提供。",
			usable: false,
		});
		expect(skillBindingView(skillBinding("revoked"), assembled)).toMatchObject({
			chip: { label: "版本已撤销", tone: "red" },
			error: "新的调用已被阻止，已保存的执行记录保持原版本。",
		});
		// 失败原因原文不展示。
		expect(
			JSON.stringify(skillBindingView(skillBinding("failed"), assembled)),
		).not.toContain("internal sync detail");
	});

	it("marks the current stage and the failed stage", () => {
		const pending = skillBindingView(skillBinding("pending_sync"), undefined);
		expect(pending.stages?.map((stage) => stage.current)).toEqual([
			false,
			true,
			false,
			false,
		]);
		const failed = skillBindingView(skillBinding("failed"), undefined);
		expect(failed.stages?.map((stage) => stage.failed)).toEqual([
			false,
			true,
			false,
			false,
		]);
	});
});

describe("Agent Skill binding collection (O-02)", () => {
	it("keeps existing bindings and grants and appends a new version with the minimal grant", () => {
		const existing = {
			...skillBinding("synced"),
			grant: { ...minimalSkillGrant(), tools: ["read_file"] },
		};
		expect(
			nextSkillBindingCollection([existing], {
				skillVersionId: "code-review-v1",
				skillName: "code-review",
			}),
		).toEqual([
			{ skillVersionId: "workspace-summary-v1", grant: existing.grant },
			{ skillVersionId: "code-review-v1", grant: minimalSkillGrant() },
		]);
	});

	it("replaces another version of the same Skill and keeps its grant", () => {
		const existing = {
			...skillBinding("pending_sync"),
			grant: { ...minimalSkillGrant(), connections: ["github"] },
		};
		expect(
			nextSkillBindingCollection([existing], {
				skillVersionId: "workspace-summary-v2",
				skillName: "workspace-summary",
			}),
		).toEqual([
			{ skillVersionId: "workspace-summary-v2", grant: existing.grant },
		]);
	});

	it("does not resubmit an already bound version and drops revoked versions", () => {
		expect(
			nextSkillBindingCollection([skillBinding("synced")], {
				skillVersionId: "workspace-summary-v1",
				skillName: "workspace-summary",
			}),
		).toBeNull();
		expect(
			nextSkillBindingCollection(
				[skillBinding("revoked", { name: "old-skill" })],
				{ skillVersionId: "code-review-v1", skillName: "code-review" },
			),
		).toEqual([
			{ skillVersionId: "code-review-v1", grant: minimalSkillGrant() },
		]);
	});

	it("summarizes grants without internal identifiers", () => {
		expect(skillGrantSummary(minimalSkillGrant())).toBe(
			"不额外授予工具、Connection、文件或网络权限 · 脚本禁用",
		);
		expect(
			skillGrantSummary({
				...minimalSkillGrant(),
				tools: ["internal_tool_id"],
				fileRoots: ["/workspace"],
			}),
		).toBe("授予 1 个工具、1 个文件范围 · 脚本禁用");
	});
});
