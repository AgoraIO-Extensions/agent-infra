import { expect, it, vi } from "vitest";
import { openPiRuntime, piNativeSkillArguments } from "./pi-bootstrap.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

it("keeps Pi Skills disabled without a trusted directory", () => {
	expect(piNativeSkillArguments(undefined)).toEqual(["--no-skills"]);
});

it("uses only projection-derived explicit Skill entry paths", () => {
	const directory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		findSkills: () => [],
		nativeSkillPaths: () => [
			"/opt/agent-infra-skill-hub/.agents/skills/workspace-summary/SKILL.md",
		],
		readSkill: async () => new Uint8Array(),
	};
	expect(piNativeSkillArguments(directory)).toEqual([
		"--no-skills",
		"--skill",
		"/opt/agent-infra-skill-hub/.agents/skills/workspace-summary/SKILL.md",
	]);
});

it("enables Skill commands only when explicit Skill arguments are present", () => {
	const directory: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "a".repeat(64),
		findSkills: () => [],
		nativeSkillPaths: () => [
			"/opt/agent-infra-skill-hub/.agents/skills/workspace-summary/SKILL.md",
		],
		readSkill: async () => new Uint8Array(),
	};
	expect(piNativeSkillArguments(undefined).includes("--skill")).toBe(false);
	expect(piNativeSkillArguments(directory).includes("--skill")).toBe(true);
});

it("fails closed for duplicate or caller-shaped native Skill paths", () => {
	for (const path of [
		"/tmp/skill.md",
		"/opt/.agents/skills/../outside/SKILL.md",
	])
		expect(() =>
			piNativeSkillArguments({
				generationId: "a".repeat(64),
				findSkills: () => [],
				nativeSkillPaths: () => [path],
				readSkill: async () => new Uint8Array(),
			}),
		).toThrow("RUNTIME_SKILL_DIRECTORY_UNAVAILABLE");
	expect(() =>
		piNativeSkillArguments({
			generationId: "a".repeat(64),
			findSkills: () => [],
			nativeSkillPaths: () => [
				"/opt/.agents/skills/a/SKILL.md",
				"/opt/.agents/skills/a/SKILL.md",
			],
			readSkill: async () => new Uint8Array(),
		}),
	).toThrow("RUNTIME_SKILL_DIRECTORY_UNAVAILABLE");
});

it("prepares a text-only SDK launch without enumerating native Skills or probing shell", async () => {
	const { mkdtemp, realpath, readFile, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "pi-sdk-bootstrap-")),
	);
	const discover = vi.fn(() => {
		throw new Error("native Skill discovery unavailable");
	});
	const daemon = await import("./paseo-daemon.js");
	const shell = await import("./pi-shell.js");
	const probe = vi
		.spyOn(shell, "piNativeShellAvailable")
		.mockRejectedValue(new Error("native shell unavailable"));
	const launch = vi
		.spyOn(daemon, "launchPaseoDaemon")
		.mockImplementation(async (input) => {
			expect(input.launch.args).toContain("--no-tools");
			expect(input.launch.args).toContain("--no-skills");
			const settings = JSON.parse(
				await readFile(join(input.directory, "config/settings.json"), "utf8"),
			);
			expect(settings.enableSkillCommands).toBe(false);
			throw new Error("stopped before daemon creation");
		});
	const { PiRuntimeDriver } = await import("./pi-runtime-driver.js");
	const factory = vi.spyOn(PiRuntimeDriver, "open");
	try {
		const runtime = await openPiRuntime({
			path: root,
			paseoSdk: true,
			configVersion: "c",
			defaultModelOptionId: "m",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "m",
					model: "test",
					reasoningLevels: ["high"],
					endpoint: "https://example.test",
					authentication: "api-key",
				},
			],
			authorizeModelAction: vi.fn(),
			skillDirectory: {
				generationId: "a".repeat(64),
				findSkills: () => [],
				readSkill: async () => new Uint8Array(),
				nativeSkillPaths: discover,
			},
		});
		try {
			const open = factory.mock.calls[0]![0].openPaseoSession!;
			await expect(
				open({
					directory: root,
					cwd: join(root, "workspace"),
					runtimeSessionRef: "ref",
					selection: {
						schemaVersion: 1,
						modelOptionId: "m",
						reasoningLevel: "high",
					},
					admit: vi.fn(),
					update: vi.fn(),
				}),
			).rejects.toThrow("stopped before daemon creation");
			expect(launch).toHaveBeenCalledOnce();
			expect(discover).not.toHaveBeenCalled();
			expect(probe).not.toHaveBeenCalled();
		} finally {
			await runtime.close();
		}
	} finally {
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	}
});

it("launches the Pi SDK with only the browser operations verified for this execution and its report writer", async () => {
	const { mkdtemp, realpath, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { browserConformanceCapability, browserConformanceBinding } =
		await import("./browser-conformance.test-support.js");
	const capability = {
		...browserConformanceCapability,
		operations: [
			"navigate",
			"observe",
			"interact",
		] as typeof browserConformanceCapability.operations,
	};
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sdk-browser-")));
	const daemon = await import("./paseo-daemon.js");
	const launch = vi
		.spyOn(daemon, "launchPaseoDaemon")
		.mockImplementation(async (input) => {
			const tools =
				input.launch.args[input.launch.args.indexOf("--tools") + 1]?.split(",");
			expect(tools?.sort()).toEqual([
				"mcp__agent-infra-browser__browser_interact",
				"mcp__agent-infra-browser__browser_navigate",
				"mcp__agent-infra-browser__browser_observe",
				"mcp__agent-infra-browser__write_report",
			]);
			throw new Error("verified SDK launch");
		});
	const { PiRuntimeDriver } = await import("./pi-runtime-driver.js");
	const factory = vi.spyOn(PiRuntimeDriver, "open");
	let current: typeof capability | undefined = capability;
	const runtime = await openPiRuntime({
		path: root,
		paseoSdk: true,
		configVersion: "c",
		defaultModelOptionId: "m",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "m",
				model: "test",
				reasoningLevels: ["high"],
				endpoint: "https://example.test",
				authentication: "api-key",
			},
		],
		authorizeModelAction: vi.fn(),
		authorizeToolAction: vi.fn(),
		browserCapability: () => current,
	});
	try {
		const open = factory.mock.calls[0]?.[0].openPaseoSession;
		if (!open) throw new Error("Pi SDK session factory missing");
		const session = {
			directory: root,
			cwd: join(root, "workspace"),
			runtimeSessionRef: "ref",
			executionId: "execution-1",
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "m",
				reasoningLevel: "high",
			},
			admit: vi.fn(),
			update: vi.fn(),
			recordOperationFact: vi.fn(),
			browser: {
				binding: {
					...browserConformanceBinding,
					imageDigest: capability.provenance.imageDigest,
				},
				capabilityVersion: capability.capabilityVersion,
				executeTool: vi.fn(),
			},
		};
		await expect(open(session)).rejects.toThrow("verified SDK launch");
		current = undefined;
		await expect(open(session)).rejects.toThrow(
			"RUNTIME_BROWSER_MCP_UNAVAILABLE",
		);
		expect(launch).toHaveBeenCalledOnce();
	} finally {
		await runtime.close();
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	}
});
