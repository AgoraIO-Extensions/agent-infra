import { afterEach, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
	access: vi.fn(),
	lstat: vi.fn(),
	readFile: vi.fn(),
	realpath: vi.fn(),
}));
vi.mock("node:fs/promises", () => fs);

import { workspaceSnapshotReadRoots } from "./workspace-snapshot-path.js";

const root = "/opt/agent/workspaces";
const snapshot = `${root}/repo`;
const marker = `${snapshot}/.snapshot-digest`;
function fixture() {
	vi.spyOn(process, "platform", "get").mockReturnValue("linux");
	fs.access.mockRejectedValue(Object.assign(new Error(), { code: "EROFS" }));
	fs.realpath.mockImplementation(async (path: string) => path);
	fs.lstat.mockImplementation(async (path: string) => ({
		uid: 0,
		mode: 0o40755,
		isDirectory: () => path !== marker,
		isFile: () => path === marker,
		isSymbolicLink: () => false,
	}));
	fs.readFile.mockImplementation(async (path: string) =>
		path === "/proc/self/mountinfo"
			? `42 1 0:41 / ${snapshot} ro,relatime - tmpfs tmpfs rw`
			: `sha256:${"a".repeat(64)}`,
	);
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.resetAllMocks();
});
it("requires a verified read-only mount with a digest marker", async () => {
	fixture();
	expect(await workspaceSnapshotReadRoots()).toEqual([snapshot]);
});
it("rejects a writable parent even when its permission bits look trusted", async () => {
	fixture();
	fs.access.mockResolvedValue(undefined);
	expect(await workspaceSnapshotReadRoots()).toEqual([]);
});
it("rejects invalid digest markers", async () => {
	fixture();
	fs.readFile.mockImplementation(async (path: string) =>
		path === "/proc/self/mountinfo"
			? `42 1 0:41 / ${snapshot} ro - tmpfs tmpfs rw`
			: "unverified",
	);
	expect(await workspaceSnapshotReadRoots()).toEqual([]);
});
it("rejects snapshot symlink redirection", async () => {
	fixture();
	fs.realpath.mockImplementation(async (path: string) =>
		path === snapshot ? "/elsewhere" : path,
	);
	expect(await workspaceSnapshotReadRoots()).toEqual([]);
});
it("rejects symlinked digest markers", async () => {
	fixture();
	fs.lstat.mockImplementation(async (path: string) => ({
		uid: 0,
		mode: 0o40755,
		isDirectory: () => path !== marker,
		isFile: () => path === marker,
		isSymbolicLink: () => path === marker,
	}));
	expect(await workspaceSnapshotReadRoots()).toEqual([]);
});
