import { createHash, randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { expect, it } from "vitest";
import {
	createS3ObjectStorageV1,
	requireEvaluationObjectStorageV1,
} from "./index.js";
import { startMinioFileFixtureV1 } from "./minio.test-support.js";

it("uses the dedicated Eval prefix and inspects/deletes only an explicitly selected S3 version", async () => {
	const fixture = await startMinioFileFixtureV1("file", "eval");
	const ordinary = createS3ObjectStorageV1({
		region: "us-east-1",
		bucket: "fixture",
		prefix: "files/",
		maxObjectBytes: 1024,
		timeoutMs: 1000,
	});
	try {
		expect(fixture.prefix).toBe("eval/");
		expect(() =>
			requireEvaluationObjectStorageV1(fixture.storage),
		).not.toThrow();
		expect(() => requireEvaluationObjectStorageV1(ordinary)).toThrow();
		const objectRef = randomUUID();
		const bytes = new TextEncoder().encode('{"fixture":1}');
		const original = await fixture.storage.upload({
			objectRef,
			descriptor: {
				name: "dataset.json",
				mediaType: "application/json",
				sizeBytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			expiresAt: new Date(Date.now() + 10000).toISOString(),
			body: new ReadableStream({
				start(c) {
					c.enqueue(bytes);
					c.close();
				},
			}),
		});
		await fixture.client.send(
			new PutObjectCommand({
				Bucket: fixture.bucket,
				Key: `${fixture.prefix}${objectRef}`,
				Body: new TextEncoder().encode('{"fixture":2}'),
				ContentType: "application/json",
			}),
		);
		const latest = await fixture.storage.inspect(objectRef);
		expect(latest?.version).not.toBe(original.version);
		expect(await fixture.storage.inspect(objectRef, original.version)).toEqual(
			original,
		);
		await fixture.storage.remove(objectRef, original.version);
		expect(
			await fixture.storage.inspect(objectRef, original.version),
		).toBeNull();
		expect(await fixture.storage.inspect(objectRef)).toEqual(latest);
	} finally {
		ordinary.close();
		await fixture.close();
	}
}, 60000);
