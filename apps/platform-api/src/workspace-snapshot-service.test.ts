import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ObjectStorageDataV1 } from "@agent-infra/object-storage";
import {
	WorkspaceSnapshotErrorV1,
	type WorkspaceSnapshotRecordV1,
} from "@agent-infra/platform-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWorkspaceSnapshotServiceV1,
	type WorkspaceSnapshotPrincipalV1,
	type WorkspaceSnapshotServiceStoreV1,
} from "./workspace-snapshot-service.js";
import { createWorkspaceSnapshotFileSpoolV1 } from "./workspace-snapshot-spool.js";

function header(name: string, size: number, type: string) {
	const value = Buffer.alloc(512);
	value.write(name, 0, "utf8");
	value.write(size.toString(8).padStart(11, "0"), 124, "ascii");
	value[156] = type.charCodeAt(0);
	value.write("ustar\0", 257, "ascii");
	value.write("00", 263, "ascii");
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
			header("root/repo.txt", data.length, "0"),
			data,
			Buffer.alloc((512 - (data.length % 512)) % 512),
			Buffer.alloc(1024),
		]),
	);
}
function stream(bytes: Buffer) {
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset === bytes.length) {
				controller.close();
				return;
			}
			const end = Math.min(bytes.length, offset + 17);
			controller.enqueue(bytes.subarray(offset, end));
			offset = end;
		},
	});
}
function digest(bytes: Uint8Array) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function ownerKey(owner: WorkspaceSnapshotPrincipalV1, key: string) {
	return JSON.stringify([owner.kind, owner.id, key]);
}
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "snapshot-service-test-"));
	directories.push(directory);
	const principals: Record<string, WorkspaceSnapshotPrincipalV1> = {
		alice: {
			kind: "user",
			id: "same-id",
			scopes: ["agent:create", "agent:read", "agent:manage"],
		},
		app: {
			kind: "application",
			id: "same-id",
			scopes: ["agent:create", "agent:read", "agent:manage"],
		},
		bob: {
			kind: "user",
			id: "bob",
			scopes: ["agent:create", "agent:read", "agent:manage"],
		},
		readOnly: { kind: "user", id: "same-id", scopes: ["agent:read"] },
	};
	const records = new Map<string, WorkspaceSnapshotRecordV1>();
	const idempotency = new Map<
		string,
		{ requestDigest: string; record: WorkspaceSnapshotRecordV1 }
	>();
	const objects = new Map<string, { version: string; bytes: Buffer }>();
	const storage = {
		upload: vi.fn(
			async (request: Parameters<ObjectStorageDataV1["upload"]>[0]) => {
				expect(request.objectRef).toMatch(/^[a-f0-9-]{36}$/);
				const bytes = Buffer.from(
					await new Response(request.body).arrayBuffer(),
				);
				expect(request.descriptor.sha256).toBe(digest(bytes).slice(7));
				expect(request.descriptor.sizeBytes).toBe(bytes.length);
				const version: string = randomUUID();
				objects.set(request.objectRef, { version, bytes });
				return {
					version,
					etag: "etag",
					sha256: digest(bytes).slice(7),
					sizeBytes: bytes.length,
					mediaType: request.descriptor.mediaType,
				};
			},
		),
		remove: vi.fn(async (ref: string, version: string) => {
			if (objects.get(ref)?.version === version) objects.delete(ref);
		}),
	};
	const matches = (
		record: WorkspaceSnapshotRecordV1,
		owner: WorkspaceSnapshotPrincipalV1,
	) => record.ownerId === owner.id && record.ownerType === owner.kind;
	const store = {
		findIdempotency: vi.fn(
			async (owner: WorkspaceSnapshotPrincipalV1, key: string) =>
				idempotency.get(ownerKey(owner, key)) ?? null,
		),
		create: vi.fn(
			async (
				record: WorkspaceSnapshotRecordV1,
				owner: WorkspaceSnapshotPrincipalV1,
				key: string,
				requestDigest: string,
			) => {
				const original = idempotency.get(ownerKey(owner, key));
				if (original) {
					if (original.requestDigest !== requestDigest)
						throw new WorkspaceSnapshotErrorV1("conflict");
					return original.record;
				}
				records.set(record.snapshotId, record);
				idempotency.set(ownerKey(owner, key), { requestDigest, record });
				return record;
			},
		),
		list: vi.fn(async (owner: WorkspaceSnapshotPrincipalV1) =>
			[...records.values()].filter((record) => matches(record, owner)),
		),
		get: vi.fn(async (owner: WorkspaceSnapshotPrincipalV1, id: string) => {
			const record = records.get(id);
			return record && matches(record, owner) ? record : null;
		}),
		remove: vi.fn(async (owner: WorkspaceSnapshotPrincipalV1, id: string) => {
			const record = records.get(id);
			if (!record || !matches(record, owner))
				throw new WorkspaceSnapshotErrorV1("not_found");
			return record;
		}),
	} satisfies WorkspaceSnapshotServiceStoreV1;
	let ownerStoredBytes = 0;
	const options = {
		credentials: {
			resolve: vi.fn(async (material: string) => principals[material] ?? null),
		},
		spool: createWorkspaceSnapshotFileSpoolV1({
			directory,
			maximumActiveSpools: 4,
		}),
		storage,
		store,
		quota: {
			read: vi.fn(async () => ({
				ownerStoredBytes,
				agentArchiveBytes: Number.MAX_SAFE_INTEGER,
				agentUnpackedBytes: Number.MAX_SAFE_INTEGER,
				agentBindingCount: 100,
			})),
		},
	};
	const service = createWorkspaceSnapshotServiceV1(options);
	const upload = (material = "alice", content = "hello", key = "k1") => {
		const bytes = archive(content);
		return {
			material,
			body: stream(bytes),
			source: { kind: "direct-upload" },
			digest: digest(bytes),
			idempotencyKey: key,
		};
	};
	return {
		directory,
		options,
		service,
		upload,
		store,
		storage,
		objects,
		idempotency,
		records,
		setOwnerUsage: (bytes: number) => {
			ownerStoredBytes = bytes;
		},
	};
}

describe("workspace snapshot upload service with real file spool", () => {
	it("validates and uploads the supplied bytes using a UUID object key", async () => {
		const f = await fixture();
		const result = await f.service.upload(f.upload());
		expect(result).toMatchObject({
			replayed: false,
			record: { ownerId: "same-id", ownerType: "user", status: "ready" },
		});
		expect(f.objects.get(result.record.objectRef)?.bytes).toEqual(archive());
		expect(f.store.create).toHaveBeenCalledOnce();
		expect(await readdir(f.directory)).toEqual([]);
	});

	it("validates body bytes on replay and rejects changed content or forged digest", async () => {
		const f = await fixture();
		const first = await f.service.upload(f.upload());
		expect(await f.service.upload(f.upload())).toEqual({
			record: first.record,
			replayed: true,
		});
		await expect(
			f.service.upload({
				...f.upload(),
				body: stream(archive("different bytes")),
			}),
		).rejects.toMatchObject({ code: "invalid_archive" });
		await expect(
			f.service.upload(f.upload("alice", "different bytes")),
		).rejects.toMatchObject({ code: "conflict" });
		expect(f.storage.upload).toHaveBeenCalledOnce();
		expect(await readdir(f.directory)).toEqual([]);
	});

	it("isolates users and applications with the same id and key and enforces operation scopes", async () => {
		const f = await fixture();
		const user = await f.service.upload(f.upload());
		const app = await f.service.upload(f.upload("app"));
		expect(user.record.snapshotId).not.toBe(app.record.snapshotId);
		expect(await f.service.get("bob", user.record.snapshotId)).toBeNull();
		expect(await f.service.get("app", user.record.snapshotId)).toBeNull();
		expect(await f.service.list("app")).toEqual([app.record]);
		await expect(
			f.service.remove("bob", user.record.snapshotId),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(f.service.upload(f.upload("readOnly"))).rejects.toMatchObject({
			code: "forbidden",
		});
		await expect(f.service.list("unknown")).rejects.toMatchObject({
			code: "authentication_required",
		});
	});

	it("enforces owner storage quota without using unrelated Agent binding usage", async () => {
		const f = await fixture();
		await f.service.upload(f.upload());
		f.setOwnerUsage(10 * 1024 ** 3);
		await expect(
			f.service.upload(f.upload("alice", "new", "k2")),
		).rejects.toMatchObject({ code: "quota_exceeded" });
		expect(f.storage.upload).toHaveBeenCalledOnce();
		expect((await f.service.upload(f.upload())).replayed).toBe(true);
		expect(await readdir(f.directory)).toEqual([]);
	});

	it("replays a concurrent commit that fills the owner quota after the initial read", async () => {
		const f = await fixture();
		const original = await f.service.upload(f.upload());
		f.setOwnerUsage(10 * 1024 ** 3);
		f.store.findIdempotency.mockResolvedValueOnce(null);
		expect(await f.service.upload(f.upload())).toEqual({
			record: original.record,
			replayed: true,
		});
		expect(f.storage.upload).toHaveBeenCalledOnce();
	});

	it("cleans only the redundant exact object version when concurrent uploads replay", async () => {
		const f = await fixture();
		const create = f.store.create.getMockImplementation();
		if (!create) throw new Error("missing fixture create");
		let arrivals = 0;
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.store.create.mockImplementation(async (...args) => {
			if (++arrivals === 2) release();
			await barrier;
			return create(...args);
		});
		const results = await Promise.all([
			f.service.upload(f.upload()),
			f.service.upload(f.upload()),
		]);
		expect(results[0]?.record.snapshotId).toBe(results[1]?.record.snapshotId);
		expect(results.map((result) => result.replayed).sort()).toEqual([
			false,
			true,
		]);
		expect(f.objects.size).toBe(1);
		expect(f.storage.remove).toHaveBeenCalledOnce();
		const [ref, version] = f.storage.remove.mock.calls[0] ?? [];
		expect(ref).not.toBe(results[0]?.record.objectRef);
		expect(version).toBeTruthy();
		expect(await readdir(f.directory)).toEqual([]);
	});

	it("cleans a rejected upload but preserves ambiguous commits pending readback", async () => {
		const f = await fixture();
		f.store.create.mockRejectedValueOnce(
			new WorkspaceSnapshotErrorV1("quota_exceeded"),
		);
		await expect(f.service.upload(f.upload())).rejects.toMatchObject({
			code: "quota_exceeded",
		});
		expect(f.objects.size).toBe(0);
		f.storage.remove.mockClear();
		f.store.create.mockRejectedValueOnce(
			new Error("lost connection after COMMIT"),
		);
		await expect(f.service.upload(f.upload())).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(f.storage.remove).not.toHaveBeenCalled();
		expect(f.objects.size).toBe(1);
		expect(await readdir(f.directory)).toEqual([]);
	});

	it("recovers a confirmed commit after a lost response without deleting its object", async () => {
		const f = await fixture();
		const create = f.store.create.getMockImplementation();
		if (!create) throw new Error("missing fixture create");
		f.store.create.mockImplementationOnce(async (...args) => {
			await create(...args);
			throw new Error("lost response");
		});
		const result = await f.service.upload(f.upload());
		expect(result.replayed).toBe(true);
		expect(f.records.get(result.record.snapshotId)).toEqual(result.record);
		expect(f.storage.remove).not.toHaveBeenCalled();
		expect(f.objects.size).toBe(1);
	});

	it("validates stored descriptors and surfaces cleanup failure without private details", async () => {
		const f = await fixture();
		f.storage.upload.mockResolvedValueOnce({
			version: "v-wrong",
			etag: "etag",
			sha256: "0".repeat(64),
			sizeBytes: 1,
			mediaType: "application/x-tar+gzip",
		});
		await expect(f.service.upload(f.upload())).rejects.toMatchObject({
			code: "unavailable",
			message: "unavailable",
		});
		expect(f.store.create).not.toHaveBeenCalled();
		expect(f.storage.remove).toHaveBeenCalledWith(
			expect.any(String),
			"v-wrong",
		);
		f.store.create.mockRejectedValueOnce(
			new WorkspaceSnapshotErrorV1("conflict"),
		);
		f.storage.remove.mockRejectedValueOnce(
			new Error("secret endpoint and private path"),
		);
		await expect(f.service.upload(f.upload())).rejects.toMatchObject({
			code: "unavailable",
			message: "unavailable",
		});
		expect(await readdir(f.directory)).toEqual([]);
	});

	it("rechecks revoked credentials before metadata commit and deletes only the uncommitted object", async () => {
		const f = await fixture();
		const upload = f.storage.upload.getMockImplementation();
		if (!upload) throw new Error("missing fixture upload");
		f.storage.upload.mockImplementationOnce(async (request) => {
			const stored = await upload(request);
			f.options.credentials.resolve.mockResolvedValueOnce(null);
			return stored;
		});
		await expect(f.service.upload(f.upload())).rejects.toMatchObject({
			code: "authentication_required",
		});
		expect(f.store.create).not.toHaveBeenCalled();
		expect(f.storage.remove).toHaveBeenCalledOnce();
		expect(f.objects.size).toBe(0);
		expect(await readdir(f.directory)).toEqual([]);
	});

	it("uses the concrete spool by default and cancels aborted uploads before storage writes", async () => {
		const f = await fixture();
		const { spool: _spool, ...options } = f.options;
		const defaultSpoolService = createWorkspaceSnapshotServiceV1(options);
		const result = await defaultSpoolService.upload(f.upload());
		expect(result.record.status).toBe("ready");
		const aborted = new AbortController();
		aborted.abort();
		await expect(
			defaultSpoolService.upload({
				...f.upload("alice", "new", "k2"),
				signal: aborted.signal,
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(f.storage.upload).toHaveBeenCalledOnce();
	});
});
