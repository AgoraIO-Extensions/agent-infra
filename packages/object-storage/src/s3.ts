import type { StoredFileObjectV1 } from "@agent-infra/platform-core";
import {
	DeleteObjectCommand,
	GetBucketVersioningCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectVersionsCommand,
	PutObjectCommand,
	S3Client,
	type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createContentProbe } from "./content.js";
import {
	type ObjectDownloadV1,
	type ObjectStorageDataV1,
	ObjectStorageError,
	type ObjectUploadV1,
} from "./types.js";

export interface S3ObjectStorageOptionsV1 {
	readonly endpoint?: string;
	readonly region: string;
	readonly credentials?: S3ClientConfig["credentials"];
	readonly bucket: string;
	readonly prefix: string;
	readonly maxObjectBytes: number;
	readonly timeoutMs: number;
}
function status(error: unknown) {
	return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
		?.httpStatusCode;
}
export function createS3ObjectStorageV1(
	options: S3ObjectStorageOptionsV1,
): ObjectStorageDataV1 & { close(): void } {
	if (
		!options.bucket ||
		!/^[a-zA-Z0-9_-]+\/$/.test(options.prefix) ||
		!Number.isSafeInteger(options.maxObjectBytes) ||
		options.maxObjectBytes < 1 ||
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1
	)
		throw new ObjectStorageError("invalid");
	const client = new S3Client({
		region: options.region,
		endpoint: options.endpoint,
		credentials: options.credentials,
		forcePathStyle: true,
		maxAttempts: 1,
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
	});
	function key(ref: string) {
		if (
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
				ref,
			)
		)
			throw new ObjectStorageError("invalid");
		return `${options.prefix}${ref}`;
	}
	function signal(expiresAt?: string, parent?: AbortSignal) {
		const remaining =
			expiresAt === undefined
				? options.timeoutMs
				: Date.parse(expiresAt) - Date.now();
		if (!Number.isFinite(remaining) || remaining <= 0 || parent?.aborted)
			throw new ObjectStorageError("expired");
		const timeout = AbortSignal.timeout(Math.min(remaining, options.timeoutMs));
		return parent ? AbortSignal.any([timeout, parent]) : timeout;
	}
	async function inspect(
		objectRef: string,
	): Promise<StoredFileObjectV1 | null> {
		try {
			const abortSignal = signal();
			const head = await client.send(
				new HeadObjectCommand({ Bucket: options.bucket, Key: key(objectRef) }),
				{ abortSignal },
			);
			if (
				!head.VersionId ||
				head.VersionId === "null" ||
				!head.ETag ||
				head.ContentLength === undefined ||
				head.ContentLength > options.maxObjectBytes
			)
				throw new ObjectStorageError("unavailable");
			const object = await client.send(
				new GetObjectCommand({
					Bucket: options.bucket,
					Key: key(objectRef),
					VersionId: head.VersionId,
					IfMatch: head.ETag,
				}),
				{ abortSignal },
			);
			if (
				!object.Body ||
				object.ETag !== head.ETag ||
				object.VersionId !== head.VersionId
			) {
				await object.Body?.transformToWebStream()
					.cancel()
					.catch(() => undefined);
				throw new ObjectStorageError("unavailable");
			}
			const probe = createContentProbe(options.maxObjectBytes);
			for await (const chunk of object.Body.transformToWebStream().pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>(),
				{ signal: abortSignal },
			))
				probe.write(chunk);
			const measured = await probe.finish();
			if (
				measured.sizeBytes !== head.ContentLength ||
				measured.mediaType !== head.ContentType
			)
				throw new ObjectStorageError("conflict");
			return { ...measured, etag: head.ETag, version: head.VersionId };
		} catch (error) {
			if (status(error) === 404) return null;
			if (error instanceof ObjectStorageError) throw error;
			throw new ObjectStorageError("unavailable");
		}
	}
	return {
		inspect,
		async scan(cursor: string | null, limit: number) {
			try {
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
					throw new ObjectStorageError("invalid");
				const position: { key?: string; version?: string } = cursor
					? JSON.parse(cursor)
					: {};
				if (position.key && !position.key.startsWith(options.prefix))
					throw new ObjectStorageError("invalid");
				const page = await client.send(
					new ListObjectVersionsCommand({
						Bucket: options.bucket,
						Prefix: options.prefix,
						MaxKeys: limit,
						KeyMarker: position.key,
						VersionIdMarker: position.version,
					}),
					{ abortSignal: signal() },
				);
				const objects = [
					...(page.Versions ?? []),
					...(page.DeleteMarkers ?? []),
				].map((value) => {
					if (!value.Key || !value.VersionId || !value.LastModified)
						throw new ObjectStorageError("unavailable");
					const objectRef = value.Key.slice(options.prefix.length);
					key(objectRef);
					return {
						objectRef,
						version: value.VersionId,
						createdAt: value.LastModified.toISOString(),
					};
				});
				if (page.IsTruncated && !page.NextKeyMarker)
					throw new ObjectStorageError("unavailable");
				return {
					objects,
					cursor: page.IsTruncated
						? JSON.stringify({
								key: page.NextKeyMarker,
								version: page.NextVersionIdMarker,
							})
						: null,
				};
			} catch (error) {
				if (error instanceof ObjectStorageError) throw error;
				throw new ObjectStorageError("unavailable");
			}
		},
		async remove(objectRef: string, version: string) {
			try {
				if (!version || version === "null")
					throw new ObjectStorageError("invalid");
				await client.send(
					new DeleteObjectCommand({
						Bucket: options.bucket,
						Key: key(objectRef),
						VersionId: version,
					}),
					{ abortSignal: signal() },
				);
			} catch (error) {
				if (error instanceof ObjectStorageError) throw error;
				throw new ObjectStorageError("unavailable");
			}
		},
		async upload(request: ObjectUploadV1) {
			try {
				const abortSignal = signal(request.expiresAt, request.signal);
				if (
					!Number.isSafeInteger(request.descriptor.sizeBytes) ||
					request.descriptor.sizeBytes < 0 ||
					request.descriptor.sizeBytes > options.maxObjectBytes ||
					!/^[a-f0-9]{64}$/.test(request.descriptor.sha256)
				)
					throw new ObjectStorageError("invalid");
				const existing = await inspect(request.objectRef);
				if (existing) {
					await request.body.cancel();
					if (
						existing.sha256 !== request.descriptor.sha256 ||
						existing.sizeBytes !== request.descriptor.sizeBytes ||
						existing.mediaType !== request.descriptor.mediaType
					)
						throw new ObjectStorageError("conflict");
					return existing;
				}
				const versioning = await client.send(
					new GetBucketVersioningCommand({ Bucket: options.bucket }),
					{ abortSignal },
				);
				if (versioning.Status !== "Enabled")
					throw new ObjectStorageError("unavailable");
				const checksum = Buffer.from(request.descriptor.sha256, "hex").toString(
					"base64",
				);
				const url = await getSignedUrl(
					client,
					new PutObjectCommand({
						Bucket: options.bucket,
						Key: key(request.objectRef),
						ContentType: request.descriptor.mediaType,
						ContentLength: request.descriptor.sizeBytes,
						ChecksumSHA256: checksum,
						IfNoneMatch: "*",
					}),
					{
						expiresIn: Math.max(
							1,
							Math.ceil(
								Math.min(
									Date.parse(request.expiresAt) - Date.now(),
									options.timeoutMs,
								) / 1000,
							),
						),
						unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
					},
				);
				const probe = createContentProbe(request.descriptor.sizeBytes);
				const body = request.body.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							probe.write(chunk);
							controller.enqueue(chunk);
						},
						async flush() {
							const measured = await probe.finish();
							if (
								measured.sizeBytes !== request.descriptor.sizeBytes ||
								measured.sha256 !== request.descriptor.sha256 ||
								measured.mediaType !== request.descriptor.mediaType
							)
								throw new ObjectStorageError("conflict");
						},
					}),
					{ signal: abortSignal },
				);
				const init: RequestInit & { duplex: "half" } = {
					method: "PUT",
					body,
					duplex: "half",
					redirect: "error",
					signal: abortSignal,
					headers: {
						"Content-Type": request.descriptor.mediaType,
						"Content-Length": String(request.descriptor.sizeBytes),
						"x-amz-checksum-sha256": checksum,
						"If-None-Match": "*",
					},
				};
				const response = await fetch(url, init);
				await response.body?.cancel();
				if (!response.ok && response.status !== 412)
					throw new ObjectStorageError(
						response.status >= 500 ? "unavailable" : "conflict",
					);
				const object = await inspect(request.objectRef);
				if (
					!object ||
					object.sha256 !== request.descriptor.sha256 ||
					object.sizeBytes !== request.descriptor.sizeBytes ||
					object.mediaType !== request.descriptor.mediaType
				)
					throw new ObjectStorageError("conflict");
				return object;
			} catch (error) {
				if (error instanceof ObjectStorageError) throw error;
				throw new ObjectStorageError("unavailable");
			}
		},
		async download(request: ObjectDownloadV1) {
			try {
				const abortSignal = signal(request.expiresAt, request.signal);
				if (!request.version || !request.etag)
					throw new ObjectStorageError("invalid");
				const object = await client.send(
					new GetObjectCommand({
						Bucket: options.bucket,
						Key: key(request.objectRef),
						VersionId: request.version,
						IfMatch: request.etag,
					}),
					{ abortSignal },
				);
				if (
					!object.Body ||
					object.VersionId !== request.version ||
					object.ETag !== request.etag ||
					object.ContentLength === undefined ||
					!Number.isSafeInteger(object.ContentLength) ||
					object.ContentLength < 0 ||
					object.ContentLength > options.maxObjectBytes
				) {
					await object.Body?.transformToWebStream()
						.cancel()
						.catch(() => undefined);
					throw new ObjectStorageError("missing");
				}
				const expectedBytes = object.ContentLength;
				let count = 0;
				return object.Body.transformToWebStream().pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							count += chunk.byteLength;
							if (abortSignal.aborted || count > expectedBytes)
								throw new ObjectStorageError("unavailable");
							controller.enqueue(chunk);
						},
						flush() {
							if (count !== expectedBytes)
								throw new ObjectStorageError("unavailable");
						},
					}),
					{ signal: abortSignal },
				);
			} catch (error) {
				if (error instanceof ObjectStorageError) throw error;
				throw new ObjectStorageError(
					status(error) === 404 || status(error) === 412
						? "missing"
						: "unavailable",
				);
			}
		},
		close() {
			client.destroy();
		},
	};
}
