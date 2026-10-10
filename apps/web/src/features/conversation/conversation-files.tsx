import { Paperclip, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import type { Client } from "../../pilot/generated/client/index.js";
import { client as defaultClient } from "../../pilot/generated/client.gen.js";
import type {
	FileDescriptorV1,
	FileLimitsV1,
	FileProjectionV1,
	PersistedConversationEventV1,
} from "../../pilot/generated/index.js";
import {
	completeFileUpload,
	createFileUpload,
	downloadFileContent,
	issueFileAccess,
	readFileLimits,
	uploadFileContent,
} from "../../pilot/generated/sdk.gen.js";

type UploadStatus = "queued" | "uploading" | "available" | "failed" | "expired";

export type ConversationUpload = {
	localId: string;
	file: File;
	descriptor: FileDescriptorV1 | null;
	projection: FileProjectionV1 | null;
	status: UploadStatus;
	error?: string;
};

export type ResultFile = Extract<
	PersistedConversationEventV1,
	{ type: "result.file" }
>["payload"] & { executionId: string };

export function useConversationFiles({
	conversationId,
	attachmentsEnabled,
	resultFilesEnabled,
	client = defaultClient,
}: {
	conversationId: string;
	attachmentsEnabled: boolean;
	resultFilesEnabled: boolean;
	client?: Client;
}) {
	const [limits, setLimits] = useState<FileLimitsV1>();
	const [limitsError, setLimitsError] = useState(false);
	const [uploads, setUploads] = useState<ConversationUpload[]>([]);
	const [downloading, setDownloading] = useState<string>();
	const controllers = useRef(new Map<string, AbortController>());

	const refreshLimits = useCallback(async () => {
		if (!attachmentsEnabled || !conversationId) return undefined;
		const result = await readFileLimits({
			client,
			path: { conversationId },
			responseStyle: "fields",
			throwOnError: false,
		});
		if (!result.data || result.response?.status !== 200) {
			setLimits(undefined);
			setLimitsError(true);
			return undefined;
		}
		setLimits(result.data);
		setLimitsError(false);
		return result.data;
	}, [attachmentsEnabled, client, conversationId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset transfer state when the conversation scope changes
	useEffect(() => {
		setUploads([]);
		setLimits(undefined);
		setLimitsError(false);
		return () => {
			for (const controller of controllers.current.values()) controller.abort();
			controllers.current.clear();
		};
	}, [conversationId]);
	useEffect(() => {
		if (attachmentsEnabled && conversationId) void refreshLimits();
	}, [attachmentsEnabled, conversationId, refreshLimits]);

	const updateUpload = useCallback(
		(localId: string, patch: Partial<ConversationUpload>) => {
			setUploads((current) =>
				current.map((item) =>
					item.localId === localId ? { ...item, ...patch } : item,
				),
			);
		},
		[],
	);

	const transfer = useCallback(
		async (item: ConversationUpload, fileLimits: FileLimitsV1) => {
			const controller = new AbortController();
			controllers.current.set(item.localId, controller);
			updateUpload(item.localId, { status: "uploading", error: undefined });
			try {
				const descriptor =
					item.descriptor ?? (await describeFile(item.file, fileLimits));
				updateUpload(item.localId, { descriptor });
				const key = `web-file-${item.localId}`;
				const created = await createFileUpload({
					client,
					path: { conversationId },
					headers: { "Idempotency-Key": key },
					body: { schemaVersion: 1, descriptor },
					responseStyle: "fields",
					throwOnError: false,
					signal: controller.signal,
				});
				if (!created.data || created.response?.status !== 201)
					throw new UploadError(isExpired(created.response?.status));
				const access = await issueFileAccess({
					client,
					path: { conversationId, fileId: created.data.fileId },
					headers: { "Idempotency-Key": `${key}-access` },
					body: { schemaVersion: 1, operation: "write" },
					responseStyle: "fields",
					throwOnError: false,
					signal: controller.signal,
				});
				if (!access.data || access.response?.status !== 200)
					throw new UploadError(isExpired(access.response?.status));
				const bytes = await uploadFileContent({
					client,
					path: { conversationId, fileId: created.data.fileId },
					headers: {
						"X-Platform-File-Grant": access.data.grant.token,
						"Content-Length": descriptor.sizeBytes,
					},
					body: item.file,
					responseStyle: "fields",
					throwOnError: false,
					signal: controller.signal,
				});
				if (bytes.response?.status !== 204)
					throw new UploadError(isExpired(bytes.response?.status));
				const completed = await completeFileUpload({
					client,
					path: { conversationId, fileId: created.data.fileId },
					headers: { "X-Platform-File-Grant": access.data.grant.token },
					body: { schemaVersion: 1, accessId: access.data.accessId },
					responseStyle: "fields",
					throwOnError: false,
					signal: controller.signal,
				});
				if (!completed.data || completed.response?.status !== 200)
					throw new UploadError(isExpired(completed.response?.status));
				updateUpload(item.localId, {
					status: completed.data.status === "expired" ? "expired" : "available",
					projection: completed.data,
				});
			} catch (error) {
				if (controller.signal.aborted) return;
				updateUpload(item.localId, {
					status:
						error instanceof UploadError && error.expired
							? "expired"
							: "failed",
					error:
						error instanceof UploadError && error.expired
							? "上传授权已过期，请重试。"
							: "上传失败，请重试。",
				});
			} finally {
				controllers.current.delete(item.localId);
			}
		},
		[client, conversationId, updateUpload],
	);

	const addFiles = useCallback(
		async (selected: readonly File[]) => {
			if (!attachmentsEnabled || !conversationId || !selected.length) return;
			const fileLimits = limits ?? (await refreshLimits());
			if (!fileLimits) return;
			for (const file of selected) {
				const localId = crypto.randomUUID();
				const item: ConversationUpload = {
					localId,
					file,
					descriptor: null,
					projection: null,
					status: "queued",
				};
				setUploads((current) => [...current, item]);
				if (
					file.size > fileLimits.maxBytes ||
					!fileLimits.mediaTypes.includes(
						file.type || "application/octet-stream",
					)
				) {
					setUploads((current) =>
						current.map((entry) =>
							entry.localId === localId
								? {
										...entry,
										status: "failed",
										error:
											file.size > fileLimits.maxBytes
												? `文件超过 ${formatBytes(fileLimits.maxBytes)} 限制。`
												: "当前 Agent 不支持此文件类型。",
									}
								: entry,
						),
					);
					continue;
				}
				void transfer(item, fileLimits);
			}
		},
		[attachmentsEnabled, conversationId, limits, refreshLimits, transfer],
	);

	const remove = useCallback((localId: string) => {
		controllers.current.get(localId)?.abort();
		controllers.current.delete(localId);
		setUploads((current) => current.filter((item) => item.localId !== localId));
	}, []);

	const retry = useCallback(
		(localId: string) => {
			const item = uploads.find((entry) => entry.localId === localId);
			if (!item || (item.status !== "failed" && item.status !== "expired"))
				return;
			void (async () => {
				const fileLimits =
					item.status === "expired"
						? await refreshLimits()
						: (limits ?? (await refreshLimits()));
				if (fileLimits) await transfer(item, fileLimits);
			})();
		},
		[limits, refreshLimits, transfer, uploads],
	);

	const download = useCallback(
		async (file: ResultFile) => {
			if (!resultFilesEnabled || !conversationId || downloading) return false;
			setDownloading(file.fileId);
			try {
				const key = `web-result-${crypto.randomUUID()}`;
				const access = await issueFileAccess({
					client,
					path: { conversationId, fileId: file.fileId },
					headers: { "Idempotency-Key": key },
					body: { schemaVersion: 1, operation: "read" },
					responseStyle: "fields",
					throwOnError: false,
				});
				if (!access.data || access.response?.status !== 200) return false;
				const response = await downloadFileContent({
					client,
					path: { conversationId, fileId: file.fileId },
					headers: { "X-Platform-File-Grant": access.data.grant.token },
					parseAs: "blob",
					responseStyle: "fields",
					throwOnError: false,
				});
				if (!response.data || response.response?.status !== 200) return false;
				const url = URL.createObjectURL(response.data);
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = file.name;
				anchor.click();
				setTimeout(() => URL.revokeObjectURL(url), 0);
				return true;
			} catch {
				return false;
			} finally {
				setDownloading(undefined);
			}
		},
		[client, conversationId, downloading, resultFilesEnabled],
	);

	return {
		limits,
		limitsError,
		uploads,
		attachments: uploads
			.filter((item) => item.status === "available" && item.projection)
			.map((item) => item.projection?.fileId as string),
		uploading: uploads.some(
			(item) => item.status === "queued" || item.status === "uploading",
		),
		addFiles,
		remove,
		retry,
		download,
		downloading,
		refreshLimits,
	};
}

export function ConversationFilePicker({
	attachmentsEnabled,
	limits,
	limitsError,
	uploads,
	onSelect,
	onRemove,
	onRetry,
}: {
	attachmentsEnabled: boolean;
	limits?: FileLimitsV1;
	limitsError: boolean;
	uploads: readonly ConversationUpload[];
	onSelect: (files: readonly File[]) => void;
	onRemove: (localId: string) => void;
	onRetry: (localId: string) => void;
}) {
	const inputId = "conversation-file-picker";
	if (!attachmentsEnabled) return null;
	return (
		<div className="space-y-2" data-testid="conversation-file-picker">
			<div className="flex flex-wrap items-center gap-2">
				<Label htmlFor={inputId} className="sr-only">
					添加附件
				</Label>
				<Input
					id={inputId}
					type="file"
					multiple
					accept={limits?.mediaTypes.join(",")}
					disabled={!limits || limitsError}
					className="sr-only"
					onChange={(event) => {
						if (event.currentTarget.files)
							onSelect([...event.currentTarget.files]);
						event.currentTarget.value = "";
					}}
				/>
				<Label
					htmlFor={inputId}
					aria-disabled={!limits || limitsError}
					className={`${buttonVariants({ variant: "outline" })} ${!limits || limitsError ? "pointer-events-none opacity-50" : "cursor-pointer"}`}
				>
					<Paperclip aria-hidden="true" /> 添加附件
				</Label>
				{limits ? (
					<p className="text-muted-foreground text-xs" role="status">
						支持 {limits.mediaTypes.join(", ")}，单文件最大{" "}
						{formatBytes(limits.maxBytes)}
					</p>
				) : limitsError ? (
					<p className="text-muted-foreground text-xs" role="status">
						文件限制暂不可用，上传入口已关闭。
					</p>
				) : (
					<p className="text-muted-foreground text-xs" role="status">
						正在读取文件类型和大小限制…
					</p>
				)}
			</div>
			{uploads.map((item) => (
				<div
					key={item.localId}
					className="flex items-center gap-2 text-sm"
					data-file-status={item.status}
				>
					<span className="min-w-0 flex-1 truncate">{item.file.name}</span>
					{item.status === "uploading" && <span role="status">上传中…</span>}
					{item.status === "available" && <span role="status">已上传</span>}
					{(item.status === "failed" || item.status === "expired") && (
						<>
							<Alert variant="destructive" className="max-w-sm py-1">
								<AlertDescription>{item.error}</AlertDescription>
							</Alert>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => onRetry(item.localId)}
							>
								<RotateCw aria-hidden="true" /> 重试
							</Button>
						</>
					)}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-label={`移除附件 ${item.file.name}`}
						onClick={() => onRemove(item.localId)}
					>
						<X aria-hidden="true" />
					</Button>
				</div>
			))}
		</div>
	);
}

export function formatBytes(value: number) {
	if (value < 1024) return `${value} B`;
	if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
	if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
	return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

async function describeFile(
	file: File,
	limits: FileLimitsV1,
): Promise<FileDescriptorV1> {
	const mediaType = file.type || "application/octet-stream";
	if (!limits.mediaTypes.includes(mediaType)) throw new UploadError(false);
	if (file.size > limits.maxBytes) throw new UploadError(false);
	if (!globalThis.crypto?.subtle) throw new UploadError(false);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		await file.arrayBuffer(),
	);
	const sha256 = [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
	return { name: file.name, mediaType, sizeBytes: file.size, sha256 };
}

function isExpired(status?: number) {
	return status === 401 || status === 403 || status === 404;
}

class UploadError extends Error {
	readonly expired: boolean;
	constructor(expired: boolean) {
		super("file transfer failed");
		this.expired = expired;
	}
}
