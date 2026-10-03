import type {
	FileDescriptorV1,
	FileReconciliationStorageV1,
	ObjectStoragePortV1,
	StoredFileObjectV1,
} from "@agent-infra/platform-core";
export class ObjectStorageError extends Error {
	constructor(
		readonly code:
			| "invalid"
			| "conflict"
			| "unavailable"
			| "expired"
			| "missing",
	) {
		super(`Object storage ${code}`);
	}
}
export interface ObjectUploadV1 {
	readonly objectRef: string;
	readonly descriptor: FileDescriptorV1;
	readonly expiresAt: string;
	readonly body: ReadableStream<Uint8Array>;
	readonly signal?: AbortSignal;
}
export interface ObjectDownloadV1 {
	readonly objectRef: string;
	readonly version: string;
	readonly etag: string;
	readonly expiresAt: string;
	readonly signal?: AbortSignal;
}
export interface ObjectStorageDataV1
	extends ObjectStoragePortV1,
		FileReconciliationStorageV1 {
	upload(request: ObjectUploadV1): Promise<StoredFileObjectV1>;
	download(request: ObjectDownloadV1): Promise<ReadableStream<Uint8Array>>;
}
