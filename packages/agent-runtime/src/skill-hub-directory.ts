import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { SkillWorkloadProjectionV1Schema } from "@agent-infra/contracts";

const maxSkills = 150;
const maxMetadataBytes = 30_000;
const defaultMaxResourceBytes = 1_048_576;

export type RuntimeSkillDirectoryEntryV1 = Readonly<{
	schemaVersion: 1;
	name: string;
	version: string;
	packageDigest: string;
	manifestDigest: string;
	targetPath: string;
	readOnly: true;
}>;

export type RuntimeSkillDirectoryReadRequestV1 = Readonly<{
	skill: RuntimeSkillDirectoryEntryV1;
	relativePath: string;
	maximumBytes: number;
}>;

export class RuntimeSkillDirectoryErrorV1 extends Error {
	readonly code = "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE" as const;

	constructor() {
		super("Runtime Skill directory is unavailable");
		this.name = "RuntimeSkillDirectoryErrorV1";
	}
}

function unavailable(): never {
	throw new RuntimeSkillDirectoryErrorV1();
}

function boundedRelativePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 512 ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.startsWith("/") ||
		value
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	)
		unavailable();
	return value;
}

function projectionEntry(
	projection: unknown,
	agentId: string,
	agentVersion: string,
): RuntimeSkillDirectoryEntryV1 {
	const parsed = SkillWorkloadProjectionV1Schema.safeParse(projection);
	if (
		!parsed.success ||
		parsed.data.agentId !== agentId ||
		parsed.data.agentVersion !== agentVersion ||
		parsed.data.targetPath !== `.agents/skills/${parsed.data.manifest.name}`
	)
		unavailable();
	return Object.freeze({
		schemaVersion: 1,
		name: parsed.data.manifest.name,
		version: parsed.data.skillVersion.version,
		packageDigest: parsed.data.skillVersion.packageDigest,
		manifestDigest: parsed.data.skillVersion.manifestDigest,
		targetPath: parsed.data.targetPath,
		readOnly: true,
	});
}

export function createRuntimeSkillDirectoryV1(input: {
	agentId: string;
	agentVersion: string;
	generationId: string;
	projections: readonly unknown[];
	maximumResourceBytes?: number;
}) {
	if (
		typeof input.agentId !== "string" ||
		typeof input.agentVersion !== "string" ||
		!/^[a-f0-9]{64}$/.test(input.generationId) ||
		!Array.isArray(input.projections) ||
		input.projections.length > maxSkills
	)
		unavailable();
	const entries = input.projections
		.map((projection) =>
			projectionEntry(projection, input.agentId, input.agentVersion),
		)
		.toSorted((left, right) => left.name.localeCompare(right.name));
	if (
		new Set(entries.map((entry) => entry.name)).size !== entries.length ||
		new Set(entries.map((entry) => entry.targetPath)).size !== entries.length
	)
		unavailable();
	const metadata = Object.freeze(entries.map((entry) => Object.freeze(entry)));
	if (
		Buffer.byteLength(
			JSON.stringify({
				schemaVersion: 1,
				generationId: input.generationId,
				skills: metadata,
			}),
			"utf8",
		) > maxMetadataBytes
	)
		unavailable();
	const maximumResourceBytes =
		input.maximumResourceBytes ?? defaultMaxResourceBytes;
	if (
		!Number.isSafeInteger(maximumResourceBytes) ||
		maximumResourceBytes < 1 ||
		maximumResourceBytes > 10_485_760
	)
		unavailable();
	return {
		generationId: input.generationId,
		findSkills(): readonly RuntimeSkillDirectoryEntryV1[] {
			return metadata;
		},
		async readSkill(
			name: string,
			relativePath: string,
			read: (
				request: RuntimeSkillDirectoryReadRequestV1,
			) => Promise<Uint8Array>,
		): Promise<Uint8Array> {
			const skill = metadata.find((entry) => entry.name === name);
			if (!skill || typeof read !== "function") unavailable();
			const bytes = await read({
				skill,
				relativePath: boundedRelativePath(relativePath),
				maximumBytes: maximumResourceBytes,
			});
			if (
				!(bytes instanceof Uint8Array) ||
				bytes.byteLength > maximumResourceBytes
			)
				unavailable();
			return bytes.slice();
		},
	};
}

async function readMountedSkillFile(input: {
	root: string;
	path: string;
	sizeBytes: number;
	sha256: string;
	maximumBytes: number;
}): Promise<Uint8Array> {
	const root = resolve(input.root);
	if (!isAbsolute(input.root) || root !== input.root) unavailable();
	const rootInfo = await lstat(root).catch(() => unavailable());
	const rootReal = await realpath(root).catch(() => unavailable());
	if (
		rootReal !== root ||
		!rootInfo.isDirectory() ||
		rootInfo.isSymbolicLink() ||
		rootInfo.mode & 0o222
	)
		unavailable();
	const candidate = resolve(rootReal, input.path);
	const within = relative(rootReal, candidate);
	if (
		!within ||
		within === ".." ||
		within.startsWith("../") ||
		isAbsolute(within)
	)
		unavailable();
	let current = candidate;
	for (;;) {
		const info = await lstat(current).catch(() => unavailable());
		if (
			info.isSymbolicLink() ||
			info.mode & 0o222 ||
			(current === candidate ? !info.isFile() : !info.isDirectory())
		)
			unavailable();
		if (current === rootReal) break;
		const parent = resolve(current, "..");
		if (parent === current) unavailable();
		current = parent;
	}
	const info = await lstat(candidate).catch(() => unavailable());
	if (
		info.nlink !== 1 ||
		info.mode & 0o222 ||
		!Number.isSafeInteger(input.sizeBytes) ||
		input.sizeBytes < 0 ||
		input.sizeBytes > input.maximumBytes ||
		info.size !== input.sizeBytes
	)
		unavailable();
	const handle = await open(
		candidate,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	).catch(() => unavailable());
	try {
		const before = await handle.stat();
		if (
			!before.isFile() ||
			before.ino !== info.ino ||
			before.dev !== info.dev ||
			before.nlink !== 1 ||
			before.mode & 0o222 ||
			before.size !== input.sizeBytes
		)
			unavailable();
		const bytes = Buffer.alloc(input.maximumBytes + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(
				bytes,
				offset,
				bytes.length - offset,
				offset,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const after = await handle.stat();
		const currentInfo = await lstat(candidate);
		if (
			offset !== input.sizeBytes ||
			!currentInfo.isFile() ||
			currentInfo.ino !== before.ino ||
			currentInfo.dev !== before.dev ||
			currentInfo.nlink !== before.nlink ||
			currentInfo.size !== before.size ||
			after.ino !== before.ino ||
			after.dev !== before.dev ||
			after.nlink !== before.nlink ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			createHash("sha256").update(bytes.subarray(0, offset)).digest("hex") !==
				input.sha256
		)
			unavailable();
		return Uint8Array.from(bytes.subarray(0, offset));
	} finally {
		await handle.close();
	}
}

/** Read verified bytes from the Worker-mounted, read-only Hub generation. */
export function createFilesystemRuntimeSkillDirectoryV1(input: {
	readonly root: string;
	readonly agentId: string;
	readonly agentVersion: string;
	readonly generationId: string;
	readonly projections: readonly unknown[];
	readonly maximumResourceBytes?: number;
}) {
	const parsed = input.projections.map((projection) => {
		const value = SkillWorkloadProjectionV1Schema.parse(projection);
		if (
			value.agentId !== input.agentId ||
			value.agentVersion !== input.agentVersion
		)
			unavailable();
		return value;
	});
	const byName = new Map(
		parsed.map((projection) => [projection.manifest.name, projection]),
	);
	const directory = createRuntimeSkillDirectoryV1(input);
	return {
		generationId: directory.generationId,
		findSkills: directory.findSkills,
		async readSkill(name: string, relativePath: string): Promise<Uint8Array> {
			const projection = byName.get(name);
			const file = projection?.manifest.files.find(
				(entry) => entry.path === relativePath,
			);
			if (!projection || !file) unavailable();
			return directory.readSkill(name, relativePath, async (request) =>
				readMountedSkillFile({
					root: input.root,
					path: `${request.skill.targetPath}/${request.relativePath}`,
					sizeBytes: file.sizeBytes,
					sha256: file.sha256,
					maximumBytes: request.maximumBytes,
				}),
			);
		},
	};
}
