import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir, realpath } from "node:fs/promises";
import { getuid } from "node:process";
import { isDeepStrictEqual } from "node:util";
import {
	type CodexRuntimeDriver,
	verifyCodexPilotInstallation,
} from "@agent-infra/agent-runtime";

// Consume the concrete main contract without a new export or a copied type.
type Descriptor = NonNullable<
	Parameters<typeof CodexRuntimeDriver.open>[0]["installedSkill"]
>;
const extraRoot = "/opt/codex/agent-infra-skills";
const packageRoot = `${extraRoot}/workspace-summary`;
const manifestPath = `${extraRoot}/workspace-summary.manifest.json`;
const buildPath = "/opt/codex/share/workspace-summary-build.json";
const sha256 = (bytes: Buffer | string) =>
	createHash("sha256").update(bytes).digest("hex");

function valid(condition: unknown): asserts condition {
	if (!condition) throw new Error();
}

// JSON.parse checks syntax; this bounded pass rejects escaped duplicate keys too.
function parseJson(bytes: Buffer): unknown {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const value: unknown = JSON.parse(text);
	const objects: (Set<string> | undefined)[] = [];
	for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/g)) {
		const token = match[0];
		if (token === "{") objects.push(new Set());
		else if (token === "[") objects.push(undefined);
		else if (token === "}" || token === "]") objects.pop();
		else if (/^\s*:/.test(text.slice(match.index + token.length))) {
			const keys = objects.at(-1);
			const key: string = JSON.parse(token);
			valid(keys && !keys.has(key));
			keys.add(key);
		}
	}
	return value;
}

function record(value: unknown): Record<string, unknown> {
	valid(value !== null && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

function hash(value: unknown): string {
	valid(typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
	return value;
}

async function protectedDirectory(path: string, exact = true) {
	valid((await realpath(path)) === path);
	const stat = await lstat(path);
	valid(
		stat.isDirectory() &&
			stat.uid === 0 &&
			stat.gid === 0 &&
			(exact ? (stat.mode & 0o7777) === 0o555 : (stat.mode & 0o7022) === 0),
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

async function protectedFile(path: string, limit: number) {
	valid((await realpath(path)) === path);
	const listed = await lstat(path);
	valid(listed.isFile() && listed.nlink === 1);
	const handle = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = await handle.stat();
		valid(
			before.isFile() &&
				before.ino === listed.ino &&
				before.dev === listed.dev &&
				before.uid === 0 &&
				before.gid === 0 &&
				before.nlink === 1 &&
				(before.mode & 0o7777) === 0o444 &&
				before.size > 0 &&
				before.size <= limit,
		);
		const buffer = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(
				buffer,
				length,
				buffer.length - length,
				length,
			);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		const after = await handle.stat();
		const current = await lstat(path);
		valid(
			length === before.size &&
				[after, current].every(
					(stat) =>
						stat.ino === before.ino &&
						stat.dev === before.dev &&
						stat.mode === before.mode &&
						stat.uid === before.uid &&
						stat.gid === before.gid &&
						stat.nlink === before.nlink &&
						stat.size === before.size &&
						stat.mtimeMs === before.mtimeMs &&
						stat.ctimeMs === before.ctimeMs,
				),
		);
		return buffer.subarray(0, length);
	} finally {
		await handle.close();
	}
}

function manifest(bytes: Buffer): Descriptor["manifest"] {
	const value = record(parseJson(bytes));
	valid(Array.isArray(value.files) && value.files.length === 1);
	const file = record(value.files[0]);
	valid(
		typeof file.sizeBytes === "number" &&
			Number.isInteger(file.sizeBytes) &&
			file.sizeBytes >= 1 &&
			file.sizeBytes <= 8192,
	);
	const expected: Descriptor["manifest"] = Object.freeze({
		schemaVersion: 1,
		name: "workspace-summary",
		version: "0.1.0-candidate.1",
		source: Object.freeze({
			repository: "AgoraIO-Extensions/agent-infra",
			path: "deploy/runtime/skills/workspace-summary",
		}),
		runtime: Object.freeze({
			kind: "codex",
			version: "0.153.0",
			upstreamCommit: "41e22fee981a63b3698df7ed36bad393cda24715",
		}),
		extraRoot: "/opt/codex/agent-infra-skills",
		packageRoot: "/opt/codex/agent-infra-skills/workspace-summary",
		entryPath: "/opt/codex/agent-infra-skills/workspace-summary/SKILL.md",
		files: Object.freeze([
			Object.freeze({
				path: "SKILL.md",
				sizeBytes: file.sizeBytes,
				sha256: hash(file.sha256),
			}),
		] as const),
		packageDigest: Object.freeze({
			algorithm: "sha256-json-file-inventory-v1",
			sha256: hash(record(value.packageDigest).sha256),
		}),
	});
	valid(isDeepStrictEqual(value, expected));
	return expected;
}

/** Only fixed deployment configuration enables this package; no caller path is read. */
export async function readCodexInstalledSkillDeployment(
	environment: NodeJS.ProcessEnv,
	configVersion: string,
): Promise<Descriptor | undefined> {
	const configured = environment.AGENT_INFRA_RUNTIME_INSTALLED_SKILL;
	if (configured === undefined) return undefined;
	try {
		valid(configured === "workspace-summary-v1");
		valid(typeof getuid === "function" && getuid() !== 0);
		valid(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configVersion));
		for (const path of ["/", "/opt"]) await protectedDirectory(path, false);
		for (const path of [
			"/opt/codex",
			"/opt/codex/share",
			extraRoot,
			packageRoot,
		])
			await protectedDirectory(path);
		valid(
			isDeepStrictEqual((await readdir(extraRoot)).sort(), [
				"workspace-summary",
				"workspace-summary.manifest.json",
			]) && isDeepStrictEqual(await readdir(packageRoot), ["SKILL.md"]),
		);
		const manifestBytes = await protectedFile(manifestPath, 8192);
		const installed = manifest(manifestBytes);
		const entry = await protectedFile(installed.entryPath, 8192);
		const file = installed.files[0];
		valid(entry.length === file.sizeBytes && sha256(entry) === file.sha256);
		const inventory = `${JSON.stringify({
			domain: "agent-infra.skill-package.v1",
			files: [[file.path, entry.length, sha256(entry)]],
		})}\n`;
		valid(sha256(inventory) === installed.packageDigest.sha256);
		const build = record(parseJson(await protectedFile(buildPath, 4096)));
		valid(
			typeof build.sourceRevision === "string" &&
				/^[a-f0-9]{40}$/.test(build.sourceRevision) &&
				build.sourceRevision !== "0".repeat(40) &&
				isDeepStrictEqual(build, {
					schemaVersion: 1,
					sourceRevision: build.sourceRevision,
					manifestSha256: sha256(manifestBytes),
					packageSha256: installed.packageDigest.sha256,
				}),
		);
		const provenance = await verifyCodexPilotInstallation(
			"workspace-summary-v1",
		);
		valid(
			provenance.codexVersion === installed.runtime.version &&
				provenance.upstreamCommit === installed.runtime.upstreamCommit,
		);
		return Object.freeze({
			schemaVersion: 1,
			manifestSha256: sha256(manifestBytes),
			manifest: installed,
			deployment: Object.freeze({
				configVersion,
				imageSourceRevision: build.sourceRevision,
			}),
		});
	} catch {
		throw new Error("RUNTIME_INSTALLED_SKILL_INVALID");
	}
}
