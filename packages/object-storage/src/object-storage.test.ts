import { expect, it } from "vitest";
import {
	objectCleanupConformanceV1,
	objectStorageConformanceV1,
} from "./conformance.ts";
import { FakeObjectStorageV1 } from "./index.ts";

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
