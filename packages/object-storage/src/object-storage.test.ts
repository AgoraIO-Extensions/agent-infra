import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	objectCleanupConformanceV1,
	objectStorageConformanceV1,
} from "./conformance.ts";
import { FakeObjectStorageV1 } from "./index.ts";

it("rejects unknown file bytes despite a caller-declared binary media type", async () => {
	const storage = new FakeObjectStorageV1();
	const content = new Uint8Array(64);
	await expect(
		storage.upload({
			objectRef: "00000000-0000-4000-8000-000000000001",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			descriptor: {
				name: "unknown.bin",
				mediaType: "application/octet-stream",
				sizeBytes: content.length,
				sha256: createHash("sha256").update(content).digest("hex"),
			},
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(content);
					controller.close();
				},
			}),
		}),
	).rejects.toMatchObject({ code: "conflict" });
	expect(
		await storage.inspect("00000000-0000-4000-8000-000000000001"),
	).toBeNull();
});

it("keeps package evidence storage separate and rejects malformed evidence", async () => {
	const { createS3ObjectStorageV1 } = await import("./s3.ts");
	expect(() =>
		createS3ObjectStorageV1({
			region: "test",
			bucket: "test",
			prefix: "files/",
			maxObjectBytes: 1024,
			timeoutMs: 1000,
			contentPolicy: "skill-package",
		}),
	).toThrowError(expect.objectContaining({ code: "invalid" }));
	const storage = new FakeObjectStorageV1({ contentPolicy: "skill-package" });
	for (const [content, mediaType] of [
		[Buffer.from("not JSON"), "application/json"],
		[new Uint8Array(63), "application/octet-stream"],
	] as const) {
		await expect(
			storage.upload({
				objectRef: "00000000-0000-4000-8000-000000000001",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				descriptor: {
					name: "evidence",
					mediaType,
					sizeBytes: content.length,
					sha256: createHash("sha256").update(content).digest("hex"),
				},
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(content);
						controller.close();
					},
				}),
			}),
		).rejects.toMatchObject({ code: "conflict" });
	}
});

it("writes a verified immutable object and refuses content changes under its reference", async () => {
	const storage = new FakeObjectStorageV1();
	const descriptor = {
		name: "hello.txt",
		mediaType: "text/plain",
		sizeBytes: 5,
		sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
	};
	const request = {
		objectRef: "00000000-0000-4000-8000-000000000001",
		descriptor,
		expiresAt: new Date(Date.now() + 60000).toISOString(),
	};
	const body = () =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("hello"));
				controller.close();
			},
		});
	const first = await storage.upload({ ...request, body: body() });
	expect(first).toMatchObject({
		sizeBytes: 5,
		mediaType: "text/plain",
		sha256: descriptor.sha256,
	});
	expect(await storage.upload({ ...request, body: body() })).toEqual(first);
	const downloaded = await storage.download({
		objectRef: request.objectRef,
		version: first.version,
		etag: first.etag,
		expiresAt: request.expiresAt,
	});
	expect(await new Response(downloaded).text()).toBe("hello");
	await expect(
		storage.upload({
			...request,
			descriptor: { ...descriptor, sha256: "0".repeat(64) },
			body: body(),
		}),
	).rejects.toMatchObject({ code: "conflict" });
});

it("satisfies the shared Fake/S3 object contract", async () => {
	const storage = new FakeObjectStorageV1();
	await objectStorageConformanceV1(storage);
	await objectCleanupConformanceV1(storage);
});

it("cancels rejected S3 response bodies before reporting an unavailable object", async () => {
	const { vi } = await import("vitest");
	const { S3Client, HeadObjectCommand } = await import("@aws-sdk/client-s3");
	const { createS3ObjectStorageV1 } = await import("./s3.ts");
	let cancelled = 0;
	const spy = vi
		.spyOn(S3Client.prototype, "send")
		.mockImplementation(async (command) => {
			if (command instanceof HeadObjectCommand)
				return {
					VersionId: "expected",
					ETag: '"etag"',
					ContentLength: 5,
					ContentType: "text/plain",
				};
			return {
				VersionId: "wrong",
				ETag: '"etag"',
				ContentLength: 5,
				Body: {
					transformToWebStream: () =>
						new ReadableStream({
							cancel() {
								cancelled++;
							},
						}),
				},
			};
		});
	const storage = createS3ObjectStorageV1({
		region: "test",
		bucket: "test",
		prefix: "files/",
		maxObjectBytes: 10,
		timeoutMs: 1000,
	});
	try {
		const objectRef = "00000000-0000-4000-8000-000000000001";
		await expect(storage.inspect(objectRef)).rejects.toMatchObject({
			code: "unavailable",
		});
		await expect(
			storage.download({
				objectRef,
				version: "expected",
				etag: '"etag"',
				expiresAt: new Date(Date.now() + 1000).toISOString(),
			}),
		).rejects.toMatchObject({ code: "missing" });
		expect(cancelled).toBe(2);
	} finally {
		spy.mockRestore();
		storage.close();
	}
});

it.each([4, 6])(
	"rejects a download of %i bytes when S3 declares five",
	async (length) => {
		const { vi } = await import("vitest");
		const { S3Client } = await import("@aws-sdk/client-s3");
		const { createS3ObjectStorageV1 } = await import("./s3.ts");
		const spy = vi
			.spyOn(S3Client.prototype, "send")
			.mockImplementation(async () => ({
				VersionId: "expected",
				ETag: '"etag"',
				ContentLength: 5,
				Body: {
					transformToWebStream: () =>
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new Uint8Array(length));
								controller.close();
							},
						}),
				},
			}));
		const storage = createS3ObjectStorageV1({
			region: "test",
			bucket: "test",
			prefix: "files/",
			maxObjectBytes: 10,
			timeoutMs: 1000,
		});
		try {
			const stream = await storage.download({
				objectRef: "00000000-0000-4000-8000-000000000001",
				version: "expected",
				etag: '"etag"',
				expiresAt: new Date(Date.now() + 1000).toISOString(),
			});
			await expect(new Response(stream).arrayBuffer()).rejects.toMatchObject({
				code: "unavailable",
			});
		} finally {
			spy.mockRestore();
			storage.close();
		}
	},
);

it("keeps deterministic Fake size overflow a conflict without persisting bytes", async () => {
	const storage = new FakeObjectStorageV1();
	const objectRef = "00000000-0000-4000-8000-000000000001";
	await expect(
		storage.upload({
			objectRef,
			expiresAt: new Date(Date.now() + 1000).toISOString(),
			descriptor: {
				name: "fixture.txt",
				mediaType: "text/plain",
				sizeBytes: 1,
				sha256: "0".repeat(64),
			},
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([65, 66]));
					controller.close();
				},
			}),
		}),
	).rejects.toMatchObject({ code: "conflict" });
	expect(await storage.inspect(objectRef)).toBeNull();
});
