import {
	isTextContentV1,
	requiresTextContentV1,
} from "@agent-infra/file-content/text";
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
	/** `content`：声明类型只能由纯文本满足，但文件内容不是合法 UTF-8 文本（#3257）。 */
	readonly reason?: "content";

	constructor(expired: boolean, reason?: "content") {
		super("file transfer failed");
		this.expired = expired;
		this.reason = reason;
	}
}

export function isExpiredFileStatus(status?: number) {
	return status === 401 || status === 403 || status === 404;
}

/**
 * 浏览器把 `File.type` 作为声明类型发送；FileLimits 匹配与服务端完成确认使用同一规范化结果
 * （工程 Spec §15.4.1）。浏览器无法按文件头识别格式，只用 file-content 的同一份文本判定提前
 * 拒绝声明为文本却不是 UTF-8 文本的内容，其余以服务端按实际字节核验为准。
 */
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
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (requiresTextContentV1(mediaType) && !isTextContentV1(bytes))
		throw new ConversationFileTransferError(false, "content");
	const digest = await crypto.subtle.digest("SHA-256", bytes);
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
