import { randomUUID } from "node:crypto";
import type {
	FileDescriptorV1,
	StoredFileObjectV1,
} from "@agent-infra/platform-core";

export * from "./types.js";

import { createContentProbe } from "./content.js";
import {
	type ObjectDownloadV1,
	type ObjectStorageDataV1,
	ObjectStorageError,
	type ObjectUploadV1,
} from "./types.js";

function requireReference(value: string) {
	if (
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
			value,
		)
	)
		throw new ObjectStorageError("invalid");
}
function requireActive(expiresAt: string, signal?: AbortSignal) {
	if (
		signal?.aborted ||
		!Number.isFinite(Date.parse(expiresAt)) ||
		Date.parse(expiresAt) <= Date.now()
	)
		throw new ObjectStorageError("expired");
}
function sameContent(actual: StoredFileObjectV1, expected: FileDescriptorV1) {
	if (
		actual.sha256 !== expected.sha256 ||
		actual.mediaType !== expected.mediaType ||
		actual.sizeBytes !== expected.sizeBytes
	)
		throw new ObjectStorageError("conflict");
}
// Fake keeps bytes only for bounded contract tests; production uses streaming S3 I/O.
export class FakeObjectStorageV1 implements ObjectStorageDataV1 {
	private objects = new Map<
		string,
		{ bytes: Uint8Array; metadata: StoredFileObjectV1; createdAt: string }
	>();
	async scan(cursor: string | null, limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new ObjectStorageError("invalid");
		const keys = [...this.objects.keys()]
			.sort()
			.filter((key) => !cursor || key > cursor)
			.slice(0, limit);
		return {
			objects: keys.map((objectRef) => {
				const value = this.objects.get(objectRef);
				if (!value) throw new ObjectStorageError("missing");
				return {
					objectRef,
					version: value.metadata.version,
					createdAt: value.createdAt,
				};
			}),
			cursor: keys.length === limit ? (keys.at(-1) ?? null) : null,
		};
	}
	async remove(objectRef: string, version: string) {
		requireReference(objectRef);
		if (this.objects.get(objectRef)?.metadata.version === version)
			this.objects.delete(objectRef);
	}
	async inspect(objectRef: string) {
		requireReference(objectRef);
		const value = this.objects.get(objectRef);
		return value ? structuredClone(value.metadata) : null;
	}
	async upload(request: ObjectUploadV1) {
		requireReference(request.objectRef);
		requireActive(request.expiresAt, request.signal);
		const existing = this.objects.get(request.objectRef);
		if (existing) {
			await request.body.cancel();
			sameContent(existing.metadata, request.descriptor);
			return structuredClone(existing.metadata);
		}
		if (request.descriptor.sizeBytes > 1024 * 1024)
			throw new ObjectStorageError("invalid");
		const chunks: Uint8Array[] = [];
		const probe = createContentProbe(request.descriptor.sizeBytes);
		try {
			for await (const chunk of request.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>(),
				{
					signal: AbortSignal.any([
						AbortSignal.timeout(
							Math.max(
								1,
								Math.min(300000, Date.parse(request.expiresAt) - Date.now()),
							),
						),
						...(request.signal ? [request.signal] : []),
					]),
				},
			)) {
				requireActive(request.expiresAt, request.signal);
				try {
					probe.write(chunk);
				} catch {
					throw new ObjectStorageError("conflict");
				}
				chunks.push(chunk.slice());
			}
		} catch (error) {
			if (error instanceof ObjectStorageError) throw error;
			throw new ObjectStorageError("unavailable");
		}
		let measured: Awaited<ReturnType<typeof probe.finish>>;
		try {
			measured = await probe.finish();
		} catch {
			throw new ObjectStorageError("conflict");
		}
		const metadata = { ...measured, etag: randomUUID(), version: randomUUID() };
		sameContent(metadata, request.descriptor);
		requireActive(request.expiresAt, request.signal);
		const raced = this.objects.get(request.objectRef);
		if (raced) {
			sameContent(raced.metadata, request.descriptor);
			return structuredClone(raced.metadata);
		}
		this.objects.set(request.objectRef, {
			bytes: Buffer.concat(chunks),
			createdAt: new Date().toISOString(),
			metadata,
		});
		return structuredClone(metadata);
	}
	async download(request: ObjectDownloadV1) {
		requireReference(request.objectRef);
		requireActive(request.expiresAt, request.signal);
		const value = this.objects.get(request.objectRef);
		if (
			!value ||
			value.metadata.version !== request.version ||
			value.metadata.etag !== request.etag
		)
			throw new ObjectStorageError("missing");
		return new ReadableStream<Uint8Array>({
			start(controller) {
				requireActive(request.expiresAt, request.signal);
				controller.enqueue(value.bytes.slice());
				controller.close();
			},
		});
	}
}
export {
	createS3ObjectStorageV1,
	type S3ObjectStorageOptionsV1,
} from "./s3.js";
