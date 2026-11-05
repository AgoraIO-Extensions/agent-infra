import { describe, expect, it } from "vitest";
import { workspaceSnapshotMountRoots } from "./workspace-snapshot-path.js";

const mount = (path: string, options = "ro,relatime") =>
	`42 1 0:41 / ${path} ${options} - tmpfs tmpfs rw`;

describe("workspace snapshot mount authority", () => {
	it("uses the mount's read-only flag, even when the backing filesystem is writable", () => {
		expect(
			workspaceSnapshotMountRoots(mount("/opt/agent/workspaces/repo")),
		).toEqual(["/opt/agent/workspaces/repo"]);
	});
	it.each([
		mount("/opt/agent/workspaces/repo", "rw"),
		mount("/workspace/repo"),
		mount("/opt/agent/workspaces/repo/child"),
		mount("/opt/agent/workspaces/../secret"),
		mount("/opt/agent/workspaces/repo") +
			"\n" +
			mount("/opt/agent/workspaces/repo/child", "rw"),
		mount("/opt/agent/workspaces/repo") +
			"\n" +
			mount("/opt/agent/workspaces/repo"),
	])("rejects an untrusted or ambiguous mount tree", (input) => {
		expect(workspaceSnapshotMountRoots(input)).toEqual([]);
	});
});
