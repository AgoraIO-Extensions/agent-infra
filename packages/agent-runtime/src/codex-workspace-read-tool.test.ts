import {
	link,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readCodexWorkspaceTextFile } from "./codex-workspace-read-tool.js";

const directories: string[] = [];
async function fixture() {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "codex-workspace-read-")),
	);
	directories.push(directory);
	const root = join(directory, "workspace");
	await mkdir(root, { mode: 0o700 });
	await writeFile(join(root, "proof.txt"), "controlled workspace text\n");
	return { directory, root };
}
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

it("reads only the named ordinary UTF-8 file inside the owned workspace", async () => {
	const { root } = await fixture();
	await expect(
		readCodexWorkspaceTextFile(root, "proof.txt", new AbortController().signal),
	).resolves.toEqual({
		path: "proof.txt",
		text: "controlled workspace text\n",
		bytesRead: 26,
		truncated: false,
	});
});

it("bounds an oversized text read and reports the unobserved remainder", async () => {
	const { root } = await fixture();
	await writeFile(join(root, "long.txt"), "x".repeat(5000));
	const value = await readCodexWorkspaceTextFile(
		root,
		"long.txt",
		new AbortController().signal,
	);
	expect(value.text).toBe("x".repeat(4096));
	expect(value.bytesRead).toBe(4096);
	expect(value.truncated).toBe(true);
});

it.each([
	"",
	"../proof.txt",
	"sub/../proof.txt",
	"/etc/passwd",
	"C:/secret.txt",
	"file:///etc/passwd",
	"sub\\proof.txt",
	"./proof.txt",
	"sub//proof.txt",
	"proof.txt\0",
])("rejects unsafe relative input %j", async (path) => {
	const { root } = await fixture();
	await expect(
		readCodexWorkspaceTextFile(root, path, new AbortController().signal),
	).rejects.toThrow("WORKSPACE_FILE_UNAVAILABLE");
});

it("rejects links even when their target is inside the same workspace", async () => {
	const { root } = await fixture();
	await symlink(join(root, "proof.txt"), join(root, "alias.txt"));
	await link(join(root, "proof.txt"), join(root, "hardlink.txt"));
	for (const path of ["alias.txt", "hardlink.txt"])
		await expect(
			readCodexWorkspaceTextFile(root, path, new AbortController().signal),
		).rejects.toThrow("WORKSPACE_FILE_UNAVAILABLE");
});

it("rejects sibling workspaces through a linked directory or linked root", async () => {
	const { directory, root } = await fixture();
	const sibling = join(directory, "other-conversation");
	await mkdir(sibling);
	await writeFile(
		join(sibling, "private.txt"),
		"other subject's controlled fixture",
	);
	await symlink(sibling, join(root, "other"));
	await symlink(root, join(directory, "alias-root"));
	await expect(
		readCodexWorkspaceTextFile(
			root,
			"other/private.txt",
			new AbortController().signal,
		),
	).rejects.toThrow("WORKSPACE_FILE_UNAVAILABLE");
	await expect(
		readCodexWorkspaceTextFile(
			join(directory, "alias-root"),
			"proof.txt",
			new AbortController().signal,
		),
	).rejects.toThrow("WORKSPACE_FILE_UNAVAILABLE");
});

it("rejects directories, missing files, invalid UTF-8 and aborted reads", async () => {
	const { root } = await fixture();
	await mkdir(join(root, "folder"));
	await writeFile(join(root, "binary.txt"), Buffer.from([0xff, 0xfe]));
	for (const path of ["folder", "missing.txt", "binary.txt"])
		await expect(
			readCodexWorkspaceTextFile(root, path, new AbortController().signal),
		).rejects.toThrow("WORKSPACE_FILE_UNAVAILABLE");
	const aborted = new AbortController();
	aborted.abort();
	await expect(
		readCodexWorkspaceTextFile(root, "proof.txt", aborted.signal),
	).rejects.toThrow();
});
