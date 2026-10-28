import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	openCodeFetchAllowed,
	openCodePatchAllowed,
	openCodeToolName,
} from "./opencode-tools.js";

it("uses only the pinned pending title and kind pair", () => {
	expect(openCodeToolName({ kind: "search", title: "glob" })).toBe("Glob");
	expect(openCodeToolName({ kind: "other", title: "todowrite" })).toBe(
		"TodoWrite",
	);
	expect(openCodeToolName({ kind: "edit", title: "apply_patch" })).toBe(
		"ApplyPatch",
	);
	expect(
		openCodeToolName({ kind: "execute", title: "webfetch" }),
	).toBeUndefined();
	expect(
		openCodeToolName({ kind: "search", title: "model supplied text" }),
	).toBeUndefined();
});
it("validates all patch destinations including move and symlink escapes", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-patch-")));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	await mkdir(join(root, "other"));
	await symlink(join(root, "other"), join(workspace, "escape"));
	try {
		for (const path of ["../other/target", "escape/target", "/etc/passwd"]) {
			expect(
				await openCodePatchAllowed(
					workspace,
					`*** Begin Patch\n*** Add File: ${path}\n+data\n*** End Patch`,
				),
			).toBe(false);
			expect(
				await openCodePatchAllowed(
					workspace,
					`*** Begin Patch\n*** Update File: own\n*** Move to: ${path}\n@@\n-old\n+new\n*** End Patch`,
				),
			).toBe(false);
		}
		expect(
			await openCodePatchAllowed(
				workspace,
				"*** Begin Patch\n*** Add File: own\n+data\n*** End Patch",
			),
		).toBe(true);
		expect(
			await openCodePatchAllowed(
				workspace,
				"*** Begin Patch\n*** Unknown: own\n*** End Patch",
			),
		).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it("permits only unauthenticated HTTP fetch input", () => {
	expect(openCodeFetchAllowed({ url: "https://fixture.invalid/page" })).toBe(
		true,
	);
	for (const url of [
		"file:///etc/passwd",
		"https://user:secret@fixture.invalid",
		"javascript:alert(1)",
	])
		expect(openCodeFetchAllowed({ url })).toBe(false);
});
