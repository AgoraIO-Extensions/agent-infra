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
	for (const expectedMetadata of [
		{ sizeBytes: bytes.length + 1, mediaType: "text/plain" },
		{ sizeBytes: bytes.length, mediaType: "application/json" },
	])
		await expect(
			storage.download({ ...read, expectedMetadata }),
		).rejects.toMatchObject({ code: "missing" });
	const verified = await storage.download({
		...read,
		expectedMetadata: { sizeBytes: bytes.length, mediaType: "text/plain" },
	});
	expect(Buffer.from(await new Response(verified).arrayBuffer())).toEqual(
		bytes,
	);
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
	// A cancelled input is retryable/expired, never an immutable-content conflict.
	const abort = new AbortController();
	const cancelledRef = randomUUID();
	const cancelledBody = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				controller.enqueue(bytes.slice(0, 1));
				abort.abort();
			},
		},
		{ highWaterMark: 0 },
	);
	await expect(
		storage.upload({
			...request,
			objectRef: cancelledRef,
			body: cancelledBody,
			signal: abort.signal,
		}),
	).rejects.toMatchObject({
		code: expect.stringMatching(/^(expired|unavailable)$/),
	});
	expect(await storage.inspect(cancelledRef)).toBeNull();

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

/**
 * #3257：纯文本以平台白名单内的声明子类型为准，白名单之外或字节不符的声明不能成为可确认对象
 * （工程 Spec §15.4.1）。Fake 与 S3 必须给出同一结论。
 */
export async function objectTextDeclarationConformanceV1(
	storage: ObjectStorageDataV1,
) {
	const csv = Buffer.from("名称,数量\n苹果,3\n");
	const png = Buffer.from(
		"89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
			"1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
		"hex",
	);
	// GBK 编码的 CSV 不是合法 UTF-8。
	const gbk = Buffer.from("c3fbb3c62cbafd0a", "hex");
	const upload = (bytes: Buffer, mediaType: string, objectRef = randomUUID()) =>
		storage.upload({
			objectRef,
			expiresAt: new Date(Date.now() + 60000).toISOString(),
			descriptor: {
				name: "table.csv",
				mediaType,
				sizeBytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			body: new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(bytes.slice());
					c.close();
				},
			}),
		});
	for (const mediaType of ["text/csv", "text/plain"]) {
		const objectRef = randomUUID();
		const stored = await upload(csv, mediaType, objectRef);
		expect(stored.mediaType).toBe(mediaType);
		expect(await storage.inspect(objectRef)).toEqual(stored);
	}
	for (const [bytes, mediaType] of [
		[csv, "text/x-python"],
		[png, "text/csv"],
		[gbk, "text/csv"],
	] as const) {
		const objectRef = randomUUID();
		await expect(upload(bytes, mediaType, objectRef)).rejects.toMatchObject({
			code: expect.stringMatching(/^(conflict|unavailable)$/),
		});
		// 即使 S3 已留下对象，按实际字节重新核验也不能得到可确认的元数据。
		const inspected = await storage.inspect(objectRef).catch((error) => error);
		expect(inspected === null || inspected?.code === "conflict").toBe(true);
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
