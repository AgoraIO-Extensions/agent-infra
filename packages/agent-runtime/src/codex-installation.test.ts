import { createHash } from "node:crypto";
import type { PathLike } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	sandbox: "",
	release: {} as Record<string, unknown>,
	arch: "arm64",
	platform: "linux",
	ownerUid: 0,
	runtimeUid: 1000,
}));

vi.mock("./codex-release.json", () => ({
	get default() {
		return fixture.release;
	},
}));
vi.mock("node:process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:process")>()),
	get getuid() {
		return () => fixture.runtimeUid;
	},
	get arch() {
		return fixture.arch;
	},
	get platform() {
		return fixture.platform;
	},
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	// Translate installation paths and deployment ownership; bytes, modes,
	// directories, links and hashes remain real independent fixture data.
	const map = (path: PathLike) =>
		typeof path === "string" &&
		(path === "/" || path === "/opt" || path.startsWith("/opt/"))
			? `${fixture.sandbox}${path === "/" ? "" : path}`
			: path;
	return {
		...actual,
		access: (path: PathLike, mode?: number) => actual.access(map(path), mode),
		lstat: async (path: PathLike) =>
			Object.assign(await actual.lstat(map(path)), { uid: fixture.ownerUid }),
		open: async (path: PathLike, flags: number) => {
			const file = await actual.open(map(path), flags);
			const stat = file.stat.bind(file);
			(file as unknown as { stat: () => Promise<unknown> }).stat = async () =>
				Object.assign(await stat(), { uid: fixture.ownerUid });
			return file;
		},
		readFile: (...args: Parameters<typeof actual.readFile>) =>
			actual.readFile(
				typeof args[0] === "string" ? map(args[0]) : args[0],
				args[1],
			),
		readdir: (path: PathLike) => actual.readdir(map(path)),
		realpath: async (path: PathLike) => {
			const resolved = await actual.realpath(map(path));
			return resolved === fixture.sandbox
				? "/"
				: resolved.startsWith(`${fixture.sandbox}/`)
					? resolved.slice(fixture.sandbox.length)
					: resolved;
		},
	};
});

const provenance = {
	protocolVersion: 2,
	codexVersion: "0.153.0",
	upstreamTag: "rust-v0.153.0",
	upstreamCommit: "41e22fee981a63b3698df7ed36bad393cda24715",
	schemaSha256:
		"sha256:d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a",
};
const hash = (data: string | Buffer) =>
	`sha256:${createHash("sha256").update(data).digest("hex")}`;
const installed = (name: string) => join(fixture.sandbox, "opt/codex", name);
let directory: string;
let executable: Buffer;
async function directoryModes(path: string, mode: number) {
	await chmod(path, mode);
	for (const name of await readdir(path)) {
		const child = join(path, name);
		if ((await lstat(child)).isDirectory()) await directoryModes(child, mode);
	}
}
async function put(name: string, data: string | Buffer, mode = 0o444) {
	const path = installed(name);
	await mkdir(dirname(path), { recursive: true });
	await chmod(path, 0o644).catch(() => undefined);
	await writeFile(path, data);
	await chmod(path, mode);
}
async function repin(arch = "arm64") {
	fixture.arch = arch;
	executable.writeUInt16LE(arch === "x64" ? 62 : 183, 18);
	fixture.release = {
		provenance: { ...provenance },
		artifacts: {
			arm64: { executableSha256: hash(executable) },
			amd64: { executableSha256: hash(executable) },
		},
		legal: {
			LICENSE: hash("upstream license"),
			NOTICE: hash("upstream notice"),
		},
	};
	await put("bin/codex", executable, 0o555);
	await put("share/release.json", JSON.stringify(fixture.release));
}
async function verify() {
	await directoryModes(fixture.sandbox, 0o555);
	vi.resetModules();
	const { verifyCodexPilotInstallation } = await import(
		"./codex-installation.js"
	);
	return verifyCodexPilotInstallation();
}
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "official-installation-"));
	fixture.sandbox = await realpath(directory);
	fixture.platform = "linux";
	fixture.ownerUid = 0;
	fixture.runtimeUid = 1000;
	executable = Buffer.alloc(64);
	Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(executable);
	executable.writeUInt16LE(2, 16);
	await repin();
	await put("share/LICENSE", "upstream license");
	await put("share/NOTICE", "upstream notice");
});
afterEach(async () => {
	// Fixture owns this tree; restore only its permissions before removal.
	await directoryModes(directory, 0o755);
	await rm(directory, { recursive: true, force: true });
});
const mismatch = "RUNTIME_CODEX_PROVENANCE_MISMATCH";
describe("fixed official Codex installation", () => {
	it.each(["arm64", "x64"])(
		"accepts declared %s bytes and ELF architecture",
		async (arch) => {
			await repin(arch);
			await expect(verify()).resolves.toEqual(provenance);
		},
	);
	it.each(["bin/codex", "share/LICENSE", "share/NOTICE", "share/release.json"])(
		"rejects modified %s",
		async (name) => {
			await put(name, "tampered", name === "bin/codex" ? 0o555 : 0o444);
			await expect(verify()).rejects.toThrow(mismatch);
		},
	);
	it.each(["riscv64", "x64"])(
		"rejects undeclared or mismatched %s",
		async (arch) => {
			fixture.arch = arch;
			await expect(verify()).rejects.toThrow(mismatch);
		},
	);
	it.each(["darwin", "win32"])("rejects non-Linux %s", async (platform) => {
		fixture.platform = platform;
		await expect(verify()).rejects.toThrow(mismatch);
	});
	it("rejects a caller-controlled file owner", async () => {
		fixture.ownerUid = 1000;
		await expect(verify()).rejects.toThrow(mismatch);
	});
	it("rejects a root runtime even on read-only files", async () => {
		fixture.runtimeUid = 0;
		await expect(verify()).rejects.toThrow(mismatch);
	});
	it.each(["bin/codex", "share/release.json"])(
		"rejects writable/special bits at %s",
		async (name) => {
			await chmod(installed(name), name === "bin/codex" ? 0o4555 : 0o644);
			await expect(verify()).rejects.toThrow(mismatch);
		},
	);
	it("rejects an unexpected payload file", async () => {
		await put("share/extra.json", "{}");
		await expect(verify()).rejects.toThrow(mismatch);
	});
	it.each(["opt/codex/bin/codex", "opt/codex/bin", "opt/codex", "opt"])(
		"rejects symlinked %s",
		async (name) => {
			const path = join(fixture.sandbox, name);
			const destination = join(directory, "linked-content");
			await rename(path, destination);
			await symlink(destination, path);
			await expect(verify()).rejects.toThrow(mismatch);
			await directoryModes(directory, 0o755);
			await rm(path);
			await rename(destination, path);
		},
	);
	it.each(["/", "/opt", "/opt/codex", "/opt/codex/bin"])(
		"rejects writable ancestor %s",
		async (name) => {
			await directoryModes(fixture.sandbox, 0o555);
			await chmod(join(fixture.sandbox, name), 0o775);
			vi.resetModules();
			const { verifyCodexPilotInstallation } = await import(
				"./codex-installation.js"
			);
			await expect(verifyCodexPilotInstallation()).rejects.toThrow(mismatch);
		},
	);
	it.each(["schemaVersion", "distribution"])(
		"rejects unsupported declaration %s",
		async (field) => {
			fixture.release[field] =
				field === "schemaVersion" ? 2 : { kind: "derived" };
			await put("share/release.json", JSON.stringify(fixture.release));
			await expect(verify()).rejects.toThrow(mismatch);
		},
	);
	it.each([0, 4, 5, 16, 18])(
		"rejects repinned invalid ELF field at %i",
		async (offset) => {
			executable[offset] = 0;
			const artifacts = fixture.release.artifacts as {
				arm64: { executableSha256: string };
			};
			artifacts.arm64.executableSha256 = hash(executable);
			await put("bin/codex", executable, 0o555);
			await put("share/release.json", JSON.stringify(fixture.release));
			await expect(verify()).rejects.toThrow(mismatch);
		},
	);
});
