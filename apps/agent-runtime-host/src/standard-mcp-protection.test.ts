import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fs: vi.fn(), process: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: mocks.fs }));
vi.mock("./process-protection.js", () => ({
	assertRuntimeProcessProtection: mocks.process,
}));

import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
	if (originalPlatform)
		Object.defineProperty(process, "platform", originalPlatform);
	vi.restoreAllMocks();
	mocks.fs.mockReset();
	mocks.process.mockReset();
});

function fixture(scope = "2", patch = "") {
	Object.defineProperty(process, "platform", {
		value: "linux",
		configurable: true,
	});
	vi.spyOn(process, "getuid").mockReturnValue(1000);
	vi.spyOn(process, "geteuid").mockReturnValue(1000);
	const status =
		"NoNewPrivs:\t1\nCapInh:\t00000000\nCapPrm:\t00000000\nCapEff:\t00000000\nCapAmb:\t00000000\n";
	mocks.fs.mockImplementation((path: string) =>
		path.endsWith("ptrace_scope") ? scope : patch || status,
	);
}

it("requires concrete kernel and process assertions independently of deployment env", () => {
	fixture();
	expect(() => assertStandardMcpProcessProtection()).not.toThrow();
	expect(mocks.process).toHaveBeenCalledOnce();
	expect(mocks.fs).toHaveBeenCalledWith(
		"/proc/sys/kernel/yama/ptrace_scope",
		"utf8",
	);
});

it.each(["0", "1", "", "3\n2", "environment-approved"])(
	"rejects unavailable attach protection %j",
	(scope) => {
		fixture(scope);
		expect(() => assertStandardMcpProcessProtection()).toThrow(
			"protection is unavailable",
		);
	},
);

it.each(["NoNewPrivs", "CapInh", "CapPrm", "CapEff", "CapAmb"])(
	"rejects a privileged %s process",
	(field) => {
		fixture();
		const status =
			"NoNewPrivs:\t1\nCapInh:\t00000000\nCapPrm:\t00000000\nCapEff:\t00000000\nCapAmb:\t00000000\n";
		fixture(
			"2",
			status.replace(
				new RegExp(`${field}:\\s+[^\\n]+`),
				`${field}:\t${field === "NoNewPrivs" ? "0" : "00000001"}`,
			),
		);
		expect(() => assertStandardMcpProcessProtection()).toThrow(
			"protection is unavailable",
		);
	},
);

it("denies root and does not treat another OS as an equivalent protected profile", () => {
	fixture();
	vi.spyOn(process, "geteuid").mockReturnValue(0);
	expect(() => assertStandardMcpProcessProtection()).toThrow(
		"protection is unavailable",
	);
	Object.defineProperty(process, "platform", {
		value: "darwin",
		configurable: true,
	});
	expect(() => assertStandardMcpProcessProtection()).toThrow(
		"protection is unavailable",
	);
});
