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
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

// The source is the ONLY untrusted mount. Nothing is executed from it. Publication is one rename.
async function walk(source: string, destination?: string) {
	const hash = createHash("sha256");
	const links: string[] = [];
	const visit = async (dir: string, prefix: string) => {
		for (const name of (await readdir(dir)).sort()) {
			const path = join(dir, name);
			const entry = join(prefix, name);
			const out = destination && join(destination, entry);
			const info = await lstat(path);
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
					const reader = createReadStream("", {
						fd: file.fd,
						autoClose: false,
					});
					reader.on("data", (chunk) => digest.update(chunk));
					if (out) {
						const dst = await open(
							out,
							"wx",
							info.mode & 0o111 ? 0o755 : 0o644,
						);
						try {
							await pipeline(
								reader,
								dst.createWriteStream({ autoClose: true }),
							);
						} finally {
							await dst.close();
						}
					} else
						for await (const chunk of reader) {
							void chunk;
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
	if (prior) return prior;
	const temp = join(root, `.pending-${randomUUID()}`);
	const files = join(temp, "files");
	await mkdir(files, { recursive: true });
	try {
		const digest = await walk(source, files);
		if ((await walk(source)) !== digest)
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
	await publishMaintenanceView("/source", "/views", process.argv[2] ?? "");
