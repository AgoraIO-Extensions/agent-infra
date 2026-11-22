import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fs: vi.fn(),
	process: vi.fn(),
	stat: vi.fn(),
	dumpable: vi.fn(),
	scope: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	readFileSync: mocks.fs,
	statSync: mocks.stat,
}));
vi.mock("./credential-holder-protection.js", () => ({
	readProcessDumpableV1: mocks.dumpable,
	credentialHolderSessionScopeV1: mocks.scope,
}));
vi.mock("./process-protection.js", () => ({
	assertRuntimeProcessProtection: mocks.process,
}));

import {
	assertStandardMcpOriginalSessionV1,
	assertStandardMcpProcessProtection,
} from "./standard-mcp-protection.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
	if (originalPlatform)
		Object.defineProperty(process, "platform", originalPlatform);
	vi.restoreAllMocks();
	mocks.fs.mockReset();
	mocks.process.mockReset();
	mocks.stat.mockReset();
	mocks.dumpable.mockReset();
	mocks.scope.mockReset();
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

const STATUS =
	"Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nNoNewPrivs:\t1\nCapInh:\t00000000\nCapPrm:\t00000000\nCapEff:\t00000000\nCapAmb:\t00000000\n";
const SCOPE = {
	kind: "container-boundary",
	scope: "agent-1:session-1",
} as const;

/** Linux without Yama: only the non-dumpable choice can hold. */
function nonDumpable(
	patch: {
		status?: string;
		suid?: string;
		uidMap?: string;
		dumpable?: number | undefined;
		scope?: unknown;
		fdOwner?: number;
	} = {},
) {
	Object.defineProperty(process, "platform", {
		value: "linux",
		configurable: true,
	});
	vi.spyOn(process, "getuid").mockReturnValue(1000);
	vi.spyOn(process, "geteuid").mockReturnValue(1000);
	mocks.fs.mockImplementation((path: string) => {
		if (path.endsWith("ptrace_scope")) throw new Error("ENOENT");
		if (path.endsWith("suid_dumpable")) return patch.suid ?? "2\n";
		if (path.endsWith("uid_map"))
			return patch.uidMap ?? "         0          0 4294967295\n";
		return patch.status ?? STATUS;
	});
	mocks.stat.mockReturnValue({ uid: patch.fdOwner ?? 0 });
	mocks.dumpable.mockReturnValue("dumpable" in patch ? patch.dumpable : 0);
	mocks.scope.mockReturnValue("scope" in patch ? patch.scope : SCOPE);
}

describe("non-dumpable choice without Yama", () => {
	it("accepts only a verified Session scope with every premise met", () => {
		nonDumpable();
		expect(() => assertStandardMcpProcessProtection()).not.toThrow();
	});

	it("does not need the non-dumpable state when Yama 2 already holds", () => {
		fixture("2");
		mocks.dumpable.mockReturnValue(1);
		mocks.scope.mockReturnValue(undefined);
		expect(() => assertStandardMcpProcessProtection()).not.toThrow();
		expect(mocks.dumpable).not.toHaveBeenCalled();
	});

	it.each([
		["no verified Session scope", { scope: undefined }],
		["a still-dumpable process", { dumpable: 1 }],
		["an unreadable dumpable state", { dumpable: undefined }],
		["fs.suid_dumpable=1", { suid: "1\n" }],
		[
			"a changed effective uid",
			{ status: STATUS.replace("Uid:\t1000\t1000", "Uid:\t1000\t1001") },
		],
		[
			"a changed saved gid",
			{
				status: STATUS.replace(
					"Gid:\t1000\t1000\t1000\t1000",
					"Gid:\t1000\t1000\t1002\t1000",
				),
			},
		],
		["a user namespace", { uidMap: "0 1000 1\n" }],
		["an owner-readable /proc/self/fd", { fdOwner: 1000 }],
		[
			"a privileged process",
			{ status: STATUS.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0") },
		],
	])("fails closed for %s", (_name, patch) => {
		nonDumpable(patch as Parameters<typeof nonDumpable>[0]);
		expect(() => assertStandardMcpProcessProtection()).toThrow(
			"protection is unavailable",
		);
	});

	it("fails closed when a premise cannot be read", () => {
		nonDumpable();
		mocks.fs.mockImplementation((path: string) => {
			if (path.endsWith("ptrace_scope") || path.endsWith("uid_map"))
				throw new Error("EACCES");
			return STATUS;
		});
		expect(() => assertStandardMcpProcessProtection()).toThrow(
			"protection is unavailable",
		);
	});
});

describe("original Execution Session", () => {
	const original = {
		agentId: "agent-1",
		conversationId: "session-1",
		sessionGeneration: 3,
	};

	it("admits the attested Session and rejects another Session or an Agent-level scope", () => {
		nonDumpable();
		expect(() => assertStandardMcpOriginalSessionV1(original)).not.toThrow();
		expect(() =>
			assertStandardMcpOriginalSessionV1({
				...original,
				conversationId: "session-2",
			}),
		).toThrow("protection is unavailable");
		nonDumpable({ scope: { kind: "container-boundary", scope: "agent-1" } });
		expect(() => assertStandardMcpOriginalSessionV1(original)).toThrow(
			"protection is unavailable",
		);
		nonDumpable({ scope: { kind: "provisioning-init" } });
		expect(() => assertStandardMcpOriginalSessionV1(original)).toThrow(
			"protection is unavailable",
		);
	});

	it("binds a session-executor scope to Agent, Session and generation", () => {
		const scope = { kind: "session-executor", ...original } as const;
		nonDumpable({ scope });
		expect(() => assertStandardMcpOriginalSessionV1(original)).not.toThrow();
		for (const other of [
			{ agentId: "agent-2" },
			{ conversationId: "session-2" },
			{ sessionGeneration: 4 },
		])
			expect(() =>
				assertStandardMcpOriginalSessionV1({ ...original, ...other }),
			).toThrow("protection is unavailable");
	});

	it("does not constrain the Session when Yama protects the process", () => {
		fixture("3");
		expect(() =>
			assertStandardMcpOriginalSessionV1({
				...original,
				conversationId: "anything",
			}),
		).not.toThrow();
	});
});
