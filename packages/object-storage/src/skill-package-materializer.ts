import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import {
	parseSkillPackagePublicationObjectV1,
	type SkillPackagePublicationObjectV1,
} from "@agent-infra/platform-core";
import { prepareSkillPackageV1 } from "./skill-package-admission.js";

export type SkillPackageObjectReadV1 = SkillPackagePublicationObjectV1 &
	Readonly<{ bytes: Uint8Array }>;
export type SkillPackageMaterializationInputV1 = Readonly<{
	name: string;
	version: string;
	packageObject: SkillPackagePublicationObjectV1;
	packageDigest: string;
	manifestDigest: string;
}>;
/** Physical files only; Worker Applied, read-only mounts and availability are separate facts. */
export type SkillPackageMaterializationResultV1 = Readonly<{
	schemaVersion: 1;
	status: "materialized";
	generationId: string;
	packages: readonly SkillPackageMaterializationInputV1[];
}>;
export type SkillPackageMaterializationDetailsV1 = Readonly<{
	result: SkillPackageMaterializationResultV1;
	packages: readonly {
		readonly input: SkillPackageMaterializationInputV1;
		readonly manifest: ReturnType<typeof prepareSkillPackageV1>["manifest"];
		readonly manifestDigest: string;
	}[];
}>;
export class SkillPackageMaterializerErrorV1 extends Error {
	constructor(readonly code: "invalid" | "unavailable" | "conflict") {
		super("Skill package materialization failed");
		this.name = "SkillPackageMaterializerErrorV1";
	}
}
function fail(code: SkillPackageMaterializerErrorV1["code"]): never {
	throw new SkillPackageMaterializerErrorV1(code);
}
const maximumManifestBytes = 2000 * (512 + 64 + 128) + 1024;

const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown) => Buffer.from(JSON.stringify(value));

function object(
	input: unknown,
	keys: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		!input ||
		typeof input !== "object" ||
		types.isProxy(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input))
	)
		fail("invalid");
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (
		Reflect.ownKeys(input).length < keys.length ||
		Reflect.ownKeys(input).length > keys.length + optional.length ||
		keys.some(
			(key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]),
		) ||
		Reflect.ownKeys(input).some(
			(key) =>
				typeof key !== "string" ||
				(!keys.includes(key) && !optional.includes(key)),
		)
	)
		fail("invalid");
	return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
}
function array(input: unknown, maximum: number): unknown[] {
	if (
		!Array.isArray(input) ||
		types.isProxy(input) ||
		Object.getPrototypeOf(input) !== Array.prototype ||
		input.length > maximum ||
		Reflect.ownKeys(input).length !== input.length + 1
	)
		fail("invalid");
	return Array.from({ length: input.length }, (_, index) => {
		const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
		if (!descriptor?.enumerable || !("value" in descriptor)) fail("invalid");
		return descriptor.value;
	});
}
function snapshotPackages(
	input: unknown,
): readonly SkillPackageMaterializationInputV1[] {
	const names = new Set<string>();
	const packages = array(input, 10).map((entry) => {
		const value = object(entry, [
			"name",
			"version",
			"packageObject",
			"packageDigest",
			"manifestDigest",
		]);
		if (
			typeof value.name !== "string" ||
			!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.name) ||
			typeof value.version !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.version) ||
			typeof value.packageDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.packageDigest) ||
			typeof value.manifestDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.manifestDigest)
		)
			fail("invalid");
		if (names.has(value.name)) fail("invalid");
		names.add(value.name);
		const packageObject = parseSkillPackagePublicationObjectV1(
			value.packageObject,
		);
		if (
			packageObject.mediaType !== "application/zip" ||
			packageObject.sha256 !== value.packageDigest
		)
			fail("invalid");
		return Object.freeze({
			name: value.name,
			version: value.version,
			packageObject,
			packageDigest: value.packageDigest,
			manifestDigest: value.manifestDigest,
		});
	});
	return Object.freeze(
		packages.toSorted((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		),
	);
}
function receipt(
	packages: readonly SkillPackageMaterializationInputV1[],
): SkillPackageMaterializationResultV1 {
	return Object.freeze({
		schemaVersion: 1,
		status: "materialized",
		generationId: sha(canonical({ schemaVersion: 1, packages })),
		packages,
	});
}
async function syncDirectory(path: string) {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function persistFile(path: string, bytes: Uint8Array, mode: number) {
	const handle = await open(
		path,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		mode,
	);
	try {
		await handle.writeFile(bytes);
		await handle.chmod(mode);
		await handle.sync();
	} finally {
		await handle.close();
	}
}
// Only this invocation's private staging tree; never touch retained generations.
async function removeStaging(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) fail("conflict");
	await chmod(path, 0o700);
	for (const entry of await readdir(path, { withFileTypes: true })) {
		if (entry.isDirectory()) await removeStaging(join(path, entry.name));
		else await rm(join(path, entry.name), { force: true });
	}
	await rm(path, { recursive: true });
}

async function readRegular(path: string, maximum: number, readonly: boolean) {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (
			!info.isFile() ||
			info.nlink !== 1 ||
			info.size > maximum ||
			(readonly && info.mode & 0o222)
		)
			fail("conflict");
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}
async function seal(path: string, root = false) {
	for (const entry of await readdir(path, { withFileTypes: true })) {
		if (entry.isDirectory()) await seal(join(path, entry.name));
		else if (!entry.isFile()) fail("conflict");
	}
	if (!root) await chmod(path, 0o555);
	await syncDirectory(path);
}
async function directory(path: string, readonly: boolean) {
	const info = await lstat(path);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		(readonly && info.mode & 0o222)
	)
		fail("conflict");
}
async function files(path: string, prefix = ""): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(path, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			await directory(join(path, entry.name), true);
			result.push(
				...(await files(join(path, entry.name), `${prefix}${entry.name}/`)),
			);
		} else if (entry.isFile()) result.push(`${prefix}${entry.name}`);
		else fail("conflict");
	}
	return result.toSorted();
}
const indexBytes = (packages: readonly SkillPackageMaterializationInputV1[]) =>
	Buffer.from(
		[
			"# Skills",
			"",
			...packages.map(
				(value) => `- ${value.name}@${value.version} (${value.packageDigest})`,
			),
			"",
		].join("\n"),
	);

/** Deployment-owned physical adapter. One existing Worker/fence owns this assembly root. */
export class SkillPackageMaterializerV1 {
	readonly #root: string;
	readonly #identity: { dev: number; ino: number };
	readonly #readPackage;
	readonly #verifyAdmission;
	constructor(options: {
		/** Pre-provisioned 0700 root outside the Runtime-writable project; never request data. */
		readonly assemblyRoot: string;
		readonly runtimeUid: number;
		readonly readPackage: (
			object: SkillPackagePublicationObjectV1,
		) => Promise<SkillPackageObjectReadV1>;
		/** Existing trusted supplier/current authorization check, not caller admission claims. */
		readonly verifyAdmission: (
			input: SkillPackageMaterializationInputV1,
		) => Promise<void>;
	}) {
		try {
			if (
				typeof options.assemblyRoot !== "string" ||
				!isAbsolute(options.assemblyRoot) ||
				!Number.isSafeInteger(options.runtimeUid) ||
				options.runtimeUid <= 0 ||
				options.runtimeUid === process.geteuid?.() ||
				typeof options.readPackage !== "function" ||
				typeof options.verifyAdmission !== "function"
			)
				fail("invalid");
			const path = resolve(options.assemblyRoot);
			const info = lstatSync(path);
			if (
				!info.isDirectory() ||
				info.isSymbolicLink() ||
				info.uid !== process.geteuid?.() ||
				(info.mode & 0o777) !== 0o700
			)
				fail("conflict");
			this.#root = realpathSync(path);
			// A private leaf is insufficient when an untrusted identity can replace its ancestors.
			for (let parent = dirname(this.#root); ; parent = dirname(parent)) {
				const ancestor = lstatSync(parent);
				if (
					!ancestor.isDirectory() ||
					ancestor.isSymbolicLink() ||
					![0, process.geteuid?.()].includes(ancestor.uid) ||
					((ancestor.mode & 0o022) !== 0 && (ancestor.mode & 0o1000) === 0)
				)
					fail("conflict");
				if (parent === dirname(parent)) break;
			}
			this.#identity = { dev: info.dev, ino: info.ino };
			this.#readPackage = options.readPackage;
			this.#verifyAdmission = options.verifyAdmission;
		} catch (error) {
			if (error instanceof SkillPackageMaterializerErrorV1) throw error;
			fail("invalid");
		}
	}
	async #assertRoot() {
		const info = await lstat(this.#root);
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			info.dev !== this.#identity.dev ||
			info.ino !== this.#identity.ino ||
			info.uid !== process.geteuid?.() ||
			(info.mode & 0o777) !== 0o700
		)
			fail("conflict");
	}
	async #readGenerationDetails(
		generationId: string,
	): Promise<SkillPackageMaterializationDetailsV1> {
		if (!/^[a-f0-9]{64}$/.test(generationId)) fail("conflict");
		await this.#assertRoot();
		const root = join(this.#root, "generations", generationId);
		await directory(join(this.#root, "generations"), false);
		await directory(root, false);
		const metaBytes = await readRegular(
			join(root, "MATERIALIZATION.json"),
			1000000,
			true,
		);
		const meta = object(JSON.parse(metaBytes.toString("utf8")), [
			"schemaVersion",
			"status",
			"generationId",
			"packages",
		]);
		const result = receipt(snapshotPackages(meta.packages));
		if (
			meta.schemaVersion !== 1 ||
			meta.status !== "materialized" ||
			meta.generationId !== generationId ||
			result.generationId !== generationId ||
			!metaBytes.equals(canonical(result))
		)
			fail("conflict");
		const agents = join(root, ".agents");
		await directory(agents, true);
		await directory(join(agents, "skills"), true);
		await directory(join(root, "manifests"), true);
		if (
			!(await readRegular(join(agents, "SKILLS.md"), 100000, true)).equals(
				indexBytes(result.packages),
			)
		)
			fail("conflict");
		const actualFiles = await files(join(agents, "skills"));
		const expected: string[] = [];
		const details: Array<
			SkillPackageMaterializationDetailsV1["packages"][number]
		> = [];
		for (const input of result.packages) {
			const manifestBytes = await readRegular(
				join(root, "manifests", `${input.name}.json`),
				maximumManifestBytes,
				true,
			);
			if (sha(manifestBytes) !== input.manifestDigest) fail("conflict");
			const manifest = JSON.parse(manifestBytes.toString("utf8"));
			// These exact canonical bytes were produced from the validated ZIP before publication.
			if (
				!manifestBytes.equals(canonical(manifest)) ||
				manifest.name !== input.name ||
				manifest.version !== input.version ||
				manifest.entryPath !== "SKILL.md" ||
				manifest.packageDigest !== input.packageDigest
			)
				fail("conflict");
			for (const file of array(manifest.files, 2000)) {
				const value = object(file, ["path", "sizeBytes", "sha256"]);
				if (
					typeof value.path !== "string" ||
					!/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value.path) ||
					value.path.split("/").some((part) => part === "." || part === "..") ||
					typeof value.sizeBytes !== "number" ||
					!Number.isSafeInteger(value.sizeBytes) ||
					value.sizeBytes < 0 ||
					value.sizeBytes > 50000000
				)
					fail("conflict");
				expected.push(`${input.name}/${value.path}`);
				const bytes = await readRegular(
					join(agents, "skills", input.name, value.path),
					value.sizeBytes,
					true,
				);
				if (bytes.length !== value.sizeBytes || sha(bytes) !== value.sha256)
					fail("conflict");
			}
			details.push({
				input,
				manifest,
				manifestDigest: input.manifestDigest,
			});
		}
		if (JSON.stringify(actualFiles) !== JSON.stringify(expected.toSorted()))
			fail("conflict");
		// A process may have exited after the generation rename, before sealing its root.
		await chmod(root, 0o555);
		await syncDirectory(root);
		return Object.freeze({ result, packages: Object.freeze(details) });
	}
	async #readGeneration(generationId: string) {
		return (await this.#readGenerationDetails(generationId)).result;
	}
	async readCurrent(): Promise<SkillPackageMaterializationResultV1 | null> {
		try {
			await this.#assertRoot();
			let bytes: Buffer;
			try {
				bytes = await readRegular(join(this.#root, "CURRENT.json"), 128, true);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
			const value = object(JSON.parse(bytes.toString("utf8")), [
				"schemaVersion",
				"generationId",
			]);
			if (
				value.schemaVersion !== 1 ||
				typeof value.generationId !== "string" ||
				!bytes.equals(canonical(value))
			)
				fail("conflict");
			return await this.#readGeneration(value.generationId);
		} catch (error) {
			if (error instanceof SkillPackageMaterializerErrorV1) throw error;
			fail("unavailable");
		}
	}
	async readCurrentDetails(): Promise<SkillPackageMaterializationDetailsV1 | null> {
		try {
			await this.#assertRoot();
			let bytes: Buffer;
			try {
				bytes = await readRegular(join(this.#root, "CURRENT.json"), 128, true);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
			const value = object(JSON.parse(bytes.toString("utf8")), [
				"schemaVersion",
				"generationId",
			]);
			if (
				value.schemaVersion !== 1 ||
				typeof value.generationId !== "string" ||
				!bytes.equals(canonical(value))
			)
				fail("conflict");
			return await this.#readGenerationDetails(value.generationId);
		} catch (error) {
			if (error instanceof SkillPackageMaterializerErrorV1) throw error;
			fail("unavailable");
		}
	}
	async materialize(
		input: unknown,
	): Promise<SkillPackageMaterializationResultV1> {
		let packages: readonly SkillPackageMaterializationInputV1[];
		let expectedGenerationId: string | null | undefined;
		try {
			const request = object(input, ["packages"], ["expectedGenerationId"]);
			packages = snapshotPackages(request.packages);
			expectedGenerationId = request.expectedGenerationId as
				| string
				| null
				| undefined;
			if (
				expectedGenerationId !== undefined &&
				expectedGenerationId !== null &&
				(typeof expectedGenerationId !== "string" ||
					!/^[a-f0-9]{64}$/.test(expectedGenerationId))
			)
				fail("invalid");
		} catch (error) {
			if (error instanceof SkillPackageMaterializerErrorV1) throw error;
			fail("invalid");
		}
		let staging: string | undefined;
		let temporary: string | undefined;
		try {
			await this.#assertRoot();
			const prepared: {
				input: SkillPackageMaterializationInputV1;
				value: ReturnType<typeof prepareSkillPackageV1>;
			}[] = [];
			for (const input of packages) {
				await this.#verifyAdmission(input);
				const stored = await this.#readPackage(input.packageObject);
				const { bytes, ...descriptor } = object(stored, [
					"objectRef",
					"version",
					"etag",
					"sizeBytes",
					"mediaType",
					"sha256",
					"bytes",
				]);
				const metadata = parseSkillPackagePublicationObjectV1(descriptor);
				if (
					JSON.stringify(metadata) !== JSON.stringify(input.packageObject) ||
					!(bytes instanceof Uint8Array) ||
					types.isProxy(bytes) ||
					bytes.buffer instanceof SharedArrayBuffer ||
					bytes.length !== metadata.sizeBytes
				)
					fail("conflict");
				const archiveBytes = Uint8Array.from(bytes);
				if (sha(archiveBytes) !== metadata.sha256) fail("conflict");
				const value = prepareSkillPackageV1({
					archiveBytes,
					name: input.name,
					version: input.version,
				});
				if (sha(value.manifestBytes) !== input.manifestDigest) fail("conflict");
				prepared.push({ input, value });
			}
			const result = receipt(packages);
			await this.#assertRoot();
			const generations = join(this.#root, "generations");
			try {
				await mkdir(generations, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			await directory(generations, false);
			const generation = join(generations, result.generationId);
			let exists = false;
			try {
				await lstat(generation);
				exists = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (!exists) {
				staging = join(this.#root, `.staging-${randomUUID()}`);
				const agents = join(staging, ".agents");
				await mkdir(join(agents, "skills"), { recursive: true, mode: 0o700 });
				await mkdir(join(staging, "manifests"), { mode: 0o700 });
				for (const { input, value } of prepared) {
					for (const file of value.files) {
						const target = join(agents, "skills", input.name, file.path);
						await mkdir(dirname(target), { recursive: true, mode: 0o700 });
						await persistFile(target, file.bytes, 0o444);
					}
					await persistFile(
						join(staging, "manifests", `${input.name}.json`),
						value.manifestBytes,
						0o444,
					);
				}
				await persistFile(
					join(agents, "SKILLS.md"),
					indexBytes(packages),
					0o444,
				);
				await persistFile(
					join(staging, "MATERIALIZATION.json"),
					canonical(result),
					0o444,
				);
				await seal(staging, true);
				await this.#assertRoot();
				try {
					await rename(staging, generation);
					staging = undefined;
				} catch (error) {
					if (
						!["EEXIST", "ENOTEMPTY"].includes(
							(error as NodeJS.ErrnoException).code ?? "",
						)
					)
						throw error;
				}
			}
			if (staging) {
				await removeStaging(staging);
				staging = undefined;
			}
			await this.#readGeneration(result.generationId);
			await syncDirectory(generations);
			// Persist the generations parent entry before CURRENT can select it.
			await syncDirectory(this.#root);
			for (const input of packages) await this.#verifyAdmission(input);
			await this.#assertRoot();
			if (expectedGenerationId !== undefined) {
				const current = await this.readCurrent();
				if ((current?.generationId ?? null) !== expectedGenerationId)
					fail("conflict");
			}
			temporary = join(this.#root, `.current-${randomUUID()}`);
			await persistFile(
				temporary,
				canonical({ schemaVersion: 1, generationId: result.generationId }),
				0o444,
			);
			await rename(temporary, join(this.#root, "CURRENT.json"));
			temporary = undefined;
			await syncDirectory(this.#root);
			// Never delete a published generation: old Execution/mount references may still consume it.
			// Abandoned staging is private and never selected; retries build or validate the fixed generation.
			return result;
		} catch (error) {
			const abandoned = staging;
			const pendingPointer = temporary;
			await this.#assertRoot()
				.then(async () => {
					if (abandoned) await removeStaging(abandoned);
					if (pendingPointer) await rm(pendingPointer, { force: true });
				})
				.catch(() => {});
			if (error instanceof SkillPackageMaterializerErrorV1) throw error;
			fail("unavailable");
		}
	}
}
