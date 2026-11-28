import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// The source is the ONLY untrusted mount. Nothing is executed from it. Publication is one rename.
async function readSource<T>(operation: Promise<T>, copying: boolean) {
	try {
		return await operation;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// An editor may rename, replace or unlink an entry after readdir().
		if (
			copying &&
			["ENOENT", "ENOTDIR", "EINVAL", "ELOOP"].includes(code ?? "")
		)
			return undefined;
		throw error;
	}
}

async function walk(source: string, destination?: string) {
	const hash = createHash("sha256");
	const links: string[] = [];
	const copying = destination !== undefined;
	const visit = async (dir: string, prefix: string) => {
		for (const name of (await readdir(dir)).sort()) {
			const path = join(dir, name);
			const entry = join(prefix, name);
			const out = destination && join(destination, entry);
			const info = await readSource(lstat(path), copying);
			if (!info) continue;
			if (info.isDirectory()) {
				const fd = await readSource(
					open(path, constants.O_DIRECTORY | constants.O_NOFOLLOW),
					copying,
				);
				if (!fd) continue;
				try {
					if (out) await mkdir(out, { mode: 0o755 });
					hash.update(JSON.stringify([entry, false]) + "d");
					await visit(`/proc/self/fd/${fd.fd}`, entry);
				} finally {
					await fd.close();
				}
			} else if (info.isFile()) {
				const file = await readSource(
					open(
						path,
						constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
					),
					copying,
				);
				if (!file) continue;
				try {
					const actual = await file.stat();
					if (!actual.isFile()) continue;
					const executable = Boolean(actual.mode & 0o111);
					const digest = createHash("sha256");
					const output = out
						? await open(out, "wx", executable ? 0o755 : 0o644)
						: undefined;
					try {
						const reader = createReadStream("", {
							fd: file.fd,
							autoClose: false,
						});
						for await (const chunk of reader) {
							const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
							if (output) await output.writeFile(bytes);
							digest.update(bytes);
						}
					} finally {
						await output?.close();
					}
					hash.update(
						JSON.stringify([entry, executable]) + "f" + digest.digest("hex"),
					);
				} finally {
					await file.close();
				}
			} else if (info.isSymbolicLink()) {
				const target = await readSource(readlink(path), copying);
				if (target === undefined) continue;
				if (isAbsolute(target))
					throw new Error("Absolute link in deployment source");
				hash.update(
					JSON.stringify([entry, false]) + "l" + JSON.stringify(target),
				);
				if (out) {
					await symlink(target, out);
					links.push(out);
				}
			} else throw new Error("Unsupported entry in deployment source");
		}
	};
	await visit(source, "");
	if (destination) {
		const root = await realpath(destination);
		for (const link of links) {
			const rel = relative(root, await realpath(link));
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
				throw new Error("Link escapes deployment view");
		}
	}
	return hash.digest("hex");
}

// Both links refer to the file captured in the immutable, Agent-scoped snapshot.
async function linkPublishedFile(source: string, target: string) {
	const info = await lstat(source);
	if (!info.isFile()) throw new Error("Original project file unavailable");
	try {
		await link(source, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const current = await lstat(target);
		if (
			!current.isFile() ||
			current.dev !== info.dev ||
			current.ino !== info.ino
		)
			throw new Error("Original project file unavailable");
	}
}

async function publishedEntry(path: string) {
	return lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
}

// A prewarmed Pod keeps this directory mounted while its Worker publishes the snapshot.
type NativeProject = "claude" | "opencode" | "pi";
async function projectInstructions(root: string, template: NativeProject) {
	const filename = template === "claude" ? "CLAUDE.md" : "AGENTS.md";
	const folder = join(root, `${template}-project`);
	await mkdir(folder, { recursive: true });
	const published = join(root, "published");
	const files = join(published, "files");
	const document = join(files, filename);
	if ((await publishedEntry(document))?.isFile())
		await linkPublishedFile(document, join(folder, filename));
	const source = join(files, ".agents", "skills");
	if (
		!(await publishedEntry(join(files, ".agents")))?.isDirectory() ||
		!(await publishedEntry(source))?.isDirectory()
	)
		return;
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(source, entry.name, "SKILL.md");
		if (!(await publishedEntry(path))?.isFile()) continue;
		const target = join(folder, ".agents", "skills", entry.name);
		await mkdir(target, { recursive: true });
		await linkPublishedFile(path, join(target, "SKILL.md"));
	}
	if (await publishedEntry(join(folder, ".agents")))
		await linkPublishedFile(
			join(published, "sha256"),
			join(folder, ".agents", "sha256"),
		);
}

export async function verifyMaintenanceView(
	views: string,
	sandboxId: string,
	expected: string,
	nativeProject?: NativeProject,
) {
	if (
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sandboxId) ||
		!/^([a-f0-9]{64})$/.test(expected)
	)
		throw new Error("Invalid view identity");
	const path = join(views, sandboxId, "published");
	if (
		(await readFile(join(path, "sha256"), "utf8")) !== expected ||
		(await walk(join(path, "files"))) !== expected
	)
		throw new Error("Original deployment view unavailable");
	if (nativeProject)
		await projectInstructions(join(views, sandboxId), nativeProject);
	return expected;
}

export async function publishMaintenanceView(
	source: string,
	views: string,
	sandboxId: string,
	nativeProject?: NativeProject,
) {
	if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sandboxId))
		throw new Error("Invalid Sandbox binding");
	const root = join(views, sandboxId);
	const published = join(root, "published");
	const receipt = join(published, "sha256");
	await mkdir(root, { recursive: true });
	async function existing() {
		try {
			const hash = await readFile(receipt, "utf8");
			if (!/^[a-f0-9]{64}$/.test(hash))
				throw new Error("Invalid deployment view");
			return hash;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	const prior = await existing();
	if (prior)
		return verifyMaintenanceView(views, sandboxId, prior, nativeProject);
	const temp = join(views, `.pending-${randomUUID()}`);
	const files = join(temp, "files");
	await mkdir(files, { recursive: true });
	try {
		const digest = await walk(source, files);
		await writeFile(join(temp, "sha256"), digest, { mode: 0o444 });
		try {
			await rename(temp, published);
		} catch (error) {
			const other = await existing();
			if (other)
				return verifyMaintenanceView(views, sandboxId, other, nativeProject);
			throw error;
		}
		if (nativeProject) await projectInstructions(root, nativeProject);
		return digest;
	} finally {
		await rm(temp, { force: true, recursive: true });
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const nativeProject =
		process.argv[2] === "--claude-native"
			? "claude"
			: process.argv[2] === "--opencode-native"
				? "opencode"
				: process.argv[2] === "--pi-native"
					? "pi"
					: undefined;
	const [sandboxId = "", digest] = process.argv.slice(nativeProject ? 3 : 2);
	await writeFile(
		"/dev/termination-log",
		digest
			? await verifyMaintenanceView("/views", sandboxId, digest, nativeProject)
			: await publishMaintenanceView(
					"/source",
					"/views",
					sandboxId,
					nativeProject,
				),
	);
}
