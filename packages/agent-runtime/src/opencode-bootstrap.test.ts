import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	type OpenCodeRuntimeOptions,
	openCodeNativeSkillPrompt,
	openCodeSearchAllowed,
	resolveOpenCodeSkillHome,
	validateOpenCodeRuntimeOptions,
} from "./opencode-bootstrap.js";

const option = {
	modelOptionId: "primary",
	model: "claude-opus-5",
	reasoningLevels: ["high"],
	endpoint: "https://models.example.test/v1",
	authentication: "bearer" as const,
};

function options(
	override: Partial<OpenCodeRuntimeOptions> = {},
): OpenCodeRuntimeOptions {
	return {
		path: "/tmp/opencode-driver",
		executable: "/opt/opencode/bin/opencode",
		configVersion: "configuration-v4",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [option],
		...override,
	};
}

it("rejects keyless OpenCode startup without Host authorization", () => {
	expect(() => validateOpenCodeRuntimeOptions(options())).toThrow(
		"RUNTIME_CONFIGURATION_INVALID",
	);
});

it("accepts keyless OpenCode startup with Host authorization", () => {
	expect(() =>
		validateOpenCodeRuntimeOptions(
			options({ authorizeModelAction: async () => ({ relayKey: "key" }) }),
		),
	).not.toThrow();
});

it("retains static credential validation for legacy OpenCode options", () => {
	expect(() =>
		validateOpenCodeRuntimeOptions(
			options({
				configVersion: "configuration-v3",
				modelOptions: [{ ...option, credential: "static-model-key-012345" }],
			}),
		),
	).not.toThrow();
});

it("uses the verified Applied root as the private OpenCode Skill home", () => {
	const skillDirectory = {
		nativeRoot: "/opt/agent-infra-skill-hub",
		generationId: "a".repeat(64),
		findSkills: () => [],
		readSkill: async () => new Uint8Array(),
	};
	expect(resolveOpenCodeSkillHome("/tmp/session", skillDirectory)).toBe(
		"/opt/agent-infra-skill-hub",
	);
	expect(resolveOpenCodeSkillHome("/tmp/session")).toBe("/tmp/session/home");
});

it("maps a verified Applied Skill to a bounded OpenCode slash prompt", () => {
	expect(
		openCodeNativeSkillPrompt("workspace-summary", "summarize files"),
	).toBe("/workspace-summary summarize files");
	expect(
		openCodeNativeSkillPrompt("workspace-summary", "summarize src/project.ts"),
	).toBe("/workspace-summary summarize src/project.ts");
	expect(openCodeNativeSkillPrompt("workspace-summary", "")).toBe(
		"/workspace-summary",
	);
	for (const parameters of [
		"summarize\nfiles",
		"summarize\tfiles",
		"summarize\u0000files",
		"summarize\u0085files",
		"summarize\u009bfiles",
		"/other-skill",
		"/tmp/secret",
		"../outside",
		"..\\outside",
		"a://external.example",
		"https://external.example/target",
		"inspect https://external.example/target",
	])
		expect(() =>
			openCodeNativeSkillPrompt("workspace-summary", parameters),
		).toThrow("RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED");
	expect(() => openCodeNativeSkillPrompt("../outside", "summarize")).toThrow(
		"RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
	);
	expect(() =>
		openCodeNativeSkillPrompt("https://caller.example/skill", "summarize"),
	).toThrow("RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED");
	expect(() =>
		openCodeNativeSkillPrompt("workspace-summary", "\ud800"),
	).toThrow("RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED");
	expect(() =>
		openCodeNativeSkillPrompt("workspace-summary", "x".repeat(16 * 1024)),
	).toThrow("RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED");
});

// #3217：OpenCode 的 glob 与 grep 只在本 Conversation 工作区内授权。
it("authorizes OpenCode search only inside the Conversation workspace", async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "opencode-search-")),
	);
	const workspace = join(root, "workspace");
	const outside = join(root, "outside");
	await mkdir(join(workspace, "src"), { recursive: true });
	await mkdir(outside);
	await symlink(outside, join(workspace, "escape"));
	try {
		for (const input of [
			{ pattern: "**/*.ts" },
			{ pattern: "*.md", path: "src" },
			{ pattern: "*", path: workspace },
			{ pattern: "TODO\\(", include: "*.ts", path: join(workspace, "src") },
		])
			expect(await openCodeSearchAllowed(workspace, input)).toBe(true);
		for (const input of [
			undefined,
			{},
			{ pattern: "*", path: outside },
			{ pattern: "*", path: ".." },
			{ pattern: "*", path: "escape" },
			{ pattern: `${outside}/*` },
			{ pattern: "../outside/*" },
			{ pattern: "x", include: "../**" },
			{ pattern: "x", include: "/etc/*" },
			{ pattern: "x", path: "/proc" },
			{ pattern: "a\0b" },
		])
			expect(await openCodeSearchAllowed(workspace, input)).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
