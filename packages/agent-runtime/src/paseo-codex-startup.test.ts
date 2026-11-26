import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as pod from "./paseo-pod.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
it.each([
	"managed_config.toml",
	"hooks.json",
	"auth.json",
	"workspace/.codex",
	"linked-config",
])(
	"rejects persisted SDK trial startup input %s before provider launch",
	async (entry) => {
		const root = await mkdtemp(join(tmpdir(), "codex-trial-startup-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		await mkdir(cwd);
		if (entry === "linked-config")
			await symlink("absent", join(root, "config.toml"));
		else await writeFile(join(root, entry), "synthetic");
		await expect(pod.assertTextOnlyCodexStartup(root, cwd)).rejects.toThrow(
			"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
		);
	},
);
