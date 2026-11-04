import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { validateWorkspaceSnapshotArchiveV1 } from "@agent-infra/platform-core";
import type { WorkspaceSnapshotMaterializerInputV1 } from "./workspace-snapshot-materializer.js";

const execute = promisify(execFile);
const marker = ".snapshot-digest";
export class WorkspaceSnapshotMaterializationError extends Error {
	constructor() {
		super("WORKSPACE_SNAPSHOT_MATERIALIZATION_FAILED");
	}
}
export class WorkspaceSnapshotRollbackError extends WorkspaceSnapshotMaterializationError {
	constructor() {
		super();
		this.message = "WORKSPACE_SNAPSHOT_ROLLBACK_FAILED";
	}
}

async function removeTemporary(path: string) {
	try {
		await rm(path, { recursive: true, force: true });
	} catch {
		throw new WorkspaceSnapshotMaterializationError();
	}
}

async function exists(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
async function normalizeModes(path: string): Promise<void> {
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		const stat = await lstat(child);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			await normalizeModes(child);
			await chmod(child, 0o755);
		} else if (stat.isFile())
			await chmod(child, stat.mode & 0o111 ? 0o755 : 0o644);
		else throw new WorkspaceSnapshotMaterializationError();
	}
}

/** Only the trusted init container can write this volume; business mounts are read-only. */
export async function materializeWorkspaceSnapshotV1(input: {
	snapshot: WorkspaceSnapshotMaterializerInputV1;
	outputDirectory: string;
	allowedOrigins: readonly string[];
	signal: AbortSignal;
	maxArchiveBytes: number;
	maxUnpackedBytes: number;
	fetch?: typeof fetch;
}) {
	let temporary: string | undefined;
	let previous: { path: string; destination: string } | undefined;
	try {
		const s = input.snapshot;
		if (
			!isAbsolute(input.outputDirectory) ||
			!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(s.name) ||
			!/^sha256:[a-f0-9]{64}$/.test(s.digest) ||
			!Number.isSafeInteger(s.sizeBytes) ||
			s.sizeBytes <= 0 ||
			!Number.isSafeInteger(input.maxArchiveBytes) ||
			input.maxArchiveBytes <= 0 ||
			s.sizeBytes > input.maxArchiveBytes ||
			!Number.isSafeInteger(input.maxUnpackedBytes) ||
			input.maxUnpackedBytes <= 0
		)
			throw new Error();
		const url = new URL(s.signedUrl);
		const expiry = Date.parse(s.expiresAt);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			!input.allowedOrigins.includes(url.origin) ||
			!Number.isFinite(expiry) ||
			expiry <= Date.now() ||
			expiry > Date.now() + 900000
		)
			throw new Error();
		const root = await lstat(input.outputDirectory);
		if (!root.isDirectory() || root.isSymbolicLink()) throw new Error();
		const destination = join(input.outputDirectory, s.name);
		const old = await exists(destination);
		if (old && (!old.isDirectory() || old.isSymbolicLink())) throw new Error();
		const stamp = await exists(join(destination, marker));
		if (stamp && (!stamp.isFile() || stamp.isSymbolicLink() || stamp.size > 80))
			throw new Error();
		if (
			stamp &&
			(await readFile(join(destination, marker), "utf8")).trim() === s.digest
		)
			return { status: "reused" as const, digest: s.digest };
		input.signal.throwIfAborted();
		temporary = await mkdtemp(join(input.outputDirectory, ".snapshot-stage-"));
		const response = await (input.fetch ?? fetch)(url, {
			redirect: "error",
			credentials: "omit",
			signal: input.signal,
		});
		if (!response.ok || response.redirected || !response.body)
			throw new Error();
		const archivePath = join(temporary, "archive.tar.gz");
		let bytes = 0;
		await pipeline(
			Readable.fromWeb(response.body),
			new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					bytes += chunk.length;
					if (bytes > input.maxArchiveBytes || bytes > s.sizeBytes) {
						callback(new WorkspaceSnapshotMaterializationError());
						return;
					}
					callback(null, chunk);
				},
			}),
			createWriteStream(archivePath, { mode: 0o600, flags: "wx" }),
			{ signal: input.signal },
		);
		if (bytes !== s.sizeBytes) throw new Error();
		await validateWorkspaceSnapshotArchiveV1(
			Readable.toWeb(
				createReadStream(archivePath),
			) as ReadableStream<Uint8Array>,
			s.digest,
			{
				maxArchiveBytes: input.maxArchiveBytes,
				maxUnpackedBytes: input.maxUnpackedBytes,
			},
		);
		const stage = join(temporary, "content");
		await mkdir(stage, { mode: 0o700 });
		// Full graph validation above rejects extraction through links and extended metadata.
		await execute(
			"tar",
			[
				"-xzf",
				archivePath,
				"--strip-components=1",
				"--no-same-owner",
				"--no-same-permissions",
				"-C",
				stage,
			],
			{ signal: input.signal, timeout: 60000, maxBuffer: 4096 },
		);
		if (await exists(join(stage, marker))) throw new Error();
		await normalizeModes(stage);
		await writeFile(join(stage, marker), `${s.digest}\n`, {
			mode: 0o644,
			flag: "wx",
		});
		await chmod(stage, 0o755);
		input.signal.throwIfAborted();
		if (old) {
			const path = join(temporary, "previous");
			await rename(destination, path);
			previous = { path, destination };
		}
		try {
			await rename(stage, destination);
		} catch (error) {
			if (previous) {
				try {
					await rename(previous.path, previous.destination);
				} catch {
					throw new WorkspaceSnapshotRollbackError();
				}
				previous = undefined;
			}
			throw error;
		}
		previous = undefined;
		return { status: "materialized" as const, digest: s.digest };
	} catch (error) {
		if (error instanceof WorkspaceSnapshotRollbackError) throw error;
		throw new WorkspaceSnapshotMaterializationError();
	} finally {
		if (temporary) await removeTemporary(temporary);
	}
}
