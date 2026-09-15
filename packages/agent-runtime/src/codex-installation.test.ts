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
import nativeBarrier from "../../../deploy/runtime/vendor/codex/native-barrier-v1.json" with {
	type: "json",
};

const fixture = vi.hoisted(() => ({
	sandbox: "",
	release: {} as Record<string, unknown>,
	arch: "arm64",
	platform: "linux",
}));

vi.mock("./codex-release.json", () => ({
	get default() {
		return fixture.release;
	},
}));
vi.mock("node:process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:process")>()),
	get arch() {
		return fixture.arch;
	},
	get platform() {
		return fixture.platform;
	},
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	// Only the fixed production installation paths are translated. All bytes,
	// modes, directories, links and hashes remain real independent fixture data.
	const map = (path: PathLike) =>
		typeof path === "string" &&
		(path === "/" || path === "/opt" || path.startsWith("/opt/"))
			? `${fixture.sandbox}${path === "/" ? "" : path}`
			: path;
	return {
		...actual,
		access: (path: PathLike, mode?: number) => actual.access(map(path), mode),
		lstat: (path: PathLike) => actual.lstat(map(path)),
		open: (path: PathLike, flags: number) => actual.open(map(path), flags),
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
const binaries = {
	codex: "bundle/bin/codex",
	"codex-code-mode-host": "bundle/codex-resources/codex-code-mode-host",
	"codex-responses-api-proxy": "bundle/bin/codex-responses-api-proxy",
	bwrap: "bundle/codex-resources/bwrap",
};
const otherFiles = [
	"legal/UPSTREAM-LICENSE",
	"legal/UPSTREAM-NOTICE",
	"legal/JCS-NOTICE",
	"legal/licenses/ryu-js-1.0.3-APACHE.txt",
	"legal/licenses/ryu-js-1.0.3-BOOST.txt",
	"legal/licenses/serde_json_canonicalizer-0.3.2-MIT.txt",
	"Cargo.lock",
	"builder-environment.json",
	"source.cdx.json",
	"bundle/codex-package.json",
];
const allPayload = [...Object.values(binaries), ...otherFiles];
const hash = (data: string | Buffer) =>
	`sha256:${createHash("sha256").update(data).digest("hex")}`;
const object = (value: unknown) => value as Record<string, unknown>;
const installed = (source: string) =>
	join(
		fixture.sandbox,
		"opt/codex",
		source.startsWith("bundle/") ? source.slice(7) : `share/${source}`,
	);
let directory: string;
let candidate: Record<string, unknown>;
let payload: Record<string, Buffer>;

async function directoryModes(path: string, mode: number) {
	await chmod(path, mode);
	for (const name of await readdir(path)) {
		const child = join(path, name);
		if ((await lstat(child)).isDirectory()) await directoryModes(child, mode);
	}
}

async function put(path: string, data: Buffer | string, mode = 0o444) {
	await mkdir(dirname(path), { recursive: true });
	await chmod(path, 0o644).catch(() => undefined);
	await writeFile(path, data);
	await chmod(path, mode);
}

async function pinCandidate() {
	const raw = JSON.stringify(candidate);
	object(object(fixture.release.artifacts).arm64).candidateManifestSha256 =
		hash(raw);
	await put(installed("candidate.json"), raw);
	await put(installed("release.json"), JSON.stringify(fixture.release));
}

async function changePayload(source: string, data: Buffer | string) {
	const bytes = Buffer.from(data);
	const binary = Object.values(binaries).includes(source);
	await put(installed(source), bytes, binary ? 0o555 : 0o444);
	object(candidate.files)[source] = hash(bytes);
	for (const [name, path] of Object.entries(binaries)) {
		if (path !== source) continue;
		object(candidate.binaries)[name] = hash(bytes);
		object(object(object(fixture.release.artifacts).arm64).binaries)[name] =
			hash(bytes);
		if (name === "codex")
			object(object(fixture.release.artifacts).arm64).executableSha256 =
				hash(bytes);
		if (name === "bwrap") candidate.bwrapSha256 = hash(bytes);
	}
	await pinCandidate();
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
	directory = await realpath(
		await mkdtemp(join(tmpdir(), "codex-installation-")),
	);
	fixture.sandbox = join(directory, "root");
	fixture.arch = "arm64";
	fixture.platform = "linux";
	payload = Object.fromEntries(
		otherFiles.map((name) => [name, Buffer.from(`${name}\n`)]),
	);
	for (const [name, path] of Object.entries(binaries)) {
		const elf = Buffer.alloc(80);
		elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
		elf.writeUInt16LE(2, 16);
		elf.writeUInt16LE(183, 18);
		elf.write(name, 64);
		payload[path] = elf;
	}
	payload["bundle/codex-package.json"] = Buffer.from(
		JSON.stringify({
			version: "0.153.0",
			target: "aarch64-unknown-linux-musl",
			variant: "codex",
		}),
	);
	payload["source.cdx.json"] = Buffer.from(
		JSON.stringify({
			bomFormat: "CycloneDX",
			components: [{ name: "locked-rust-dependency", version: "1.0.0" }],
		}),
	);
	payload["builder-environment.json"] = Buffer.from(
		JSON.stringify({
			system: "Linux",
			machine: "aarch64",
			runId: "123",
			runAttempt: "1",
			nativeAcceptance: false,
		}),
	);
	const binaryHashes = Object.fromEntries(
		Object.entries(binaries).map(([name, path]) => [
			name,
			hash(payload[path] as Buffer),
		]),
	);
	candidate = {
		head: "a".repeat(40),
		run: { id: "123", attempt: "1" },
		sourceTree: "b".repeat(40),
		upstream: provenance.upstreamCommit,
		target: "aarch64-unknown-linux-musl",
		nativeAcceptance: false,
		inputSha256: {
			"build-input-v1.json": hash("frozen build inputs"),
			"codex-rs/Cargo.lock": hash(payload["Cargo.lock"] as Buffer),
			"callback-v2.schema.json": nativeBarrier.callbackSchemaSha256,
			"coverage-v1.json": nativeBarrier.coverageSha256,
			"callback-v2-corpus.json": nativeBarrier.callbackCorpusSha256,
		},
		files: Object.fromEntries(
			Object.entries(payload).map(([name, data]) => [name, hash(data)]),
		),
		binaries: binaryHashes,
		bwrapSha256: binaryHashes.bwrap,
		nativeProbe: structuredClone(nativeBarrier),
		sbom: {
			path: "source.cdx.json",
			scope: "Cargo.lock source dependencies only",
			binaryNativeDependenciesComplete: false,
		},
	};
	fixture.release = {
		schemaVersion: 2,
		provenance: { ...provenance },
		distribution: {
			kind: "derived",
			buildId: "test.123.1",
			sourceTree: candidate.sourceTree,
			buildInputSha256: object(candidate.inputSha256)["build-input-v1.json"],
		},
		artifacts: {
			arm64: {
				target: candidate.target,
				archiveSha256: hash("complete candidate archive"),
				candidateManifestSha256: hash("pending"),
				executableSha256: binaryHashes.codex,
				binaries: { ...binaryHashes },
			},
		},
	};
	for (const [source, bytes] of Object.entries(payload)) {
		await put(
			installed(source),
			bytes,
			Object.values(binaries).includes(source) ? 0o555 : 0o444,
		);
	}
	await pinCandidate();
});

afterEach(async () => {
	await directoryModes(directory, 0o755);
	await rm(directory, { recursive: true, force: true });
});

describe("pinned derived Codex installation", () => {
	it("verifies all installed bytes and returns only upstream protocol compatibility", async () => {
		await expect(verify()).resolves.toEqual(provenance);
	});

	it.each([
		{},
		{ sourceHead: "d".repeat(40) },
		{ runId: 124 },
		{ runAttempt: 2 },
		{ artifactId: Number.MAX_SAFE_INTEGER + 1 },
		{ runAttempt: true },
		{ repository: "other/repository" },
		{ extra: "unexpected" },
	])(
		"binds authenticated candidate bytes to its declared Actions source %j",
		async (change) => {
			object(object(fixture.release.artifacts).arm64).transport = {
				kind: "github-actions",
				repository: "AgoraIO-Extensions/agent-infra",
				runId: 123,
				runAttempt: 1,
				artifactId: 456,
				sourceHead: candidate.head,
				...change,
			};
			await put(installed("release.json"), JSON.stringify(fixture.release));
			if (Object.keys(change).length === 0)
				await expect(verify()).resolves.toEqual(provenance);
			else
				await expect(verify()).rejects.toThrow(
					"RUNTIME_CODEX_PROVENANCE_MISMATCH",
				);
		},
	);

	it("authenticates raw candidate bytes before reading its file inventory", async () => {
		await put(installed("candidate.json"), `${JSON.stringify(candidate)}\n`);
		await expect(verify()).rejects.toThrow("RUNTIME_CODEX_PROVENANCE_MISMATCH");
	});

	it("accepts differently serialized candidate bytes only with the matching compiled pin", async () => {
		const raw = `${JSON.stringify(candidate, null, 2)}\n`;
		object(object(fixture.release.artifacts).arm64).candidateManifestSha256 =
			hash(raw);
		await put(installed("candidate.json"), raw);
		await put(installed("release.json"), JSON.stringify(fixture.release));
		await expect(verify()).resolves.toEqual(provenance);
	});

	it("does not accept an installed release override", async () => {
		await put(
			installed("release.json"),
			JSON.stringify({ ...fixture.release, schemaVersion: 3 }),
		);
		await expect(verify()).rejects.toThrow("RUNTIME_CODEX_PROVENANCE_MISMATCH");
	});

	it.each(allPayload)("rejects missing payload %s", async (source) => {
		await rm(installed(source));
		await expect(verify()).rejects.toThrow("RUNTIME_CODEX_PROVENANCE_MISMATCH");
	});

	it.each(allPayload)("rejects altered payload %s", async (source) => {
		await put(
			installed(source),
			"changed",
			Object.values(binaries).includes(source) ? 0o555 : 0o444,
		);
		await expect(verify()).rejects.toThrow("RUNTIME_CODEX_PROVENANCE_MISMATCH");
	});

	it.each(Object.values(binaries))(
		"rejects a repinned non-aarch64 ELF at %s",
		async (source) => {
			const data = Buffer.from(payload[source] as Buffer);
			data.writeUInt16LE(62, 18);
			await changePayload(source, data);
			await expect(verify()).rejects.toThrow(
				"RUNTIME_CODEX_PROVENANCE_MISMATCH",
			);
		},
	);

	it.each([
		[
			"source tree",
			(value: Record<string, unknown>) => {
				value.sourceTree = "c".repeat(40);
			},
		],
		[
			"upstream",
			(value: Record<string, unknown>) => {
				value.upstream = "c".repeat(40);
			},
		],
		[
			"target",
			(value: Record<string, unknown>) => {
				value.target = "x86_64-unknown-linux-musl";
			},
		],
		[
			"build inputs",
			(value: Record<string, unknown>) => {
				object(value.inputSha256)["build-input-v1.json"] = hash("other inputs");
			},
		],
		[
			"Cargo lock",
			(value: Record<string, unknown>) => {
				object(value.inputSha256)["codex-rs/Cargo.lock"] = hash("other lock");
			},
		],
		[
			"callback schema",
			(value: Record<string, unknown>) => {
				object(value.inputSha256)["callback-v2.schema.json"] =
					hash("other schema");
			},
		],
		[
			"callback corpus",
			(value: Record<string, unknown>) => {
				object(value.inputSha256)["callback-v2-corpus.json"] =
					hash("other corpus");
			},
		],
		[
			"coverage",
			(value: Record<string, unknown>) => {
				object(value.inputSha256)["coverage-v1.json"] = hash("other coverage");
			},
		],
		[
			"probe",
			(value: Record<string, unknown>) => {
				object(value.nativeProbe).transport = "other";
			},
		],
		[
			"bwrap binding",
			(value: Record<string, unknown>) => {
				value.bwrapSha256 = hash("other bwrap");
			},
		],
		[
			"binary inventory",
			(value: Record<string, unknown>) => {
				object(value.binaries).bwrap = hash("other helper");
			},
		],
		[
			"extra manifest file",
			(value: Record<string, unknown>) => {
				object(value.files).extra = hash("extra");
			},
		],
		[
			"missing manifest file",
			(value: Record<string, unknown>) => {
				delete object(value.files)["Cargo.lock"];
			},
		],
		[
			"SBOM scope",
			(value: Record<string, unknown>) => {
				object(value.sbom).scope = "complete binary dependencies";
			},
		],
		[
			"SBOM completeness",
			(value: Record<string, unknown>) => {
				object(value.sbom).binaryNativeDependenciesComplete = true;
			},
		],
	] as const)("cross-checks repinned candidate %s", async (_name, mutate) => {
		mutate(candidate);
		await pinCandidate();
		await expect(verify()).rejects.toThrow("RUNTIME_CODEX_PROVENANCE_MISMATCH");
	});

	it.each([
		[
			"bundle/codex-package.json",
			{
				version: "0.153.0",
				target: "aarch64-unknown-linux-musl",
				variant: "other",
			},
		],
		["source.cdx.json", { bomFormat: "CycloneDX", components: [] }],
		[
			"source.cdx.json",
			{ bomFormat: "other", components: [{ name: "dependency" }] },
		],
	] as const)(
		"checks metadata content at %s after repinning",
		async (source, value) => {
			await changePayload(source, JSON.stringify(value));
			await expect(verify()).rejects.toThrow(
				"RUNTIME_CODEX_PROVENANCE_MISMATCH",
			);
		},
	);

	it.each(["x64", "riscv64"])(
		"has no official fallback for derived %s",
		async (arch) => {
			fixture.arch = arch;
			await expect(verify()).rejects.toThrow(
				"RUNTIME_CODEX_PROVENANCE_MISMATCH",
			);
		},
	);

	it("requires Linux", async () => {
		fixture.platform = "darwin";
		await expect(verify()).rejects.toThrow("RUNTIME_CODEX_PROVENANCE_MISMATCH");
	});

	it.each(["schemaVersion", "distribution", "artifact", "binaries"])(
		"rejects a malformed derived %s declaration",
		async (field) => {
			if (field === "artifact") delete object(fixture.release.artifacts).arm64;
			else if (field === "binaries")
				delete object(object(fixture.release.artifacts).arm64).binaries;
			else delete fixture.release[field];
			await put(installed("release.json"), JSON.stringify(fixture.release));
			await expect(verify()).rejects.toThrow(
				"RUNTIME_CODEX_PROVENANCE_MISMATCH",
			);
		},
	);

	it.each(["bundle/bin/codex", "candidate.json", "release.json"])(
		"rejects writable or special mode bits on %s",
		async (source) => {
			await chmod(
				installed(source),
				source.startsWith("bundle/") ? 0o4555 : 0o644,
			);
			await expect(verify()).rejects.toThrow(
				"RUNTIME_CODEX_PROVENANCE_MISMATCH",
			);
		},
	);

	it("rejects unexpected installed files", async () => {
		await put(installed("extra.json"), "{}");
		await expect(verify()).rejects.toThrow("RUNTIME_CODEX_PROVENANCE_MISMATCH");
	});

	it.each(["opt/codex/bin/codex", "opt/codex/bin", "opt/codex", "opt"])(
		"rejects symbolic links at %s",
		async (relative) => {
			const path = join(fixture.sandbox, relative);
			const destination = join(directory, "linked-content");
			await rename(path, destination);
			await symlink(destination, path);
			await expect(verify()).rejects.toThrow(
				"RUNTIME_CODEX_PROVENANCE_MISMATCH",
			);
		},
	);

	it("rejects a directory writable by the runtime process", async () => {
		await directoryModes(fixture.sandbox, 0o555);
		await chmod(join(fixture.sandbox, "opt/codex/bin"), 0o755);
		vi.resetModules();
		const { verifyCodexPilotInstallation } = await import(
			"./codex-installation.js"
		);
		await expect(verifyCodexPilotInstallation()).rejects.toThrow(
			"RUNTIME_CODEX_PROVENANCE_MISMATCH",
		);
	});
});

describe("official declaration transition", () => {
	it.each(["arm64", "x64"])(
		"keeps the old declared %s installation valid",
		async (arch) => {
			fixture.arch = arch;
			fixture.release = {
				provenance: { ...provenance },
				artifacts: {
					arm64: {
						executableSha256: hash(payload["bundle/bin/codex"] as Buffer),
					},
					amd64: {
						executableSha256: hash(payload["bundle/bin/codex"] as Buffer),
					},
				},
				legal: {
					LICENSE: hash("upstream license"),
					NOTICE: hash("upstream notice"),
				},
			};
			await put(installed("LICENSE"), "upstream license");
			await put(installed("NOTICE"), "upstream notice");
			await put(installed("release.json"), JSON.stringify(fixture.release));
			await expect(verify()).resolves.toEqual(provenance);
		},
	);
});
