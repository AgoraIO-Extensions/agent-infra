import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
	objectCleanupConformanceV1,
	objectStorageConformanceV1,
} from "./conformance.ts";
import { startMinioFileFixtureV1 } from "./minio.test-support.ts";

it("uses actual versioned S3 bytes for immutable writes, confirmation and reads", async () => {
	const fixture = await startMinioFileFixtureV1();
	const storage = fixture.storage;
	try {
		await objectStorageConformanceV1(storage);
		const descriptor = {
			name: "hello.txt",
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256:
				"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		};
		const request = {
			objectRef: randomUUID(),
			descriptor,
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		};
		const body = () =>
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode("hello"));
					c.close();
				},
			});
		const result = await storage.upload({ ...request, body: body() });
		expect(result).toMatchObject({
			sizeBytes: 5,
			mediaType: "text/plain",
			sha256: descriptor.sha256,
		});
		expect(await storage.inspect(request.objectRef)).toEqual(result);
		expect(await storage.upload({ ...request, body: body() })).toEqual(result);
		expect(
			await new Response(
				await storage.download({
					objectRef: request.objectRef,
					version: result.version,
					etag: result.etag,
					expiresAt: request.expiresAt,
				}),
			).text(),
		).toBe("hello");
		await expect(
			storage.upload({
				...request,
				descriptor: { ...descriptor, sha256: "0".repeat(64) },
				body: body(),
			}),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			storage.download({
				objectRef: request.objectRef,
				version: result.version,
				etag: result.etag,
				expiresAt: "2020-01-01T00:00:00Z",
			}),
		).rejects.toMatchObject({ code: "expired" });
		await objectCleanupConformanceV1(storage);
	} finally {
		await fixture.close();
	}
}, 60000);
