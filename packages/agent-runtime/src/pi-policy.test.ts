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
