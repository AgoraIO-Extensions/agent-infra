import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { PathLike } from "node:fs";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	root: "",
	uid: 0,
	gid: 0,
	runtimeUid: 1000,
	writable: false,
	verify: vi.fn(),
}));
vi.mock("@agent-infra/agent-runtime", async (importOriginal) => ({
	...(await importOriginal<typeof import("@agent-infra/agent-runtime")>()),
	verifyCodexPilotInstallation: fixture.verify,
}));
vi.mock("node:process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:process")>()),
	getuid: () => fixture.runtimeUid,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const map = (path: PathLike) =>
		typeof path === "string" && (path === "/" || path.startsWith("/opt"))
			? `${fixture.root}${path === "/" ? "" : path}`
			: path;
	return {
		...actual,
		access: async (path: PathLike, mode?: number) => {
			if (fixture.writable) return;
			return actual.access(map(path), mode);
		},
		lstat: async (path: PathLike) =>
			Object.assign(await actual.lstat(map(path)), {
				uid: fixture.uid,
				gid: fixture.gid,
			}),
		open: async (path: PathLike, flags: number) => {
			const file = await actual.open(map(path), flags);
			const stat = file.stat.bind(file);
			Object.defineProperty(file, "stat", {
				value: async () =>
					Object.assign(await stat(), { uid: fixture.uid, gid: fixture.gid }),
			});
			return file;
		},
		readdir: (path: PathLike) => actual.readdir(map(path)),
		realpath: async (path: PathLike) => {
			const resolved = await actual.realpath(map(path));
			return resolved === fixture.root
				? "/"
				: resolved.startsWith(`${fixture.root}/`)
					? resolved.slice(fixture.root.length)
					: resolved;
		},
	};
});

import { readCodexInstalledSkillDeployment } from "./configuration.js";

const installedRoot = "/opt/codex/agent-infra-skills";
const manifestPath = `${installedRoot}/workspace-summary.manifest.json`;
const entryPath = `${installedRoot}/workspace-summary/SKILL.md`;
const buildPath = "/opt/codex/share/workspace-summary-build.json";
const sourceRevision = "e4c78883b38e3c59ae4a696ab60f78afc649759f";
const hash = (bytes: Buffer | string) =>
	createHash("sha256").update(bytes).digest("hex");
const configured = {
	AGENT_INFRA_RUNTIME_INSTALLED_SKILL: "workspace-summary-v1",
};
const physical = (path: string) => `${fixture.root}${path}`;
let manifestBytes: Buffer;
let build: Record<string, unknown>;

async function modes(path: string, mode: number) {
	await chmod(path, mode);
	for (const name of await readdir(path)) {
		const child = join(path, name);
		if ((await lstat(child)).isDirectory()) await modes(child, mode);
	}
}
async function put(path: string, bytes: string | Buffer) {
	const target = physical(path);
	await mkdir(dirname(target), { recursive: true });
	await chmod(target, 0o644).catch(() => undefined);
	await writeFile(target, bytes);
	await chmod(target, 0o444);
}
async function check() {
	await modes(fixture.root, 0o555);
	return readCodexInstalledSkillDeployment(configured, "fixture-config-7");
}
beforeEach(async () => {
	fixture.root = await realpath(await mkdtemp(join(tmpdir(), "fixed-skill-")));
	fixture.uid = 0;
	fixture.gid = 0;
	fixture.runtimeUid = 1000;
	fixture.writable = false;
	fixture.verify.mockReset().mockResolvedValue({
		codexVersion: "0.153.0",
		upstreamCommit: "41e22fee981a63b3698df7ed36bad393cda24715",
	});
	const source = new URL("../../../deploy/runtime/skills/", import.meta.url);
	manifestBytes = await readFile(
		new URL("workspace-summary.manifest.json", source),
	);
	await put(manifestPath, manifestBytes);
	await put(
		entryPath,
		await readFile(new URL("workspace-summary/SKILL.md", source)),
	);
	build = {
		schemaVersion: 1,
		sourceRevision,
		manifestSha256: hash(manifestBytes),
		packageSha256: JSON.parse(manifestBytes.toString()).packageDigest.sha256,
	};
	await put(buildPath, JSON.stringify(build));
});
afterEach(async () => {
	await modes(fixture.root, 0o755);
	await rm(fixture.root, { recursive: true, force: true });
});

it("binds real fixture bytes/inventory and readonly record to the concrete config", async () => {
	const descriptor = await check();
	expect(descriptor).toMatchObject({
		schemaVersion: 1,
		manifestSha256: hash(manifestBytes),
		deployment: {
			configVersion: "fixture-config-7",
			imageSourceRevision: sourceRevision,
		},
	});
	expect(Object.isFrozen(descriptor?.manifest.files[0])).toBe(true);
	expect(Object.isFrozen(descriptor?.deployment)).toBe(true);
	expect(fixture.verify).toHaveBeenCalledOnce();
});
it.each([
	["RUNTIME_CODEX_PROVENANCE_MISMATCH", "RUNTIME_CODEX_PROVENANCE_MISMATCH"],
	["private-verifier-sentinel", "RUNTIME_INSTALLED_SKILL_INVALID"],
])(
	"keeps verifier rejection %s fail closed and redacted",
	async (message, code) => {
		fixture.verify.mockRejectedValue(new Error(message));
		await expect(check()).rejects.toThrow(new RegExp(`^${code}$`));
		expect(fixture.verify).toHaveBeenCalledExactlyOnceWith(
			"workspace-summary-v1",
		);
	},
);
it("leaves an old unconfigured deployment unsupported without querying files", async () => {
	await rm(physical(installedRoot), { recursive: true });
	await expect(
		readCodexInstalledSkillDeployment({}, "old-config"),
	).resolves.toBeUndefined();
	expect(fixture.verify).not.toHaveBeenCalled();
});
it.each(["", "untrusted-path", "/tmp/skill"])(
	"rejects invalid enable value %s",
	async (value) => {
		await expect(
			readCodexInstalledSkillDeployment(
				{ AGENT_INFRA_RUNTIME_INSTALLED_SKILL: value },
				"config",
			),
		).rejects.toThrow(/^RUNTIME_INSTALLED_SKILL_INVALID$/);
	},
);

const mutations: [string, (value: Record<string, unknown>) => void][] = [
	[
		"unknown field",
		(value) => {
			value.verified = true;
		},
	],
	[
		"wrong schema",
		(value) => {
			value.schemaVersion = "1";
		},
	],
	[
		"wrong source",
		(value) => {
			value.source = {
				repository: "foreign",
				path: "deploy/runtime/skills/workspace-summary",
			};
		},
	],
	[
		"nested extra field",
		(value) => {
			value.source = {
				repository: "AgoraIO-Extensions/agent-infra",
				path: "deploy/runtime/skills/workspace-summary",
				verified: true,
			};
		},
	],
	[
		"wrong version",
		(value) => {
			value.version = "0.1.0";
		},
	],
	[
		"wrong runtime",
		(value) => {
			value.runtime = {
				kind: "codex",
				version: "new",
				upstreamCommit: sourceRevision,
			};
		},
	],
	[
		"traversal",
		(value) => {
			value.entryPath = `${installedRoot}/../SKILL.md`;
		},
	],
	[
		"wrong length",
		(value) => {
			value.files = [
				{ path: "SKILL.md", sizeBytes: 1374, sha256: hash("changed") },
			];
		},
	],
	[
		"invalid size type",
		(value) => {
			value.files = [
				{ path: "SKILL.md", sizeBytes: "1373", sha256: hash("changed") },
			];
		},
	],
	[
		"extra member",
		(value) => {
			value.files = [
				...(value.files as unknown[]),
				{ path: "other", sizeBytes: 1, sha256: hash("x") },
			];
		},
	],
	[
		"wrong package hash",
		(value) => {
			value.packageDigest = {
				algorithm: "sha256-json-file-inventory-v1",
				sha256: hash("wrong"),
			};
		},
	],
];
it.each(mutations)(
	"rejects manifest %s even if the build rebinds its raw hash",
	async (_name, mutate) => {
		const value = JSON.parse(manifestBytes.toString());
		mutate(value);
		const bytes = JSON.stringify(value);
		await put(manifestPath, bytes);
		await put(
			buildPath,
			JSON.stringify({ ...build, manifestSha256: hash(bytes) }),
		);
		await expect(check()).rejects.toThrow(/^RUNTIME_INSTALLED_SKILL_INVALID$/);
	},
);
it.each([manifestPath, buildPath])(
	"rejects duplicate escaped key in %s",
	async (path) => {
		const bytes =
			path === manifestPath ? manifestBytes.toString() : JSON.stringify(build);
		await put(
			path,
			bytes.replace(
				'"schemaVersion"',
				'"schemaVersion":1,"schema\\u0056ersion"',
			),
		);
		await expect(check()).rejects.toThrow(/^RUNTIME_INSTALLED_SKILL_INVALID$/);
	},
);
it.each([
	"missing",
	"replaced",
	"extra file",
	"extra directory",
	"symlink",
	"hardlink",
	"special file",
])("rejects actual inventory %s", async (fault) => {
	if (fault === "missing") await rm(physical(entryPath));
	if (fault === "replaced")
		await put(entryPath, "private-sentinel-replaced-package");
	if (fault === "extra file")
		await put(`${installedRoot}/workspace-summary/extra.txt`, "x");
	if (fault === "extra directory")
		await mkdir(physical(`${installedRoot}/workspace-summary/empty`));
	if (fault === "symlink") {
		await rm(physical(entryPath));
		await symlink(physical(manifestPath), physical(entryPath));
	}
	if (fault === "hardlink") {
		await rm(physical(entryPath));
		await link(physical(manifestPath), physical(entryPath));
	}
	if (fault === "special file") {
		await rm(physical(entryPath));
		execFileSync("mkfifo", [physical(entryPath)]);
	}
	await expect(check()).rejects.toThrow(/^RUNTIME_INSTALLED_SKILL_INVALID$/);
});

it.each(["/opt", "/opt/codex", installedRoot])(
	"rejects a replaceable ancestor %s",
	async (path) => {
		await modes(fixture.root, 0o555);
		await chmod(physical(path), 0o777);
		await expect(
			readCodexInstalledSkillDeployment(configured, "fixture-config-7"),
		).rejects.toThrow(/^RUNTIME_INSTALLED_SKILL_INVALID$/);
	},
);
it.each(["", "config with spaces"])(
	"rejects invalid trusted config version %s",
	async (configVersion) => {
		await modes(fixture.root, 0o555);
		await expect(
			readCodexInstalledSkillDeployment(configured, configVersion),
		).rejects.toThrow(/^RUNTIME_INSTALLED_SKILL_INVALID$/);
	},
);
it.each([
	"owner",
	"group",
	"root process",
	"writable parent",
	"file mode",
	"build missing",
	"revision unknown",
	"manifest hash",
	"package hash",
	"provenance",
])("rejects deployment %s without disclosure", async (fault) => {
	if (fault === "owner") fixture.uid = 1000;
	if (fault === "group") fixture.gid = 1000;
	if (fault === "root process") fixture.runtimeUid = 0;
	if (fault === "writable parent") fixture.writable = true;
	if (fault === "file mode") await chmod(physical(entryPath), 0o644);
	if (fault === "build missing") await rm(physical(buildPath));
	if (fault === "revision unknown")
		await put(
			buildPath,
			JSON.stringify({ ...build, sourceRevision: "unknown" }),
		);
	if (fault === "manifest hash")
		await put(
			buildPath,
			JSON.stringify({ ...build, manifestSha256: hash("bad") }),
		);
	if (fault === "package hash")
		await put(
			buildPath,
			JSON.stringify({ ...build, packageSha256: hash("bad") }),
		);
	if (fault === "provenance")
		fixture.verify.mockResolvedValue({
			codexVersion: "foreign",
			upstreamCommit: "private-sentinel",
		});
	await expect(check()).rejects.toThrow(/^RUNTIME_INSTALLED_SKILL_INVALID$/);
});
