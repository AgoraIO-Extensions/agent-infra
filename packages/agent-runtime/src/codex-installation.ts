import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { arch, getuid, platform } from "node:process";
import { isDeepStrictEqual } from "node:util";
import nativeBarrier from "../../../deploy/runtime/vendor/codex/native-barrier-v1.json" with {
	type: "json",
};

import { CODEX_APP_SERVER_V2_PROVENANCE } from "./codex-app-server-bridge.js";
import release from "./codex-release.json" with { type: "json" };

export const CODEX_PILOT_EXECUTABLE = "/opt/codex/bin/codex";

const installationRoot = "/opt/codex";
const derivedTarget = "aarch64-unknown-linux-musl";
const binaryFiles = {
	codex: "bundle/bin/codex",
	"codex-responses-api-proxy": "bundle/bin/codex-responses-api-proxy",
	"codex-code-mode-host": "bundle/codex-resources/codex-code-mode-host",
	bwrap: "bundle/codex-resources/bwrap",
};
const payloadFiles = [
	...Object.values(binaryFiles),
	"bundle/codex-package.json",
	"legal/UPSTREAM-LICENSE",
	"legal/UPSTREAM-NOTICE",
	"legal/JCS-NOTICE",
	"legal/licenses/dependency-updates-NOTICE.txt",
	"legal/licenses/ryu-js-1.0.3-APACHE.txt",
	"legal/licenses/ryu-js-1.0.3-BOOST.txt",
	"legal/licenses/serde_json_canonicalizer-0.3.2-MIT.txt",
	"Cargo.lock",
	"source.cdx.json",
	"builder-environment.json",
];

function requireValid(condition: unknown): asserts condition {
	if (!condition) throw new Error();
}

function record(value: unknown): Record<string, unknown> {
	requireValid(
		value !== null && typeof value === "object" && !Array.isArray(value),
	);
	return value as Record<string, unknown>;
}

function digest(value: unknown): string {
	requireValid(
		typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value),
	);
	return value;
}

function sameKeys(value: Record<string, unknown>, keys: string[]) {
	return isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function installedPath(source: string) {
	return `${installationRoot}/${source.startsWith("bundle/") ? source.slice(7) : `share/${source}`}`;
}

async function protectedDirectory(path: string) {
	if (typeof getuid === "function" && getuid() === 0) throw new Error();
	requireValid((await realpath(path)) === path);
	const stat = await lstat(path);
	requireValid(stat.isDirectory() && (stat.mode & 0o7022) === 0);
	try {
		await access(path, constants.W_OK);
	} catch (error) {
		const code = record(error).code;
		if (code === "EACCES" || code === "EROFS") return;
		throw error;
	}
	throw new Error();
}

async function verifyLayout(expectedFiles: readonly string[]) {
	const files = new Set(expectedFiles);
	const directories = new Set<string>();
	for (const file of files) {
		for (let path = dirname(file); path !== "/"; path = dirname(path)) {
			directories.add(path);
		}
	}
	// Prevent replacing the installation through a writable or symlinked ancestor.
	await protectedDirectory("/");
	await protectedDirectory("/opt");
	async function visit(path: string) {
		await protectedDirectory(path);
		for (const name of await readdir(path)) {
			const child = `${path}/${name}`;
			if (directories.has(child)) await visit(child);
			else requireValid(files.delete(child) && (await lstat(child)).isFile());
		}
	}
	await visit(installationRoot);
	requireValid(files.size === 0);
}

async function readProtectedFile(
	path: string,
	expected?: string,
	binary = false,
) {
	requireValid((await realpath(path)) === path);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await file.stat();
		const mode = binary ? undefined : 0o444;
		requireValid(
			before.isFile() &&
				(binary
					? (before.mode & 0o6222) === 0 && (before.mode & 0o111) !== 0
					: (before.mode & 0o7777) === mode) &&
				before.size > 0 &&
				before.size <= (binary ? 512 : 16) * 1024 * 1024,
		);
		const hash = createHash("sha256");
		const chunks: Buffer[] = [];
		const buffer = Buffer.alloc(64 * 1024);
		let bytes = 0;
		let header = Buffer.alloc(0);
		while (true) {
			const { bytesRead } = await file.read(buffer);
			if (bytesRead === 0) break;
			if (header.length < 64)
				header = Buffer.concat([
					header,
					buffer.subarray(0, Math.min(64 - header.length, bytesRead)),
				]);
			bytes += bytesRead;
			requireValid(bytes <= before.size);
			const chunk = buffer.subarray(0, bytesRead);
			hash.update(chunk);
			if (!binary) chunks.push(Buffer.from(chunk));
		}
		const after = await file.stat();
		requireValid(
			bytes === before.size &&
				after.size === before.size &&
				after.mode === before.mode &&
				after.mtimeMs === before.mtimeMs &&
				after.ctimeMs === before.ctimeMs,
		);
		if (expected !== undefined)
			requireValid(`sha256:${hash.digest("hex")}` === digest(expected));
		if (binary) {
			requireValid(
				header.length === 64 &&
					header
						.subarray(0, 6)
						.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) &&
					[2, 3].includes(header.readUInt16LE(16)) &&
					header.readUInt16LE(18) ===
						(arch === "arm64" ? 183 : arch === "x64" ? 62 : 0),
			);
		}
		return Buffer.concat(chunks);
	} finally {
		await file.close();
	}
}

async function verifyDerived(pinned: Record<string, unknown>) {
	requireValid(pinned.schemaVersion === 2 && arch === "arm64");
	const distribution = record(pinned.distribution);
	requireValid(
		sameKeys(distribution, [
			"kind",
			"buildId",
			"sourceTree",
			"buildInputSha256",
		]) &&
			distribution.kind === "derived" &&
			typeof distribution.buildId === "string" &&
			/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(distribution.buildId) &&
			typeof distribution.sourceTree === "string" &&
			/^[a-f0-9]{40}$/.test(distribution.sourceTree),
	);
	digest(distribution.buildInputSha256);
	const artifact = record(record(pinned.artifacts).arm64);
	requireValid(artifact.target === derivedTarget);
	digest(artifact.archiveSha256);
	digest(artifact.executableSha256);
	const manifestHash = digest(artifact.candidateManifestSha256);
	await verifyLayout(
		[...payloadFiles, "candidate.json", "release.json"].map(installedPath),
	);
	const installed = await readProtectedFile(installedPath("release.json"));
	requireValid(
		isDeepStrictEqual(JSON.parse(installed.toString("utf8")), release),
	);
	// The compiled pin authenticates these bytes before the manifest can name a hash.
	const raw = await readProtectedFile(
		installedPath("candidate.json"),
		manifestHash,
	);
	const candidate = record(JSON.parse(raw.toString("utf8")));
	if (artifact.transport !== undefined) {
		const transport = record(artifact.transport);
		requireValid(
			sameKeys(transport, [
				"kind",
				"repository",
				"runId",
				"runAttempt",
				"artifactId",
				"sourceHead",
			]) &&
				transport.kind === "github-actions" &&
				transport.repository === "AgoraIO-Extensions/agent-infra" &&
				typeof transport.sourceHead === "string" &&
				/^[a-f0-9]{40}$/.test(transport.sourceHead),
		);
		for (const key of ["runId", "runAttempt", "artifactId"]) {
			const value = transport[key];
			requireValid(
				typeof value === "number" && Number.isSafeInteger(value) && value > 0,
			);
		}
		const run = record(candidate.run);
		requireValid(
			candidate.head === transport.sourceHead &&
				run.id === String(transport.runId) &&
				run.attempt === String(transport.runAttempt),
		);
	}
	const inputs = record(candidate.inputSha256);
	requireValid(
		candidate.sourceTree === distribution.sourceTree &&
			candidate.upstream === release.provenance.upstreamCommit &&
			candidate.target === derivedTarget &&
			inputs["build-input-v1.json"] === distribution.buildInputSha256 &&
			candidate.nativeAcceptance === false,
	);
	for (const hash of Object.values(inputs)) digest(hash);
	const files = record(candidate.files);
	requireValid(sameKeys(files, payloadFiles));
	const binaries = record(candidate.binaries);
	requireValid(
		sameKeys(binaries, Object.keys(binaryFiles)) &&
			isDeepStrictEqual(binaries, artifact.binaries) &&
			binaries.codex === artifact.executableSha256 &&
			binaries.bwrap === candidate.bwrapSha256,
	);
	for (const [name, source] of Object.entries(binaryFiles)) {
		requireValid(binaries[name] === files[source]);
	}
	requireValid(
		isDeepStrictEqual(candidate.nativeProbe, nativeBarrier) &&
			inputs["callback-v2.schema.json"] ===
				nativeBarrier.callbackSchemaSha256 &&
			inputs["coverage-v1.json"] === nativeBarrier.coverageSha256 &&
			inputs["callback-v2-corpus.json"] ===
				nativeBarrier.callbackCorpusSha256 &&
			inputs["codex-rs/Cargo.lock"] === files["Cargo.lock"],
	);
	const metadata = new Map<string, Buffer>();
	for (const source of payloadFiles) {
		const binary = Object.values(binaryFiles).includes(source);
		const data = await readProtectedFile(
			installedPath(source),
			digest(files[source]),
			binary,
		);
		if (!binary) metadata.set(source, data);
	}
	const json = (name: string) =>
		record(JSON.parse(metadata.get(name)?.toString("utf8") ?? ""));
	requireValid(
		isDeepStrictEqual(json("bundle/codex-package.json"), {
			version: release.provenance.codexVersion,
			target: derivedTarget,
			variant: "codex",
		}),
	);
	const sbom = record(candidate.sbom);
	const inventory = json("source.cdx.json");
	requireValid(
		sbom.path === "source.cdx.json" &&
			sbom.scope === "Cargo.lock source dependencies only" &&
			sbom.binaryNativeDependenciesComplete === false &&
			inventory.bomFormat === "CycloneDX" &&
			Array.isArray(inventory.components) &&
			inventory.components.length > 0,
	);
}

export async function verifyCodexPilotInstallation() {
	try {
		requireValid(
			platform === "linux" &&
				release.provenance.protocolVersion === 2 &&
				isDeepStrictEqual(release.provenance, CODEX_APP_SERVER_V2_PROVENANCE),
		);
		const pinned = record(release);
		if ("schemaVersion" in pinned || "distribution" in pinned) {
			await verifyDerived(pinned);
			return release.provenance;
		}
		// Kept until the release declaration switches atomically from official to derived.
		const artifacts = record(pinned.artifacts);
		const artifact =
			arch === "arm64"
				? artifacts.arm64
				: arch === "x64"
					? artifacts.amd64
					: undefined;
		const official = record(artifact);
		const legal = record(pinned.legal);
		const legalNames = Object.keys(legal);
		requireValid(
			legalNames.every((name) =>
				/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name),
			),
		);
		await verifyLayout([
			CODEX_PILOT_EXECUTABLE,
			installedPath("release.json"),
			...legalNames.map(installedPath),
		]);
		const installed = await readProtectedFile(installedPath("release.json"));
		requireValid(
			isDeepStrictEqual(JSON.parse(installed.toString("utf8")), release),
		);
		for (const [path, expected] of [
			[CODEX_PILOT_EXECUTABLE, official.executableSha256],
			...Object.entries(legal).map(([name, hash]) => [
				installedPath(name),
				hash,
			]),
		] as [string, string][]) {
			await readProtectedFile(
				path,
				digest(expected),
				path === CODEX_PILOT_EXECUTABLE,
			);
		}
		return release.provenance;
	} catch {
		throw new Error("RUNTIME_CODEX_PROVENANCE_MISMATCH");
	}
}
