import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { WorkspaceSnapshotSpoolV1 } from "./workspace-snapshot-service.js";

export class WorkspaceSnapshotSpoolErrorV1 extends Error {
	constructor(
		readonly code:
			| "invalid_input"
			| "limit_exceeded"
			| "busy"
			| "aborted"
			| "unavailable",
	) {
		super(`Workspace snapshot spool ${code}`);
		this.name = "WorkspaceSnapshotSpoolErrorV1";
	}
}

/** Each retained spool consumes one slot until its owner disposes it. */
export function createWorkspaceSnapshotFileSpoolV1(
	options: {
		readonly directory?: string;
		readonly maximumActiveSpools?: number;
	} = {},
): WorkspaceSnapshotSpoolV1 {
	const maximumActiveSpools = options.maximumActiveSpools ?? 2;
	if (!Number.isSafeInteger(maximumActiveSpools) || maximumActiveSpools < 1)
		throw new WorkspaceSnapshotSpoolErrorV1("invalid_input");
	let activeSpools = 0;
	return {
		async spool(body, maxBytes, request) {
			const signal = request?.signal;
			if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
				throw new WorkspaceSnapshotSpoolErrorV1("invalid_input");
			if (signal?.aborted) {
				void body.cancel().catch(() => undefined);
				throw new WorkspaceSnapshotSpoolErrorV1("aborted");
			}
			if (activeSpools >= maximumActiveSpools) {
				void body.cancel().catch(() => undefined);
				throw new WorkspaceSnapshotSpoolErrorV1("busy");
			}
			activeSpools += 1;
			let directory: string | undefined;
			let retained = false;
			try {
				directory = await mkdtemp(
					join(options.directory ?? tmpdir(), "agent-infra-snapshot-"),
				);
				await chmod(directory, 0o700);
				const file = join(directory, "archive.tar.gz");
				let sizeBytes = 0;
				await pipeline(
					Readable.fromWeb(body),
					new Transform({
						transform(chunk: Buffer, _encoding, callback) {
							if (chunk.length > maxBytes - sizeBytes) {
								callback(new WorkspaceSnapshotSpoolErrorV1("limit_exceeded"));
								return;
							}
							sizeBytes += chunk.length;
							callback(null, chunk);
						},
					}),
					createWriteStream(file, { flags: "wx", mode: 0o600 }),
					{ signal },
				);
				if (sizeBytes === 0)
					throw new WorkspaceSnapshotSpoolErrorV1("invalid_input");
				const readers = new Set<ReadStream>();
				let disposal: Promise<void> | undefined;
				const ownedDirectory = directory;
				retained = true;
				return {
					sizeBytes,
					replay() {
						if (disposal)
							throw new WorkspaceSnapshotSpoolErrorV1("unavailable");
						if (signal?.aborted)
							throw new WorkspaceSnapshotSpoolErrorV1("aborted");
						const source = createReadStream(file, { signal });
						readers.add(source);
						source.once("close", () => readers.delete(source));
						return Readable.toWeb(source) as ReadableStream<Uint8Array>;
					},
					dispose() {
						if (!disposal) {
							disposal = (async () => {
								try {
									await Promise.all(
										[...readers].map(async (source) => {
											const closed = finished(source).catch(() => undefined);
											source.destroy();
											await closed;
										}),
									);
									await rm(ownedDirectory, { recursive: true, force: true });
								} catch {
									throw new WorkspaceSnapshotSpoolErrorV1("unavailable");
								} finally {
									activeSpools -= 1;
								}
							})();
						}
						return disposal;
					},
				};
			} catch (error) {
				if (directory) {
					try {
						await rm(directory, { recursive: true, force: true });
					} catch {
						throw new WorkspaceSnapshotSpoolErrorV1("unavailable");
					}
				}
				if (error instanceof WorkspaceSnapshotSpoolErrorV1) throw error;
				throw new WorkspaceSnapshotSpoolErrorV1(
					signal?.aborted ? "aborted" : "unavailable",
				);
			} finally {
				if (!retained) activeSpools -= 1;
			}
		},
	};
}
