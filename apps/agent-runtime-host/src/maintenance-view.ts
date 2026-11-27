import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
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
async function walk(source: string, boundAt: number, destination?: string) {
	const hash = createHash("sha256");
	const links: string[] = [];
	const checkCut = (ctime: number) => {
		if (ctime > boundAt)
			throw new Error("Deployment was changed after Session admission");
	};
	const visit = async (dir: string, prefix: string) => {
		const directory = await open(dir, constants.O_DIRECTORY);
		try {
			checkCut((await directory.stat()).ctimeMs);
		} finally {
			await directory.close();
		}
		for (const name of (await readdir(dir)).sort()) {
			const path = join(dir, name);
			const entry = join(prefix, name);
			const out = destination && join(destination, entry);
			const info = await lstat(path);
			checkCut(info.ctimeMs);
			hash.update(JSON.stringify([entry, info.mode & 0o777]));
			if (info.isDirectory()) {
				hash.update("d");
				if (out) await mkdir(out, { mode: 0o755 });
				const fd = await open(
					path,
					constants.O_DIRECTORY | constants.O_NOFOLLOW,
				);
				try {
					await visit(`/proc/self/fd/${fd.fd}`, entry);
				} finally {
					await fd.close();
				}
			} else if (info.isFile()) {
				const file = await open(
					path,
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					const before = await file.stat();
					if (!before.isFile()) throw new Error("Source changed");
					const digest = createHash("sha256");
					const destinationFile = out
						? await open(out, "wx", info.mode & 0o111 ? 0o755 : 0o644)
						: undefined;
					try {
						const reader = createReadStream("", {
							fd: file.fd,
							autoClose: false,
						});
						for await (const chunk of reader) {
							const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
							if (destinationFile) await destinationFile.writeFile(bytes);
							digest.update(bytes);
						}
					} finally {
						await destinationFile?.close();
					}

					const after = await file.stat();
					if (before.size !== after.size || before.ctimeMs !== after.ctimeMs)
						throw new Error("Source changed");
					hash.update(`f${digest.digest("hex")}`);
				} finally {
					await file.close();
				}
			} else if (info.isSymbolicLink()) {
				const target = await readlink(path);
				if (isAbsolute(target))
					throw new Error("Absolute link in deployment source");
				hash.update(`l${JSON.stringify(target)}`);
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

export async function publishMaintenanceView(
	source: string,
	views: string,
	sandboxId: string,
	boundAt = Number.MAX_SAFE_INTEGER,
) {
	if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sandboxId))
		throw new Error("Invalid Sandbox binding");
	if (!Number.isSafeInteger(boundAt) || boundAt <= 0)
		throw new Error("Invalid binding time");
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
	if (prior) return prior;
	const temp = join(views, `.pending-${randomUUID()}`);
	const files = join(temp, "files");
	await mkdir(files, { recursive: true });
	try {
		const digest = await walk(source, boundAt, files);
		if ((await walk(source, boundAt)) !== digest)
			throw new Error("Deployment changed during snapshot");
		await writeFile(join(temp, "sha256"), digest, { mode: 0o444 });
		try {
			await rename(temp, published);
		} catch (error) {
			const other = await existing();
			if (other) return other;
			throw error;
		}
		return digest;
	} finally {
		await rm(temp, { force: true, recursive: true });
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	await writeFile(
		"/dev/termination-log",
		await publishMaintenanceView(
			"/source",
			"/views",
			process.argv[2] ?? "",
			Number(process.argv[3]),
		),
	);
