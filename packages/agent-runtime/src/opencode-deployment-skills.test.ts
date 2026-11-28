import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { afterEach, expect, it } from "vitest";
import {
	parseConversationOperationFactV2,
	requireConversationOperationSuccessorV2,
} from "../../platform-core/src/conversation-operation-facts.js";
import type { RuntimeExternalActionAuthorization } from "./driver.js";
import {
	openCodeDeploymentReadActions,
	openOpenCodeDeploymentSkills,
} from "./opencode-deployment-skills.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(
		join(await realpath(tmpdir()), "opencode-deployment-"),
	);
	roots.push(root);
	await mkdir(join(root, ".agents/skills"), { recursive: true });
	const receipt = join(root, ".agents/sha256");
	await writeFile(receipt, "a".repeat(64));
	const entry = async (folder: string, name = folder) => {
		const directory = join(root, ".agents/skills", folder);
		await mkdir(directory);
		const path = join(directory, "SKILL.md");
		await writeFile(
			path,
			`---\nname: ${name}\ndescription: Generate weekly progress\n---\nCREATOR_BODY\n`,
		);
		return path;
	};
	const open = (
		hub?: RuntimeFilesystemSkillDirectoryV1,
		sessionScope = "agent:session",
	) =>
		openOpenCodeDeploymentSkills({
			root,
			scope: "agent:session",
			sessionScope,
			hub,
		});
	return { root, receipt, entry, open };
}

it("discovers only trusted entry metadata and revalidates the exact Skill before each read", async () => {
	const { root, receipt, entry, open } = await fixture();
	const path = await entry("weekly-report");
	await writeFile(
		path,
		Buffer.concat([await readFile(path), Buffer.alloc(1024 * 1024 + 1, 32)]),
	);
	const directory = await open();
	expect(directory.entries).toEqual([
		{ name: "weekly-report", description: "Generate weekly progress", path },
	]);
	await expect(directory.verifyRead(path)).resolves.toBeUndefined();
	await expect(
		directory.verifyRead(join(root, ".agents/sha256")),
	).rejects.toThrow();
	await expect(directory.verifyRead(`${path}/../SKILL.md`)).rejects.toThrow();
	await expect(open(undefined, "another:session")).rejects.toThrow();
	const contents = await readFile(path);
	await writeFile(receipt, "b".repeat(64));
	await expect(directory.verifyRead(path)).rejects.toThrow();
	await writeFile(receipt, "a".repeat(64));
	await writeFile(path, "replacement");
	await expect(directory.verifyRead(path)).rejects.toThrow();
	await rm(path);
	await writeFile(join(root, "other"), contents);
	await symlink(join(root, "other"), path);
	await expect(directory.verifyRead(path)).rejects.toThrow();
});

it("retains distinct source collisions before folding names or applying any execution grant", async () => {
	const { entry, open } = await fixture();
	const bundled = await entry("bundled", "customize-opencode");
	const first = await entry("first", "weekly-report");
	await entry("second", "weekly-report");
	const installed = await entry("own", "installed");
	const hub = {
		findSkills: () => [{ name: "installed" }],
	} as unknown as RuntimeFilesystemSkillDirectoryV1;
	const directory = await open(hub);
	expect(directory.entries).toEqual([]);
	for (const [name, path] of [
		["customize-opencode", bundled],
		["weekly-report", first],
		["installed", installed],
	] as const) {
		expect(() => directory.assertUnambiguous(name)).toThrow(
			"RUNTIME_SKILL_SOURCE_CONFLICT",
		);
		await expect(directory.verifyRead(path)).rejects.toThrow(
			"RUNTIME_SKILL_SOURCE_CONFLICT",
		);
	}
});

it("authorizes each ACP read on the current original operation and retains uncertainty on a lost result", async () => {
	const { entry, open } = await fixture();
	const path = await entry("weekly-report");
	const directory = await open();
	const facts: RuntimeOperationFactV2[] = [];
	let executionId = "first";
	let ordinary = true;
	let authorized = true;
	const checks: RuntimeExternalActionAuthorization[] = [];
	const actions = openCodeDeploymentReadActions(
		directory,
		() => ({
			runtimeSessionRef: "native-session",
			executionId,
			ordinaryTurn: ordinary ? true : undefined,
			recordOperationFact: async (fact) => {
				facts.push(fact);
			},
		}),
		async (action) => {
			checks.push(action);
			return {
				revalidate() {
					if (!authorized) throw new Error("revoked");
				},
			};
		},
	);
	expect(actions.entriesForPrompt([{ name: "weekly-report" }])).toEqual([]);
	await expect(
		actions.allow("colliding", path, [{ name: "weekly-report" }]),
	).rejects.toThrow("RUNTIME_SKILL_SOURCE_CONFLICT");
	expect(actions.entriesForPrompt([])).toEqual(directory.entries);
	const verify = await actions.allow("call", path, []);
	if (!verify) throw new Error("expected original tool authorization");
	verify();
	expect(checks[0]).toMatchObject({
		nativeSessionRef: "native-session",
		executionId: "first",
		runtimeOperationId: "first",
		kind: "tool",
		toolId: "Read",
	});
	expect(facts.map((fact) => fact.phase)).toEqual(["intent", "started"]);
	expect(await actions.allow("call", path, [])).toBe(false);
	expect(checks).toHaveLength(1);
	await actions.finishTool("call", "completed");
	for (const [i, fact] of facts.entries())
		requireConversationOperationSuccessorV2(
			facts.slice(0, i).map(parseConversationOperationFactV2),
			parseConversationOperationFactV2(fact),
		);
	authorized = false;
	expect(verify).toThrow("revoked");
	expect(() => actions.revalidate()).toThrow("revoked");
	executionId = "second";
	actions.beginTurn();
	authorized = true;
	expect(verify).toThrow();
	ordinary = false;
	expect(actions.entriesForPrompt([])).toEqual([]);
	expect(await actions.allow("explicit-hub", path, [])).toBe(false);
	ordinary = true;
	expect(actions.entriesForPrompt([])).toEqual(directory.entries);
	expect(await actions.allow("call", path, [])).toBeTypeOf("function");
	await actions.finishTool("call", "unknown");
	expect(facts.at(-1)).toMatchObject({
		phase: "unknown",
		failureCode: "response_incomplete",
	});
	expect(checks[1]).toMatchObject({
		executionId: "second",
		runtimeOperationId: "second",
	});
	expect(checks[1]?.operationRef).not.toBe(checks[0]?.operationRef);
	actions.beginTurn();
	authorized = false;
	expect(await actions.allow("denied", path, [])).toBe(false);
	expect(facts.at(-1)).toMatchObject({ phase: "failed" });
	expect(facts.at(-1)).not.toHaveProperty("startedAt");
	for (const [i, fact] of facts.entries())
		requireConversationOperationSuccessorV2(
			facts.slice(0, i).map(parseConversationOperationFactV2),
			parseConversationOperationFactV2(fact),
		);
});
