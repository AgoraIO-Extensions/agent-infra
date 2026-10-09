import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	parseSkillPackagePublicationObjectV1,
	type SkillPackagePublicationObjectV1,
} from "@agent-infra/platform-core";
import { prepareSkillPackageV1 } from "./skill-package-admission.js";

const namePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;

export type SkillPackageObjectReadV1 = Readonly<{
	readonly bytes: Uint8Array;
	readonly objectRef: string;
	readonly version: string;
	readonly etag: string;
	readonly sizeBytes: number;
	readonly mediaType: "application/zip";
	readonly sha256: string;
}>;

export type SkillPackageMaterializationInputV1 = Readonly<{
	readonly name: string;
	readonly version: string;
	readonly packageObject: SkillPackagePublicationObjectV1;
	readonly packageDigest: string;
	readonly manifestDigest: string;
}>;

export type SkillPackageMaterializationResultV1 = Readonly<{
	schemaVersion: 1;
	readOnly: true;
	packages: readonly {
		readonly name: string;
		readonly version: string;
		readonly packageDigest: string;
		readonly manifestDigest: string;
	}[];
}>;

export class SkillPackageMaterializerErrorV1 extends Error {
	constructor(readonly code: "invalid" | "unavailable" | "conflict") {
		super("Skill package materialization failed");
		this.name = "SkillPackageMaterializerErrorV1";
	}
}

type Prepared = Readonly<{
	input: SkillPackageMaterializationInputV1;
	manifest: ReturnType<typeof prepareSkillPackageV1>["manifest"];
	manifestDigest: string;
	files: ReturnType<typeof prepareSkillPackageV1>["files"];
}>;

function digest(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}

function validObjectVersion(value: string) {
	return (
		value.length > 0 &&
		value !== "null" &&
		value.isWellFormed() &&
		new TextEncoder().encode(value).byteLength <= 1024
	);
}

function validateInput(input: SkillPackageMaterializationInputV1) {
	if (
		typeof input.name !== "string" ||
		typeof input.version !== "string" ||
		typeof input.packageDigest !== "string" ||
		typeof input.manifestDigest !== "string" ||
		!input ||
		typeof input !== "object" ||
		!input.packageObject ||
		typeof input.packageObject !== "object"
	)
		throw new SkillPackageMaterializerErrorV1("invalid");
	parseSkillPackagePublicationObjectV1(input.packageObject);
	if (
		!namePattern.test(input.name) ||
		!versionPattern.test(input.version) ||
		!digestPattern.test(input.packageDigest) ||
		!digestPattern.test(input.manifestDigest) ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
			input.packageObject.objectRef,
		) ||
		!validObjectVersion(input.packageObject.version) ||
		input.packageObject.etag.length === 0 ||
		input.packageObject.etag.length > 256 ||
		input.packageObject.etag.includes("\0") ||
		!Number.isSafeInteger(input.packageObject.sizeBytes) ||
		input.packageObject.sizeBytes < 0 ||
		input.packageObject.sizeBytes > 50_000_000 ||
		input.packageObject.mediaType !== "application/zip" ||
		!digestPattern.test(input.packageObject.sha256)
	)
		throw new SkillPackageMaterializerErrorV1("invalid");
}

async function safeDirectory(path: string) {
	try {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new SkillPackageMaterializerErrorV1("conflict");
	} catch (error) {
		if (error instanceof SkillPackageMaterializerErrorV1) throw error;
		await mkdir(path, { recursive: true, mode: 0o755 });
	}
}

async function makeTreeReadOnly(path: string): Promise<void> {
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isSymbolicLink())
			throw new SkillPackageMaterializerErrorV1("invalid");
		if (entry.isDirectory()) {
			await makeTreeReadOnly(child);
			await chmod(child, 0o555);
		} else if (entry.isFile()) {
			await chmod(child, 0o444);
		} else {
			throw new SkillPackageMaterializerErrorV1("invalid");
		}
	}
}

async function makeTreeWritable(path: string): Promise<void> {
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isSymbolicLink())
			throw new SkillPackageMaterializerErrorV1("invalid");
		if (entry.isDirectory()) {
			await chmod(child, 0o755);
			await makeTreeWritable(child);
		} else if (entry.isFile()) {
			await chmod(child, 0o644);
		}
	}
	await chmod(path, 0o755);
}

async function assertExistingSafe(path: string, directory: boolean) {
	try {
		const info = await lstat(path);
		if (
			info.isSymbolicLink() ||
			(directory ? !info.isDirectory() : !info.isFile())
		)
			throw new SkillPackageMaterializerErrorV1("conflict");
	} catch (error) {
		if (error instanceof SkillPackageMaterializerErrorV1) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export class SkillPackageMaterializerV1 {
	readonly #projectRoot: string;
	readonly #readPackage: (
		input: SkillPackagePublicationObjectV1,
	) => Promise<SkillPackageObjectReadV1>;
	readonly #verifyAdmission: (
		input: SkillPackageMaterializationInputV1,
	) => Promise<void>;

	constructor(options: {
		readonly projectRoot: string;
		/** Reads the fixed object version after admission revalidation. */
		readonly readPackage: (
			input: SkillPackagePublicationObjectV1,
		) => Promise<SkillPackageObjectReadV1>;
		/** Rechecks current publication, signature, scan, revocation and grant facts. */
		readonly verifyAdmission: (
			input: SkillPackageMaterializationInputV1,
		) => Promise<void>;
	}) {
		if (!isAbsolute(options.projectRoot))
			throw new SkillPackageMaterializerErrorV1("invalid");
		this.#projectRoot = resolve(options.projectRoot);
		this.#readPackage = options.readPackage;
		this.#verifyAdmission = options.verifyAdmission;
	}

	async materialize(input: {
		readonly packages: readonly SkillPackageMaterializationInputV1[];
	}): Promise<SkillPackageMaterializationResultV1> {
		if (
			!input ||
			typeof input !== "object" ||
			!Array.isArray(input.packages) ||
			input.packages.length > 10
		)
			throw new SkillPackageMaterializerErrorV1("invalid");
		let packages: SkillPackageMaterializationInputV1[];
		try {
			packages = input.packages.map((packageInput) => {
				validateInput(packageInput);
				const parsedObject = parseSkillPackagePublicationObjectV1(
					packageInput.packageObject,
				);
				return {
					...packageInput,
					packageObject: parsedObject,
				};
			});
		} catch (error) {
			if (error instanceof SkillPackageMaterializerErrorV1) throw error;
			throw new SkillPackageMaterializerErrorV1("invalid");
		}
		const names = new Set<string>();
		const prepared: Prepared[] = [];
		try {
			for (const packageInput of packages) {
				if (names.has(packageInput.name))
					throw new SkillPackageMaterializerErrorV1("conflict");
				names.add(packageInput.name);
				await this.#verifyAdmission(packageInput);
				const stored = await this.#readPackage(packageInput.packageObject);
				const archiveBytes = stored.bytes;
				if (
					!(archiveBytes instanceof Uint8Array) ||
					archiveBytes.buffer instanceof SharedArrayBuffer ||
					stored.objectRef !== packageInput.packageObject.objectRef ||
					stored.version !== packageInput.packageObject.version ||
					stored.etag !== packageInput.packageObject.etag ||
					stored.sizeBytes !== packageInput.packageObject.sizeBytes ||
					stored.mediaType !== packageInput.packageObject.mediaType ||
					stored.sha256 !== packageInput.packageObject.sha256 ||
					archiveBytes.byteLength !== stored.sizeBytes ||
					digest(archiveBytes) !== stored.sha256
				)
					throw new SkillPackageMaterializerErrorV1("conflict");
				const value = prepareSkillPackageV1({
					archiveBytes: Uint8Array.from(archiveBytes),
					name: packageInput.name,
					version: packageInput.version,
				});
				const manifestDigest = digest(value.manifestBytes);
				if (
					value.packageDigest !== packageInput.packageDigest ||
					manifestDigest !== packageInput.manifestDigest
				)
					throw new SkillPackageMaterializerErrorV1("conflict");
				await this.#verifyAdmission(packageInput);
				prepared.push({
					input: packageInput,
					manifest: value.manifest,
					manifestDigest,
					files: value.files,
				});
			}
		} catch (error) {
			if (error instanceof SkillPackageMaterializerErrorV1) throw error;
			throw new SkillPackageMaterializerErrorV1("unavailable");
		}

		const agentsRoot = join(this.#projectRoot, ".agents");
		const skillsRoot = join(agentsRoot, "skills");
		const stageRoot = join(agentsRoot, `.skills-staging-${randomUUID()}`);
		const stageSkills = join(stageRoot, "skills");
		const stageIndex = join(stageRoot, "SKILLS.md");
		const oldSkills = `${skillsRoot}.old-${randomUUID()}`;
		const oldIndex = `${join(agentsRoot, "SKILLS.md")}.old-${randomUUID()}`;
		let oldSkillsMoved = false;
		let oldIndexMoved = false;
		let installed = false;
		let indexInstalled = false;
		try {
			await safeDirectory(agentsRoot);
			await mkdir(stageSkills, { recursive: true, mode: 0o755 });
			for (const packageValue of prepared) {
				const destination = join(stageSkills, packageValue.input.name);
				await mkdir(destination, { recursive: true, mode: 0o755 });
				for (const file of packageValue.files) {
					const filePath = join(destination, file.path);
					const relativePath = relative(destination, filePath);
					if (relativePath.startsWith("..") || isAbsolute(relativePath))
						throw new SkillPackageMaterializerErrorV1("invalid");
					await mkdir(join(filePath, ".."), { recursive: true, mode: 0o755 });
					await writeFile(filePath, file.bytes, { mode: 0o444 });
				}
			}
			await makeTreeReadOnly(stageSkills);
			const index = [
				"# Skills",
				"",
				...prepared
					.map(
						(packageValue) =>
							`- ${packageValue.input.name}@${packageValue.input.version} (${packageValue.input.packageDigest})`,
					)
					.toSorted(),
				"",
			].join("\n");
			await writeFile(stageIndex, index, { mode: 0o444 });
			await chmod(stageIndex, 0o444);
			for (const packageInput of packages)
				await this.#verifyAdmission(packageInput);
			await assertExistingSafe(skillsRoot, true);
			await assertExistingSafe(join(agentsRoot, "SKILLS.md"), false);
			await renameIfPresent(skillsRoot, oldSkills);
			oldSkillsMoved = true;
			await renameIfPresent(join(agentsRoot, "SKILLS.md"), oldIndex);
			oldIndexMoved = true;
			await rename(stageSkills, skillsRoot);
			installed = true;
			await chmod(skillsRoot, 0o555);
			await rename(stageIndex, join(agentsRoot, "SKILLS.md"));
			indexInstalled = true;
			await makeTreeWritable(oldSkills).catch(() => {});
			await rm(oldSkills, { recursive: true, force: true });
			await rm(oldIndex, { force: true });
			await rm(stageRoot, { recursive: true, force: true });
		} catch (error) {
			await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
			if (indexInstalled)
				await rm(join(agentsRoot, "SKILLS.md"), { force: true }).catch(
					() => {},
				);
			if (installed) {
				await makeTreeWritable(skillsRoot).catch(() => {});
				await rm(skillsRoot, { recursive: true, force: true }).catch(() => {});
			}
			if (oldSkillsMoved)
				await renameIfPresent(oldSkills, skillsRoot).catch(() => {});
			if (oldIndexMoved)
				await renameIfPresent(oldIndex, join(agentsRoot, "SKILLS.md")).catch(
					() => {},
				);
			if (error instanceof SkillPackageMaterializerErrorV1) throw error;
			throw new SkillPackageMaterializerErrorV1("unavailable");
		}
		return {
			schemaVersion: 1,
			readOnly: true,
			packages: prepared.map((packageValue) => ({
				name: packageValue.input.name,
				version: packageValue.input.version,
				packageDigest: packageValue.input.packageDigest,
				manifestDigest: packageValue.manifestDigest,
			})),
		};
	}
}

async function renameIfPresent(source: string, destination: string) {
	try {
		await rename(source, destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
