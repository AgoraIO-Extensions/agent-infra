import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import type { ObjectStorageDataV1 } from "@agent-infra/object-storage";
import type { WorkspaceSnapshotRecordV1 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";

import {
	createWorkspaceSnapshotServiceV1,
	WorkspaceSnapshotServiceErrorV1,
} from "./workspace-snapshot-service.js";

type SnapshotOwner = {
	kind: "user" | "application";
	id: string;
	scopes: readonly string[];
};

function header(name: string, size: number, type: string) {
	const value = Buffer.alloc(512);
	value.write(name, 0, "utf8");
	value.write(`00000000000${size.toString(8)}`.slice(-11), 124, "ascii");
	value[156] = type.charCodeAt(0);
	value.write("        ", 148, "ascii");
	let checksum = 0;
	for (const byte of value) checksum += byte;
	value.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return value;
}
function archive(content = "hello") {
	const data = Buffer.from(content);
	return gzipSync(
		Buffer.concat([
			header("root/", 0, "5"),
			header("root/repo.txt", data.byteLength, "0"),
			data,
			Buffer.alloc((512 - (data.byteLength % 512)) % 512),
			Buffer.alloc(1024),
		]),
	);
}
function stream(bytes: Buffer) {
	return Readable.toWeb(Readable.from(bytes)) as ReadableStream<Uint8Array>;
}
function fixture(options: { owner?: string; failCreate?: boolean } = {}) {
	const bytes = archive();
	const digest = createHash("sha256").update(bytes).digest("hex");
	const principal = {
		kind: "user" as const,
		id: options.owner ?? "u1",
		scopes: ["agent:create", "agent:read", "agent:manage"],
	};
	const record = new Map<string, WorkspaceSnapshotRecordV1>();
	const removed: string[] = [];
	const storage = {
		upload: vi.fn(
			async (_request: Parameters<ObjectStorageDataV1["upload"]>[0]) => ({
				version: "v1",
				etag: "e",
				sha256: digest,
				sizeBytes: bytes.length,
				mediaType: "application/x-tar+gzip",
			}),
		),
		remove: vi.fn(async (objectRef: string) => {
			removed.push(objectRef);
		}),
	};
	const store = {
		findIdempotency: vi.fn(async () => null),
		create: vi.fn(async (r: WorkspaceSnapshotRecordV1) => {
			if (options.failCreate) throw new Error("db");
			record.set(r.snapshotId, r);
			return r;
		}),
		list: vi.fn(async () => [...record.values()]),
		get: vi.fn(
			async (_owner: SnapshotOwner, id: string) => record.get(id) ?? null,
		),
		remove: vi.fn(async (_owner: SnapshotOwner, id: string) => {
			const value = record.get(id);
			if (!value) throw new Error("missing");
			return value;
		}),
	};
	const service = createWorkspaceSnapshotServiceV1({
		credentials: {
			resolve: vi.fn(async (material: string) =>
				material === "good" ? principal : null,
			),
		},
		spool: {
			spool: vi.fn(async (_body: ReadableStream<Uint8Array>) => ({
				sizeBytes: bytes.length,
				replay: () => stream(bytes),
				dispose: async () => {},
			})),
		},
		storage,
		store,
		quota: {
			read: async () => ({
				ownerStoredBytes: 0,
				agentArchiveBytes: 0,
				agentUnpackedBytes: 0,
				agentBindingCount: 0,
			}),
		},
	});
	return { service, bytes, digest, storage, store, removed };
}

describe("workspace snapshot service boundary", () => {
	it("resolves owner and produces deterministic metadata", async () => {
		const f = fixture();
		const result = await f.service.upload({
			material: "good",
			idempotencyKey: "k1",
			digest: `sha256:${f.digest}`,
			source: { kind: "direct-upload" },
			body: stream(f.bytes),
		});
		expect(result.replayed).toBe(false);
		expect(result.record.ownerId).toBe("u1");
		expect(f.storage.upload).toHaveBeenCalledOnce();
	});
	it("rejects unknown owners and digest mismatch", async () => {
		const f = fixture();
		await expect(f.service.list("bad")).rejects.toBeInstanceOf(
			WorkspaceSnapshotServiceErrorV1,
		);
		await expect(
			f.service.upload({
				material: "good",
				idempotencyKey: "k1",
				digest: `sha256:${"0".repeat(64)}`,
				source: { kind: "direct-upload" },
				body: stream(f.bytes),
			}),
		).rejects.toBeInstanceOf(WorkspaceSnapshotServiceErrorV1);
	});
	it("cleans the object when metadata persistence fails", async () => {
		const f = fixture({ failCreate: true });
		await expect(
			f.service.upload({
				material: "good",
				idempotencyKey: "k1",
				digest: `sha256:${f.digest}`,
				source: { kind: "direct-upload" },
				body: stream(f.bytes),
			}),
		).rejects.toBeInstanceOf(WorkspaceSnapshotServiceErrorV1);
		expect(f.removed).toHaveLength(1);
	});
});
