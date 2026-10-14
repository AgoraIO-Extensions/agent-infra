import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
	SkillHubSyncBindingV1Schema,
	SkillWorkloadProjectionV1Schema,
} from "@agent-infra/contracts";

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

export interface RuntimeFilesystemSkillDirectoryV1 {
	readonly generationId: string;
	/** Fixed deployment-owned root used only by native launch adapters. */
	readonly nativeRoot?: string;
	findSkills(): readonly RuntimeSkillDirectoryEntryV1[];
	/** Absolute entry files derived from the verified projection, never caller input. */
	nativeSkillPaths?(): readonly string[];
	readSkill(name: string, relativePath: string): Promise<Uint8Array>;
}

export class RuntimeSkillDirectoryErrorV1 extends Error {
	readonly code = "RUNTIME_SKILL_DIRECTORY_UNAVAILABLE" as const;

	constructor() {
		super("Runtime Skill directory is unavailable");
		this.name = "RuntimeSkillDirectoryErrorV1";
	}
}

/** Bound an asynchronous mounted Skill read to the request's cancellation/deadline. */
export async function boundedRuntimeSkillRead<T>(input: {
	pending: Promise<T>;
	signal: AbortSignal;
	expiresAt: number;
}): Promise<T> {
	if (input.signal.aborted || input.expiresAt <= Date.now()) {
		void input.pending.catch(() => {});
		unavailable();
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<T>((resolve, reject) => {
			const finish = (work: () => void) => {
				if (timer !== undefined) clearTimeout(timer);
				if (onAbort) input.signal.removeEventListener("abort", onAbort);
				work();
			};
			onAbort = () => finish(() => reject(new RuntimeSkillDirectoryErrorV1()));
			timer = setTimeout(
				() => finish(() => reject(new RuntimeSkillDirectoryErrorV1())),
				Math.max(0, input.expiresAt - Date.now()),
			);
			input.signal.addEventListener("abort", onAbort, { once: true });
			void input.pending.then(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			);
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort) input.signal.removeEventListener("abort", onAbort);
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

/**
 * Bind Runtime discovery to the same Applied Skill Hub facts that Worker
 * persisted. Pending or stale bindings never become a Runtime directory.
 */
export function createAppliedRuntimeSkillDirectoryV1(input: {
	readonly agentId: string;
	readonly agentVersion: string;
	readonly configurationRevision: number;
	readonly generationId: string;
	readonly projections: readonly unknown[];
	readonly appliedBindings: readonly unknown[];
	readonly maximumResourceBytes?: number;
}) {
	if (
		!Number.isSafeInteger(input.configurationRevision) ||
		input.configurationRevision < 1 ||
		!Array.isArray(input.appliedBindings) ||
		input.appliedBindings.length > maxSkills ||
		!Array.isArray(input.projections) ||
		input.projections.length > maxSkills
	)
		unavailable();
	const bindings = input.appliedBindings.map((value) => {
		const parsed = SkillHubSyncBindingV1Schema.safeParse(value);
		if (!parsed.success || parsed.data.state !== "synced") unavailable();
		const binding = parsed.data;
		const receipt = binding.appliedReceipt;
		if (
			binding.agentId !== input.agentId ||
			binding.agentVersion !== input.agentVersion ||
			binding.configurationRevision !== input.configurationRevision ||
			receipt.generationId !== input.generationId ||
			receipt.targetPath !== `.agents/skills/${binding.skillName}` ||
			receipt.skillVersionId !== binding.skillVersion.skillVersionId ||
			receipt.packageDigest !== binding.skillVersion.packageDigest ||
			receipt.manifestDigest !== binding.skillVersion.manifestDigest
		)
			unavailable();
		return binding;
	});
	const projectionByVersion = new Map<string, unknown>();
	for (const value of input.projections) {
		const projection = SkillWorkloadProjectionV1Schema.safeParse(value);
		if (
			!projection.success ||
			projection.data.agentId !== input.agentId ||
			projection.data.agentVersion !== input.agentVersion ||
			projection.data.manifest.packageDigest !==
				projection.data.skillVersion.packageDigest
		)
			unavailable();
		if (projectionByVersion.has(projection.data.skillVersion.skillVersionId))
			unavailable();
		projectionByVersion.set(
			projection.data.skillVersion.skillVersionId,
			projection.data,
		);
	}
	if (bindings.length !== projectionByVersion.size) unavailable();
	for (const binding of bindings) {
		const projection = projectionByVersion.get(
			binding.skillVersion.skillVersionId,
		);
		if (!projection) unavailable();
		const value = projection as {
			readonly manifest: {
				readonly name: string;
				readonly packageDigest: string;
			};
			readonly skillVersion: {
				readonly packageDigest: string;
				readonly manifestDigest: string;
			};
			readonly grant: unknown;
		};
		if (
			value.manifest.name !== binding.skillName ||
			value.skillVersion.packageDigest !== binding.skillVersion.packageDigest ||
			value.skillVersion.manifestDigest !==
				binding.skillVersion.manifestDigest ||
			JSON.stringify(value.grant) !== JSON.stringify(binding.grant)
		)
			unavailable();
	}
	return createRuntimeSkillDirectoryV1({
		agentId: input.agentId,
		agentVersion: input.agentVersion,
		generationId: input.generationId,
		projections: [...projectionByVersion.values()],
		maximumResourceBytes: input.maximumResourceBytes,
	});
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
}): RuntimeFilesystemSkillDirectoryV1 {
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
	const nativeRoot = resolve(input.root);
	return {
		generationId: directory.generationId,
		nativeRoot,
		findSkills: directory.findSkills,
		nativeSkillPaths(): readonly string[] {
			const resolvedRoot = realpathSync(nativeRoot);
			return directory.findSkills().map((entry) => {
				const path = resolve(nativeRoot, entry.targetPath, "SKILL.md");
				const relativePath = relative(nativeRoot, path);
				if (
					relativePath === "" ||
					relativePath.startsWith("..") ||
					isAbsolute(relativePath)
				)
					unavailable();
				const projection = byName.get(entry.name);
				const file = projection?.manifest.files.find(
					(value) => value.path === projection.manifest.entryPath,
				);
				if (projection?.manifest.entryPath !== "SKILL.md" || !file)
					unavailable();
				const stat = lstatSync(path);
				if (!stat.isFile() || stat.isSymbolicLink()) unavailable();
				const actualPath = realpathSync(path);
				const actualRelativePath = relative(resolvedRoot, actualPath);
				if (
					actualRelativePath === "" ||
					actualRelativePath.startsWith("..") ||
					isAbsolute(actualRelativePath)
				)
					unavailable();
				const bytes = readFileSync(path);
				if (
					bytes.byteLength !== file.sizeBytes ||
					createHash("sha256").update(bytes).digest("hex") !== file.sha256
				)
					unavailable();
				return actualPath;
			});
		},
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
