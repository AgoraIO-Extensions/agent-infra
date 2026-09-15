import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { ObjectStorageDataV1 } from "./types.js";

export async function objectStorageConformanceV1(storage: ObjectStorageDataV1) {
	const bytes = Buffer.from("bounded contract fixture");
	const request = {
		objectRef: randomUUID(),
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		descriptor: {
			name: "fixture.txt",
			mediaType: "text/plain",
			sizeBytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		},
	};
	const body = () =>
		new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(bytes.slice());
				c.close();
			},
		});
	expect(await storage.inspect(request.objectRef)).toBeNull();
	const stored = await storage.upload({ ...request, body: body() });
	expect(stored).toMatchObject({
		mediaType: request.descriptor.mediaType,
		sizeBytes: bytes.length,
		sha256: request.descriptor.sha256,
	});
	expect(stored.version.length).toBeGreaterThan(0);
	expect(await storage.inspect(request.objectRef)).toEqual(stored);
	// Retry after loss of the successful upload response preserves object identity/version.
	expect(await storage.upload({ ...request, body: body() })).toEqual(stored);
	const read = {
		objectRef: request.objectRef,
		version: stored.version,
		etag: stored.etag,
		expiresAt: request.expiresAt,
	};
	expect(
		Buffer.from(await new Response(await storage.download(read)).arrayBuffer()),
	).toEqual(bytes);
	await expect(
		storage.download({ ...read, etag: '"wrong-etag"' }),
	).rejects.toMatchObject({ code: "missing" });
	await expect(
		storage.download({ ...read, expiresAt: "2000-01-01T00:00:00Z" }),
	).rejects.toMatchObject({ code: "expired" });
	await expect(
		storage.download({ ...read, signal: AbortSignal.abort() }),
	).rejects.toMatchObject({ code: "expired" });
	await expect(
		storage.upload({
			...request,
			body: body(),
			descriptor: { ...request.descriptor, sha256: "0".repeat(64) },
		}),
	).rejects.toMatchObject({ code: "conflict" });
	expect(await storage.inspect(request.objectRef)).toEqual(stored);
	const concurrent = { ...request, objectRef: randomUUID() };
	const outcomes = await Promise.allSettled([
		storage.upload({ ...concurrent, body: body() }),
		storage.upload({ ...concurrent, body: body() }),
	]);
	expect(outcomes.some((value) => value.status === "fulfilled")).toBe(true);
	const final = await storage.inspect(concurrent.objectRef);
	for (const outcome of outcomes) {
		if (outcome.status === "fulfilled") expect(outcome.value).toEqual(final);
	}
}

export async function objectCleanupConformanceV1(storage: ObjectStorageDataV1) {
	const found: { objectRef: string; version: string }[] = [];
	let cursor: string | null = null;
	for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
		const page = await storage.scan(cursor, 1);
		expect(page.objects.length).toBeLessThanOrEqual(1);
		for (const object of page.objects) {
			expect(Number.isFinite(Date.parse(object.createdAt))).toBe(true);
			found.push(object);
		}
		cursor = page.cursor;
		if (cursor === null) break;
	}
	expect(cursor).toBeNull();
	expect(found.length).toBeGreaterThan(0);
	for (const object of found) {
		await storage.remove(object.objectRef, object.version);
		await storage.remove(object.objectRef, object.version);
		expect(await storage.inspect(object.objectRef)).toBeNull();
	}
}
