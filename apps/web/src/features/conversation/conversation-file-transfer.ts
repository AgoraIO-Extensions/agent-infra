import type { Client } from "../../pilot/generated/client/index.js";
import type {
	FileDescriptorV1,
	FileLimitsV1,
	FileProjectionV1,
} from "../../pilot/generated/index.js";
import {
	completeFileUpload,
	createFileUpload,
	issueFileAccess,
	uploadFileContent,
} from "../../pilot/generated/sdk.gen.js";

/**
 * 平台文件上传的唯一浏览器路径（PRD §12.1）：读取会话限制后，以
 * create → write access → content → complete 四步把文件交给平台文件授权；
 * 返回完成后的文件投影，调用方只使用其中的 fileId。
 */
export class ConversationFileTransferError extends Error {
	readonly expired: boolean;

	constructor(expired: boolean) {
		super("file transfer failed");
		this.expired = expired;
	}
}

export function isExpiredFileStatus(status?: number) {
	return status === 401 || status === 403 || status === 404;
}

export async function describeConversationFile(
	file: File,
	limits: FileLimitsV1,
): Promise<FileDescriptorV1> {
	const mediaType = file.type || "application/octet-stream";
	if (!limits.mediaTypes.includes(mediaType))
		throw new ConversationFileTransferError(false);
	if (file.size > limits.maxBytes)
		throw new ConversationFileTransferError(false);
	if (!globalThis.crypto?.subtle)
		throw new ConversationFileTransferError(false);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		await file.arrayBuffer(),
	);
	const sha256 = [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
	return { name: file.name, mediaType, sizeBytes: file.size, sha256 };
}

export async function uploadConversationFile({
	client,
	conversationId,
	file,
	descriptor,
	idempotencyKey,
	signal,
}: {
	client: Client;
	conversationId: string;
	file: File;
	descriptor: FileDescriptorV1;
	idempotencyKey: string;
	signal?: AbortSignal;
}): Promise<FileProjectionV1> {
	const created = await createFileUpload({
		client,
		path: { conversationId },
		headers: { "Idempotency-Key": idempotencyKey },
		body: { schemaVersion: 1, descriptor },
		responseStyle: "fields",
		throwOnError: false,
		signal,
	});
	if (!created.data || created.response?.status !== 201)
		throw new ConversationFileTransferError(
			isExpiredFileStatus(created.response?.status),
		);
	const access = await issueFileAccess({
		client,
		path: { conversationId, fileId: created.data.fileId },
		headers: { "Idempotency-Key": `${idempotencyKey}-access` },
		body: { schemaVersion: 1, operation: "write" },
		responseStyle: "fields",
		throwOnError: false,
		signal,
	});
	if (!access.data || access.response?.status !== 200)
		throw new ConversationFileTransferError(
			isExpiredFileStatus(access.response?.status),
		);
	const bytes = await uploadFileContent({
		client,
		path: { conversationId, fileId: created.data.fileId },
		headers: {
			"X-Platform-File-Grant": access.data.grant.token,
			"Content-Type": descriptor.mediaType,
			"Content-Length": descriptor.sizeBytes,
		},
		body: file,
		responseStyle: "fields",
		throwOnError: false,
		signal,
	});
	if (bytes.response?.status !== 204)
		throw new ConversationFileTransferError(
			isExpiredFileStatus(bytes.response?.status),
		);
	const completed = await completeFileUpload({
		client,
		path: { conversationId, fileId: created.data.fileId },
		headers: { "X-Platform-File-Grant": access.data.grant.token },
		body: { schemaVersion: 1, accessId: access.data.accessId },
		responseStyle: "fields",
		throwOnError: false,
		signal,
	});
	if (!completed.data || completed.response?.status !== 200)
		throw new ConversationFileTransferError(
			isExpiredFileStatus(completed.response?.status),
		);
	return completed.data;
}
