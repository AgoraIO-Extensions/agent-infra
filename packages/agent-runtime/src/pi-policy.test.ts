import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createPiWorkspaceTools } from "./pi-policy.js";

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
				{ cwd: workspace } as ExtensionContext,
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
