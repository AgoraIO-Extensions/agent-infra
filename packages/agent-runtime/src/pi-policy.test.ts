import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
	createPiWorkspaceTools,
	piBrowserMcpConfiguration,
	piConnectionMcpConfiguration,
} from "./pi-policy.js";

it("accepts only a Host-owned loopback MCP bridge configuration", () => {
	const value = piConnectionMcpConfiguration({
		AGENT_INFRA_PI_CONNECTION_MCP_URL: "http://127.0.0.1:4321/mcp",
		AGENT_INFRA_PI_CONNECTION_MCP_TOKEN: "synthetic-loopback-token",
	});
	expect(value).toEqual({
		url: "http://127.0.0.1:4321/mcp",
		headers: { Authorization: "Bearer synthetic-loopback-token" },
		exposure: "direct",
	});
	for (const environment of [
		{
			AGENT_INFRA_PI_CONNECTION_MCP_URL: "https://connection.invalid/mcp",
			AGENT_INFRA_PI_CONNECTION_MCP_TOKEN: "synthetic-loopback-token",
		},
		{
			AGENT_INFRA_PI_CONNECTION_MCP_URL: "http://127.0.0.1:4321/mcp",
			AGENT_INFRA_PI_CONNECTION_MCP_TOKEN: "short",
		},
	])
		expect(() => piConnectionMcpConfiguration(environment)).toThrow();
});

it("accepts only a Host-owned loopback Browser MCP bridge configuration", () => {
	const value = piBrowserMcpConfiguration({
		AGENT_INFRA_PI_BROWSER_MCP_URL: "http://127.0.0.1:4322/mcp",
		AGENT_INFRA_PI_BROWSER_MCP_TOKEN: "synthetic-browser-token",
	});
	expect(value).toEqual({
		url: "http://127.0.0.1:4322/mcp",
		headers: { Authorization: "Bearer synthetic-browser-token" },
		exposure: "direct",
	});
	for (const environment of [
		{
			AGENT_INFRA_PI_BROWSER_MCP_URL: "https://browser.invalid/mcp",
			AGENT_INFRA_PI_BROWSER_MCP_TOKEN: "synthetic-browser-token",
		},
		{
			AGENT_INFRA_PI_BROWSER_MCP_URL: "http://127.0.0.1:4322/mcp",
			AGENT_INFRA_PI_BROWSER_MCP_TOKEN: "short",
		},
	])
		expect(() => piBrowserMcpConfiguration(environment)).toThrow();
});

it.each(["read", "write", "edit"] as const)(
	"guards the real Pi %s operation after path transformations",
	async (name) => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "pi-path-policy-")),
		);
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const foreign = join(root, "foreign.txt");
		const canary = "prefix SYNTHETIC_FOREIGN_CANARY";
		await writeFile(foreign, canary);
		const tool = createPiWorkspaceTools(workspace)[name];
		const execute = (path: string) =>
			tool.execute(
				"synthetic-tool-call",
				{
					path,
					content: "replacement",
					edits: [{ oldText: "prefix", newText: "changed" }],
				},
				undefined,
				undefined,
				{
					cwd: workspace,
					tools: [],
					executeTool: async () => ({ isError: true, content: [] }),
				} as unknown as ExtensionToolContext,
			);
		try {
			const owner = join(workspace, "owner.txt");
			await writeFile(owner, "prefix SYNTHETIC_OWNER_CANARY");
			await expect(execute("owner.txt")).resolves.toHaveProperty("content");
			await symlink(foreign, join(workspace, "escape.txt"));
			await symlink(foreign, join(workspace, "Capture d’écran.txt"));
			await symlink(foreign, join(workspace, "capture\u202fPM.txt"));
			await symlink(foreign, join(workspace, "e\u0301.txt"));
			const attempts = [
				foreign,
				`@${foreign}`,
				pathToFileURL(foreign).href,
				`~/${relative(homedir(), foreign)}`,
				"escape.txt",
			];
			if (name === "read")
				attempts.push("Capture d'écran.txt", "capture PM.txt", "é.txt");
			for (const path of attempts) {
				await expect(execute(path)).rejects.toThrow();
				expect(await readFile(foreign, "utf8")).toBe(canary);
			}
			// Owner access must still work after all rejections.
			await writeFile(owner, "prefix SYNTHETIC_OWNER_CANARY");
			await expect(execute("owner.txt")).resolves.toHaveProperty("content");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

it("reports Pi file dispatch after authorization and before filesystem I/O", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-dispatch-")));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const events: { operation: string; path: string; existed: boolean }[] = [];
	const tools = createPiWorkspaceTools(workspace, {
		onFileDispatch: async (event) => {
			let existed = true;
			try {
				await stat(event.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				existed = false;
			}
			events.push({ ...event, existed });
		},
	});
	try {
		await tools.write.execute(
			"synthetic-dispatch",
			{ path: "created.txt", content: "dispatch" },
			undefined,
			undefined,
			{
				cwd: workspace,
				tools: [],
				executeTool: async () => ({ isError: true, content: [] }),
			} as unknown as ExtensionToolContext,
		);
		expect(events.at(-1)).toEqual({
			operation: "write",
			path: join(workspace, "created.txt"),
			existed: false,
		});
		expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe(
			"dispatch",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// #3217：Pi 的 ls 与 find 只能列举本 Conversation 工作区，越界目录与符号链接被拒绝。
it.each(["ls", "find"] as const)(
	"confines the real Pi %s tool to the Conversation workspace",
	async (name) => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "pi-list-")));
		const workspace = join(root, "workspace");
		const foreign = join(root, "foreign");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(foreign);
		await writeFile(join(workspace, "src", "owner-note.txt"), "owner");
		await writeFile(join(foreign, "foreign-note.txt"), "foreign");
		await symlink(foreign, join(workspace, "escape"));
		const tool = createPiWorkspaceTools(workspace)[name];
		const execute = (input: Record<string, unknown>) =>
			tool.execute(
				"synthetic-tool-call",
				input as never,
				undefined,
				undefined,
				{
					cwd: workspace,
					tools: [],
					executeTool: async () => ({ isError: true, content: [] }),
				} as unknown as ExtensionToolContext,
			);
		const text = (result: { content: { type: string; text?: string }[] }) =>
			result.content.map((part) => part.text ?? "").join("\n");
		try {
			const owner = await execute(
				name === "ls" ? { path: "src" } : { pattern: "**/*.txt" },
			);
			expect(text(owner)).toContain("owner-note.txt");
			expect(text(owner)).not.toContain("foreign-note.txt");
			const attempts =
				name === "ls"
					? [
							{ path: foreign },
							{ path: ".." },
							{ path: "escape" },
							{ path: root },
						]
					: [
							{ pattern: "*", path: foreign },
							{ pattern: "*", path: ".." },
							{ pattern: "*", path: "escape" },
							{ pattern: `${foreign}/*` },
							{ pattern: "../foreign/*" },
						];
			for (const input of attempts) {
				const result = await execute(input).catch((error: Error) => ({
					content: [{ type: "text", text: `rejected ${error.message}` }],
				}));
				expect(text(result)).not.toContain("foreign-note.txt");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

// #3217：Pi 的 grep 只在本 Conversation 工作区内搜索（需要 ripgrep）。
it.skipIf(
	!process.env.PATH?.split(":").some((dir) => existsSync(join(dir, "rg"))),
)("confines the real Pi grep tool to the Conversation workspace", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-grep-")));
	const workspace = join(root, "workspace");
	const foreign = join(root, "foreign");
	await mkdir(join(workspace, "src"), { recursive: true });
	await mkdir(foreign);
	await writeFile(
		join(workspace, "src", "owner.txt"),
		"SYNTHETIC_OWNER_CANARY",
	);
	await writeFile(join(foreign, "foreign.txt"), "SYNTHETIC_FOREIGN_CANARY");
	await symlink(foreign, join(workspace, "escape"));
	const tool = createPiWorkspaceTools(workspace).grep;
	const execute = (input: Record<string, unknown>) =>
		tool.execute("synthetic-tool-call", input as never, undefined, undefined, {
			cwd: workspace,
			tools: [],
			executeTool: async () => ({ isError: true, content: [] }),
		} as unknown as ExtensionToolContext);
	const text = (result: { content: { type: string; text?: string }[] }) =>
		result.content.map((part) => part.text ?? "").join("\n");
	try {
		expect(text(await execute({ pattern: "SYNTHETIC_" }))).toContain(
			"SYNTHETIC_OWNER_CANARY",
		);
		expect(text(await execute({ pattern: "SYNTHETIC_" }))).not.toContain(
			"SYNTHETIC_FOREIGN_CANARY",
		);
		for (const path of [foreign, "..", "escape", root])
			await expect(execute({ pattern: "SYNTHETIC_", path })).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
