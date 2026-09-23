import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { arch, getuid, platform } from "node:process";
import { isDeepStrictEqual } from "node:util";
import { CODEX_APP_SERVER_V2_PROVENANCE } from "./codex-app-server-bridge.js";
import release from "./codex-release.json" with { type: "json" };

export const CODEX_PILOT_EXECUTABLE = "/opt/codex/bin/codex";

const installationRoot = "/opt/codex";
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

function installedPath(name: string) {
	return `${installationRoot}/share/${name}`;
}

async function protectedDirectory(path: string) {
	if (typeof getuid === "function" && getuid() === 0) throw new Error();
	requireValid((await realpath(path)) === path);
	const stat = await lstat(path);
	requireValid(
		stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o7022) === 0,
	);
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
		const mode = binary ? 0o555 : 0o444;
		requireValid(
			before.isFile() &&
				before.uid === 0 &&
				(before.mode & 0o7777) === mode &&
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

export async function verifyCodexPilotInstallation() {
	try {
		requireValid(
			platform === "linux" &&
				release.provenance.protocolVersion === 2 &&
				isDeepStrictEqual(release.provenance, CODEX_APP_SERVER_V2_PROVENANCE),
		);
		const pinned = record(release);
		requireValid(!("schemaVersion" in pinned) && !("distribution" in pinned));
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
