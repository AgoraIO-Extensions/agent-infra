import {
	appendFile,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer, text } from "node:stream/consumers";
import { afterEach, expect, it, vi } from "vitest";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { fetchPiSkillFolders } from "./paseo-pod.js";
import {
	openPiDeploymentSkills,
	piSessionSkillReader,
} from "./pi-deployment-skills.js";
import { PiRuntimeDriver } from "./pi-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

const roots: string[] = [];
const sessionBinding = {
	scope: "agent-a:conversation-a",
	execution: {
		agentId: "agent-a",
		conversationId: "conversation-a",
		executionId: "execution-a",
		sessionGeneration: 1,
	},
};
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function view() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "pi-skill-view-")));
	roots.push(base);
	const root = join(base, "files");
	const add = async (folder: string, name = folder) => {
		const folderPath = join(root, ".agents", "skills", folder);
		await mkdir(folderPath, { recursive: true });
		const entry = join(folderPath, "SKILL.md");
		await writeFile(
			entry,
			`---\nname: ${name}\ndescription: Test Skill.\n---\nSynthetic.`,
		);
		return entry;
	};
	await writeFile(join(base, "sha256"), "b".repeat(64));
	return { root, add };
}

it("rejects an ambiguous native name while keeping other Agent Skills usable", async () => {
	const local = await view();
	const regular = await local.add("unique");
	const overlapping = await local.add("local-alias", "previously-installed");
	const hub: RuntimeFilesystemSkillDirectoryV1 = {
		generationId: "f".repeat(64),
		findSkills: () => [
			{
				schemaVersion: 1,
				name: "previously-installed",
				version: "1.0.0",
				manifestDigest: "b".repeat(64),
				packageDigest: "c".repeat(64),
				targetPath: ".agents/skills/previously-installed",
				readOnly: true,
			},
		],
		readSkill: vi.fn(),
	};
	const directory = await openPiDeploymentSkills({
		...sessionBinding,
		hub,
		root: local.root,
	});
	expect(directory.folders).toEqual(["unique"]);
	await expect(directory.read(overlapping)).rejects.toThrow(
		"RUNTIME_SKILL_SOURCE_CONFLICT",
	);
	expect(() => directory.assertUnambiguous("previously-installed")).toThrow(
		"RUNTIME_SKILL_SOURCE_CONFLICT",
	);
	expect(await text(await directory.read(regular))).toContain("Synthetic.");
});

it("reads resources of this immutable Session Skill and rejects sibling Agents, links, and changed entries", async () => {
	const local = await view();
	const entry = await local.add("weekly-report");
	const other = await view();
	const foreign = await other.add("weekly-report");
	const resource = join(
		local.root,
		".agents",
		"skills",
		"weekly-report",
		"format.md",
	);
	await writeFile(resource, "Synthetic report format");
	await symlink(foreign, `${resource}.link`);
	const directory = await openPiDeploymentSkills({
		...sessionBinding,
		root: local.root,
	});
	expect(await text(await directory.read(resource))).toBe(
		"Synthetic report format",
	);
	await expect(directory.read(foreign)).rejects.toThrow();
	await expect(directory.read(`${resource}.link`)).rejects.toThrow();
	await expect(
		directory.read(entry.replace("weekly-report/", "weekly-report/../../")),
	).rejects.toThrow();
	await writeFile(entry, "Changed after binding.");
	await expect(directory.read(entry)).rejects.toThrow();
});

it.each(["agent-b:conversation-a", "agent-a:conversation-b"])(
	"rejects a foreign attested Session scope %s before discovery",
	async (scope) => {
		const local = await view();
		await local.add("weekly-report");
		await expect(
			openPiDeploymentSkills({ ...sessionBinding, scope, root: local.root }),
		).rejects.toThrow("RUNTIME_AUTHORIZATION_DENIED");
	},
);

it("denies a revoked read before releasing bytes and records its failed operation", async () => {
	const local = await view();
	const path = await local.add("weekly-report");
	const directory = await openPiDeploymentSkills({
		...sessionBinding,
		root: local.root,
	});
	const session = {
		runtimeSessionRef: "native-a",
		executionId: "execution-a",
		recordOperationFact: vi.fn(),
		update: vi.fn(),
	};
	const revalidate = vi
		.fn()
		.mockImplementationOnce(() => {})
		.mockImplementation(() => {
			throw new Error("revoked");
		});
	const read = piSessionSkillReader(directory, session, async () => ({
		revalidate,
	}));
	await expect(read(path, vi.fn())).rejects.toThrow(
		"RUNTIME_AUTHORIZATION_DENIED",
	);
	expect(
		session.recordOperationFact.mock.calls.map(([fact]) => fact.phase),
	).toEqual(["intent", "started", "failed"]);
	expect(session.update).not.toHaveBeenCalled();
});

it("cannot fulfill a previously selected Hub Skill from a same-name Agent Skill", async () => {
	const local = await view();
	await local.add("weekly-report");
	const directory = await openPiDeploymentSkills({
		...sessionBinding,
		root: local.root,
	});
	expect(directory.folders).toEqual(["weekly-report"]);
	const driver = await PiRuntimeDriver.open({
		path: join(local.root, "driver"),
		configVersion: "config-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "configured/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({ command: process.execPath, args: [], env: {} }),
	});
	try {
		expect(() =>
			driver.resolveNativeSkillBinding({
				nativeSessionRef: "native-a",
				capabilityName: "weekly-report",
				capabilitySourceVersion: "1.0.0",
				directoryRevision: "previous-hub",
			}),
		).toThrow(
			expect.objectContaining({
				code: "RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
			}),
		);
		expect((await driver.getCapabilities()).skills ?? []).toEqual([]);
	} finally {
		await driver.close();
	}
});

it("keeps valid Pi Skills among ordinary and hidden files and preserves native names and large resources", async () => {
	const local = await view();
	const name = "r".repeat(64);
	const entry = await local.add(name);
	const base = join(local.root, ".agents", "skills");
	await Promise.all(
		Array.from({ length: 151 }, (_, i) =>
			writeFile(join(base, i % 2 ? `.note-${i}` : `note-${i}`), "ordinary"),
		),
	);
	await Promise.all(
		Array.from({ length: 151 }, (_, i) => local.add(`report-${i}`)),
	);
	const format = join(base, name, "format.md");
	const bytes = Buffer.alloc(1_048_577, 0x41);
	await appendFile(entry, bytes);
	await writeFile(format, bytes);
	await local.add(".hidden", "hidden");
	await local.add("node_modules", "ignored");
	const directory = await openPiDeploymentSkills({
		...sessionBinding,
		root: local.root,
	});
	expect(directory.folders).toHaveLength(152);
	expect(directory.folders).toContain(name);
	expect(await text(await directory.read(entry))).toContain(name);
	expect((await buffer(await directory.read(format))).equals(bytes)).toBe(true);
	const session = {
		runtimeSessionRef: "native-a",
		executionId: "execution-a",
		recordOperationFact: vi.fn(),
		update: vi.fn(),
	};
	let current = true;
	const read = piSessionSkillReader(directory, session, async () => ({
		revalidate() {
			if (!current) throw Error("revoked");
		},
	}));
	const received = vi.fn(async () => {
		current = false;
	});
	await expect(read(format, received)).rejects.toThrow(
		"RUNTIME_AUTHORIZATION_DENIED",
	);
	expect(received).toHaveBeenCalledOnce();
	expect(session.recordOperationFact.mock.lastCall?.[0].phase).toBe("failed");
});

it("accepts only this Session's loopback token for Skill reads and forbids other model tools", async () => {
	const readPiSkill = vi.fn(
		async (_path: string, send: (chunk: Buffer) => Promise<void>) =>
			send(Buffer.from("Synthetic resource")),
	);
	const upstream = vi.fn<typeof fetch>();
	const transport = await openRuntimeMessagesTransport({
		client: "pi",
		endpoint: "https://model.example.test",
		credential: "synthetic-test-only-credential",
		authentication: "bearer",
		model: "test-weekly",
		effort: "high",
		admit: async () => {},
		piSkills: { folders: ["weekly-report"], read: readPiSkill },
		fetch: upstream,
	});
	const { endpoint, credential } = transport.modelAccess;
	const post = (route: string, token: string, body: string) =>
		fetch(endpoint + route, {
			method: "POST",
			headers: { "x-api-key": token },
			body,
		});
	try {
		await expect(
			fetchPiSkillFolders(endpoint, "foreign-token"),
		).rejects.toThrow();
		expect(await fetchPiSkillFolders(endpoint, credential)).toEqual([
			"weekly-report",
		]);
		expect(
			(await post("/pi/skill-read", "foreign-token", "synthetic")).ok,
		).toBe(false);
		expect(
			(await post("/pi/skill-read", credential, "x".repeat(4096))).ok,
		).toBe(false);
		expect(readPiSkill).not.toHaveBeenCalled();
		expect(
			await (await post("/pi/skill-read", credential, "synthetic")).text(),
		).toBe("Synthetic resource");
		const model = await post(
			"/v1/messages",
			credential,
			JSON.stringify({ model: "test-weekly", tools: [{ name: "bash" }] }),
		);
		expect(model.ok).toBe(false);
		expect(upstream).not.toHaveBeenCalled();
	} finally {
		await transport.close();
	}
});
