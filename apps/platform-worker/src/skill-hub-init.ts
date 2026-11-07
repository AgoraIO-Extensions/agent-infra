import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const fail = (): never => {
	throw new Error("SKILL_MATERIALIZATION_FAILED");
};
type FileEntry = {
	key: string;
	path: string;
	sizeBytes: number;
	sha256: string;
};

async function seal(root: string) {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.isDirectory()) await seal(join(root, entry.name));
		else if (!entry.isFile()) fail();
	}
	await chmod(root, 0o555);
}

async function verify(root: string, files: readonly FileEntry[]) {
	const actual: string[] = [];
	async function walk(directory: string, prefix = "") {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o222)
			fail();
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = `${prefix}${entry.name}`;
			if (entry.isDirectory())
				await walk(join(directory, entry.name), `${path}/`);
			else if (entry.isFile()) actual.push(path);
			else fail();
		}
	}
	await walk(root);
	if (
		JSON.stringify(actual.sort()) !==
		JSON.stringify(files.map((file) => file.path).sort())
	)
		fail();
	for (const file of files) {
		const handle = await open(
			join(root, file.path),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			const info = await handle.stat();
			if (
				!info.isFile() ||
				info.nlink !== 1 ||
				info.mode & 0o222 ||
				info.size !== file.sizeBytes
			)
				fail();
			const bytes = await handle.readFile();
			if (bytes.length !== file.sizeBytes || sha(bytes) !== file.sha256) fail();
		} finally {
			await handle.close();
		}
	}
}

/** The expected digest comes from the Worker-owned Pod shape, never the package. */
export async function materializeSkillHubDeliveryV1(
	source: string,
	destination: string,
	expectedDigest: string,
) {
	if (!/^[a-f0-9]{64}$/.test(expectedDigest)) fail();
	const raw = await readFile(join(source, "manifest.json"));
	if (raw.length > 512 * 1024 || sha(raw) !== expectedDigest) fail();
	const manifest = JSON.parse(raw.toString("utf8"));
	if (
		manifest.schemaVersion !== 1 ||
		!Array.isArray(manifest.files) ||
		manifest.files.length < 2 ||
		manifest.files.length > 2001
	)
		fail();
	const files = manifest.files as FileEntry[];
	let total = 0;
	for (const [i, file] of files.entries()) {
		if (
			!file ||
			file.key !== `file-${i}` ||
			typeof file.path !== "string" ||
			!/^([a-f0-9]{64})$/.test(file.sha256) ||
			!Number.isSafeInteger(file.sizeBytes) ||
			file.sizeBytes < 0 ||
			(file.path !== "SKILLS.md" &&
				!/^skills\/[a-z0-9][a-z0-9._-]{0,62}\/(SKILL\.md|(?:scripts|references|assets)\/.+)$/.test(
					file.path,
				)) ||
			file.path
				.split("/")
				.some(
					(part) =>
						!part ||
						part === "." ||
						part === ".." ||
						part.includes("\\") ||
						[...part].some(
							(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
						),
				)
		)
			fail();
		total += file.sizeBytes;
	}
	if (
		total > 512 * 1024 ||
		new Set(files.map((file) => file.path)).size !== files.length
	)
		fail();
	const root = join(destination, ".agents");
	try {
		await lstat(root);
		await verify(root, files);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const staging = join(destination, `.skill-staging-${randomUUID()}`);
	await mkdir(staging, { mode: 0o700 });
	try {
		for (const file of files) {
			const bytes = await readFile(join(source, file.key));
			if (bytes.length !== file.sizeBytes || sha(bytes) !== file.sha256) fail();
			const target = join(staging, file.path);
			await mkdir(dirname(target), { recursive: true, mode: 0o700 });
			const handle = await open(
				target,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o444,
			);
			try {
				await handle.writeFile(bytes);
				await handle.chmod(0o444);
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
		await seal(staging);
		await verify(staging, files);
		await rename(staging, root);
		await verify(root, files);
	} finally {
		// Only this invocation's staging tree is disposable; retain a published generation.
		async function removeStaging(path: string) {
			try {
				await chmod(path, 0o700);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
			for (const entry of await readdir(path, { withFileTypes: true }))
				if (entry.isDirectory()) await removeStaging(join(path, entry.name));
			await rm(path, { recursive: true });
		}
		await removeStaging(staging);
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		await materializeSkillHubDeliveryV1(
			"/run/skill-hub",
			"/materialized",
			process.argv[2] ?? "",
		);
		console.info(
			JSON.stringify({ service: "skill-materializer", status: "materialized" }),
		);
	} catch {
		console.error(
			JSON.stringify({
				service: "skill-materializer",
				code: "SKILL_MATERIALIZATION_FAILED",
			}),
		);
		process.exitCode = 1;
	}
}
