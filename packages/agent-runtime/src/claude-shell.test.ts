import { afterEach, expect, it, vi } from "vitest";
import {
	claudeShellAvailable,
	claudeShellEnvironment,
} from "./claude-shell.js";

const io = vi.hoisted(() => ({
	stat: vi.fn(),
	realpath: vi.fn(),
	access: vi.fn(),
	readFile: vi.fn(),
	execFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => io);
vi.mock("node:child_process", () => ({ execFile: io.execFile }));
afterEach(() => {
	vi.restoreAllMocks();
	vi.resetAllMocks();
});

function installed() {
	vi.spyOn(process, "platform", "get").mockReturnValue("linux");
	io.stat.mockResolvedValue({ isFile: () => true, mode: 0o555 });
	io.realpath.mockImplementation(async (path) => path);
	io.access.mockRejectedValue(
		Object.assign(new Error("readonly"), { code: "EACCES" }),
	);
	io.readFile.mockResolvedValue(Buffer.from("fixed-launcher"));
	io.execFile.mockImplementation((_path, _args, _options, callback) =>
		callback(null, "", ""),
	);
}

it("binds the exact native shell alias and workspace after actual command admission", async () => {
	installed();
	expect(await claudeShellAvailable("/session/workspace")).toBe(true);
	expect(io.execFile.mock.calls[0]?.slice(0, 2)).toEqual([
		"/opt/agent-infra/native-bash.mjs",
		["-c", "-l", "true"],
	]);
	expect(claudeShellEnvironment("/session/workspace")).toEqual({
		CLAUDE_CODE_SHELL: "/opt/agent-infra/native-bash.mjs",
		AGENT_INFRA_NATIVE_SHELL_WORKSPACE: "/session/workspace",
		TMPDIR: "/session/workspace",
	});
});
it.each(["missing", "writable", "symlink", "changed", "abi"])(
	"denies Bash when the fixed entry is %s",
	async (failure) => {
		installed();
		if (failure === "missing") io.stat.mockRejectedValue(new Error("ENOENT"));
		if (failure === "writable") io.access.mockResolvedValue(undefined);
		if (failure === "symlink")
			io.realpath.mockResolvedValue("/workspace/override");
		if (failure === "changed")
			io.readFile.mockResolvedValueOnce(Buffer.from("changed"));
		if (failure === "abi")
			io.execFile.mockImplementation((_path, _args, _options, callback) =>
				callback(new Error("failed")),
			);
		expect(await claudeShellAvailable("/session/workspace")).toBe(false);
		if (failure !== "abi") expect(io.execFile).not.toHaveBeenCalled();
	},
);
