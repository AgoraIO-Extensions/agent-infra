import { randomUUID } from "node:crypto";
import {
	DeleteObjectCommand,
	GetBucketVersioningCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, expect, it, vi } from "vitest";
import { objectUploadFenceConformanceV1 } from "./conformance.js";
import { FakeObjectStorageV1 } from "./index.js";
import { createS3ObjectStorageV1 } from "./s3.js";

afterEach(() => vi.restoreAllMocks());

const marker = (version = "fence-v1") => ({
	VersionId: version,
	ContentLength: 0,
	ContentType: "application/vnd.agent-infra.upload-fence",
	Metadata: { "agent-infra-upload-fence": "v1" },
});
const makeStorage = () =>
	createS3ObjectStorageV1({
		region: "test",
		bucket: "test",
		prefix: "snapshots/",
		maxObjectBytes: 1024,
		timeoutMs: 1000,
	});
const missing = () =>
	Object.assign(new Error("synthetic missing"), {
		$metadata: { httpStatusCode: 404 },
	});

it("retains Fake fences and refuses a body that finishes after fencing", async () => {
	await objectUploadFenceConformanceV1(new FakeObjectStorageV1());
});

it("confirms an idempotent S3 fence with HEAD and never reads its body", async () => {
	const spy = vi
		.spyOn(S3Client.prototype, "send")
		.mockImplementation(async (command) => {
			expect(command).toBeInstanceOf(HeadObjectCommand);
			return marker();
		});
	const storage = makeStorage();
	try {
		expect(await storage.fenceUpload(randomUUID())).toEqual({
			version: "fence-v1",
		});
		expect(spy).toHaveBeenCalledOnce();
	} finally {
		storage.close();
	}
});

it("writes a new zero-byte S3 fence and confirms the current version before returning it", async () => {
	let exists = false;
	const spy = vi
		.spyOn(S3Client.prototype, "send")
		.mockImplementation(async (command) => {
			if (command instanceof HeadObjectCommand) {
				if (!exists) throw missing();
				return marker();
			}
			if (command instanceof GetBucketVersioningCommand)
				return { Status: "Enabled" };
			expect(command).toBeInstanceOf(PutObjectCommand);
			expect((command as PutObjectCommand).input).toMatchObject({
				ContentLength: 0,
				Body: new Uint8Array(),
				ContentType: "application/vnd.agent-infra.upload-fence",
				Metadata: { "agent-infra-upload-fence": "v1" },
			});
			exists = true;
			return { VersionId: "put-receipt" };
		});
	const storage = makeStorage();
	try {
		expect(await storage.fenceUpload(randomUUID())).toEqual({
			version: "fence-v1",
		});
		expect(spy.mock.calls.map(([command]) => command.constructor.name)).toEqual(
			[
				"HeadObjectCommand",
				"GetBucketVersioningCommand",
				"PutObjectCommand",
				"HeadObjectCommand",
			],
		);
	} finally {
		storage.close();
	}
});

it("retains an unknown fence on storage errors or disabled versioning", async () => {
	const spy = vi
		.spyOn(S3Client.prototype, "send")
		.mockImplementation(async () => {
			throw Object.assign(new Error("synthetic denied"), {
				$metadata: { httpStatusCode: 403 },
			});
		});
	const storage = makeStorage();
	try {
		await expect(storage.fenceUpload(randomUUID())).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(spy).toHaveBeenCalledOnce();
		spy.mockClear();
		spy.mockImplementation(async (command) => {
			if (command instanceof HeadObjectCommand) throw missing();
			expect(command).toBeInstanceOf(GetBucketVersioningCommand);
			return { Status: "Suspended" };
		});
		await expect(storage.fenceUpload(randomUUID())).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(spy).toHaveBeenCalledTimes(2);
	} finally {
		storage.close();
	}
});

it("keeps a lost fence write response unknown until a later durable HEAD confirms it", async () => {
	let exists = false;
	let writes = 0;
	vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
		if (command instanceof HeadObjectCommand) {
			if (!exists) throw missing();
			return marker();
		}
		if (command instanceof GetBucketVersioningCommand)
			return { Status: "Enabled" };
		expect(command).toBeInstanceOf(PutObjectCommand);
		const input = (command as PutObjectCommand).input;
		expect(input.ContentLength).toBe(0);
		expect(input.Body).toEqual(new Uint8Array());
		expect(input.Metadata).toEqual({ "agent-infra-upload-fence": "v1" });
		exists = true;
		writes++;
		throw new Error("synthetic lost response");
	});
	const storage = makeStorage();
	const ref = randomUUID();
	try {
		await expect(storage.fenceUpload(ref)).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(await storage.fenceUpload(ref)).toEqual({ version: "fence-v1" });
		expect(writes).toBe(1);
	} finally {
		storage.close();
	}
});

it.each([
	{ VersionId: "null" },
	{ VersionId: "" },
	{ VersionId: "unsafe\nversion" },
	{ ContentLength: 1 },
	{ ContentType: "text/plain" },
	{ Metadata: { "agent-infra-upload-fence": "unknown" } },
])(
	"rejects invalid S3 fence evidence without overwriting it: %j",
	async (invalid) => {
		const spy = vi
			.spyOn(S3Client.prototype, "send")
			.mockImplementation(async () => ({ ...marker(), ...invalid }));
		const storage = makeStorage();
		try {
			await expect(storage.fenceUpload(randomUUID())).rejects.toMatchObject({
				code: "unavailable",
			});
			expect(spy).toHaveBeenCalledOnce();
		} finally {
			storage.close();
		}
	},
);

it("does not report a successful PUT as a fence without confirming the current version", async () => {
	let reads = 0;
	vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
		if (command instanceof HeadObjectCommand) {
			reads++;
			throw missing();
		}
		if (command instanceof GetBucketVersioningCommand)
			return { Status: "Enabled" };
		return { VersionId: "put-accepted" };
	});
	const storage = makeStorage();
	try {
		await expect(storage.fenceUpload(randomUUID())).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(reads).toBe(2);
	} finally {
		storage.close();
	}
});

it("refuses removal of the current S3 fence while deleting an exact older version", async () => {
	const deleted: string[] = [];
	vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
		if (command instanceof HeadObjectCommand) return marker();
		expect(command).toBeInstanceOf(DeleteObjectCommand);
		deleted.push((command as DeleteObjectCommand).input.VersionId ?? "");
		return {};
	});
	const storage = makeStorage();
	const ref = randomUUID();
	try {
		await expect(storage.remove(ref, "fence-v1")).rejects.toMatchObject({
			code: "conflict",
		});
		await storage.remove(ref, "old-data");
		await storage.remove(ref, "old-fence");
		expect(deleted).toEqual(["old-data", "old-fence"]);
	} finally {
		storage.close();
	}
});

it("rejects invalid fence references before making storage requests", async () => {
	const spy = vi.spyOn(S3Client.prototype, "send");
	const storage = makeStorage();
	try {
		await expect(storage.fenceUpload("other/path")).rejects.toMatchObject({
			code: "invalid",
		});
		expect(spy).not.toHaveBeenCalled();
	} finally {
		storage.close();
	}
});

it("cancels an S3 upload rejected by a current fence without reading the marker body", async () => {
	const spy = vi
		.spyOn(S3Client.prototype, "send")
		.mockImplementation(async (command) => {
			expect(command).toBeInstanceOf(HeadObjectCommand);
			return marker();
		});
	let cancelled = false;
	const storage = makeStorage();
	try {
		await expect(
			storage.upload({
				objectRef: randomUUID(),
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				descriptor: {
					name: "fixture.txt",
					mediaType: "text/plain",
					sizeBytes: 5,
					sha256: "a".repeat(64),
				},
				body: new ReadableStream<Uint8Array>(
					{
						cancel() {
							cancelled = true;
						},
					},
					{ highWaterMark: 0 },
				),
			}),
		).rejects.toMatchObject({ code: "conflict" });
		expect(cancelled).toBe(true);
		expect(spy).toHaveBeenCalledOnce();
	} finally {
		storage.close();
	}
});
