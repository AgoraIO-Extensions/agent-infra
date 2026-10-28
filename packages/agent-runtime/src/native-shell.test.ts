import { expect, it } from "vitest";
import { nativeShellEnvironment, nativeShellPlan } from "./native-shell.js";

it("creates an explicit tool environment without native credentials or startup hooks", () => {
	expect(nativeShellEnvironment("/isolated/workspace")).toEqual({
		PATH: "/usr/local/bin:/usr/bin:/bin",
		HOME: "/isolated/workspace",
		TMPDIR: "/isolated/workspace",
		LANG: "C.UTF-8",
	});
});

it.each([
	["relative/workspace", "/tmp", ["-c", "true"]],
	["/tmp/workspace/..", "/tmp", ["-c", "true"]],
	["/tmp/foreign", "/tmp", ["-c", "true"]],
])(
	"rejects an untrusted workspace before launching a tool %#",
	async (workspace, cwd, args) => {
		await expect(nativeShellPlan(workspace, cwd, args)).rejects.toThrow();
	},
);
