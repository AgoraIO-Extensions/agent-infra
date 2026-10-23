import { FileLimitsV1Schema } from "@agent-infra/contracts/files";
import { FileText, Paperclip, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import type { Client } from "../../pilot/generated/client/index.js";
import { client as defaultClient } from "../../pilot/generated/client.gen.js";
import type {
	FileDescriptorV1,
	FileLimitsV1,
	FileProjectionV1,
	PersistedConversationEventV1,
} from "../../pilot/generated/index.js";
import {
	downloadFileContent,
	issueFileAccess,
	readFileLimits,
} from "../../pilot/generated/sdk.gen.js";
import type { Client as ClientV2 } from "../../pilot/generated-v2/client/index.js";
import { readAgentFileLimitsV2 } from "../../pilot/generated-v2/sdk.gen.js";
import {
	ConversationFileTransferError,
	describeConversationFile,
	uploadConversationFile,
} from "./conversation-file-transfer.js";

type UploadStatus = "queued" | "uploading" | "available" | "failed" | "expired";

export type ConversationUpload = {
	localId: string;
	file: File;
	descriptor: FileDescriptorV1 | null;
	projection: FileProjectionV1 | null;
	status: UploadStatus;
	previewUrl?: string;
	error?: string;
};

export type ResultFile = Extract<
	PersistedConversationEventV1,
	{ type: "result.file" }
>["payload"] & {
	executionId: string;
	/** `result.file` V2 的规范化工作区相对路径；V1 事件缺省，无引用的结果为 null。 */
	workspaceReference?: string | null;
};

/**
 * 经当前 File Grant 读取结果文件内容（工程 Spec §15.4.3）：每次先为当前会话主体签发新的
 * 读取授权，Grant 只放在专用请求 Header 中，内容只作为内存 Blob 返回。任何拒绝（撤权、
 * 跨主体或跨会话、过期）与依赖错误都返回 null，调用方不区分原因，不泄漏对象是否存在。
 */
async function readResultFileContent({
	client,
	conversationId,
	fileId,
}: {
	client: Client;
	conversationId: string;
	fileId: string;
}) {
	try {
		const key = `web-result-${crypto.randomUUID()}`;
		const access = await issueFileAccess({
			client,
			path: { conversationId, fileId },
			headers: { "Idempotency-Key": key },
			body: { schemaVersion: 1, operation: "read" },
			responseStyle: "fields",
			throwOnError: false,
		});
		if (!access.data || access.response?.status !== 200) return null;
		const response = await downloadFileContent({
			client,
			path: { conversationId, fileId },
			headers: { "X-Platform-File-Grant": access.data.grant.token },
			parseAs: "blob",
			responseStyle: "fields",
			throwOnError: false,
		});
		if (!response.data || response.response?.status !== 200) return null;
		return response.data;
	} catch {
		return null;
	}
}

export function useConversationFiles({
	agentId,
	conversationId,
	attachmentsEnabled,
	resultFilesEnabled,
	client = defaultClient,
}: {
	agentId: string;
	conversationId: string;
	attachmentsEnabled: boolean;
	resultFilesEnabled: boolean;
	client?: Client;
}) {
	const [limits, setLimits] = useState<FileLimitsV1>();
	const [limitsError, setLimitsError] = useState(false);
	const [uploads, setUploads] = useState<ConversationUpload[]>([]);
	const [downloading, setDownloading] = useState<string>();
	const [reading, setReading] = useState<string>();
	const controllers = useRef(new Map<string, AbortController>());
	const previewUrls = useRef(new Map<string, string>());

	const refreshLimits = useCallback(
		async (signal?: AbortSignal) => {
			if (!attachmentsEnabled || !conversationId) return undefined;
			// An unreadable, mismatched or failed response keeps upload closed.
			const failClosed = () => {
				setLimits(undefined);
				setLimitsError(true);
				return undefined;
			};
			try {
				const result = await readAgentFileLimitsV2({
					client: client as unknown as ClientV2,
					path: { agentId },
					responseStyle: "fields",
					throwOnError: false,
					signal,
				});
				if (signal?.aborted) return undefined;
				if (!result.data || result.response?.status !== 200)
					return failClosed();
				const declaration = result.data.declaration;
				const parsed = FileLimitsV1Schema.safeParse({
					schemaVersion: declaration.schemaVersion,
					revision: String(declaration.revision),
					expiresAt: declaration.expiresAt,
					mediaTypes: declaration.mediaTypes,
					maxBytes: declaration.maxBytes,
				});
				if (!parsed.success) return failClosed();
				setLimits(parsed.data);
				setLimitsError(false);
				return parsed.data;
			} catch {
				if (signal?.aborted) return undefined;
				return failClosed();
			}
		},
		[agentId, attachmentsEnabled, client, conversationId],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset transfer state when the conversation scope changes
	useEffect(() => {
		setUploads([]);
		setLimits(undefined);
		setLimitsError(false);
		return () => {
			for (const controller of controllers.current.values()) controller.abort();
			controllers.current.clear();
			for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
			previewUrls.current.clear();
		};
	}, [conversationId]);
	// The picker stays disabled until the current limits are known, so read them
	// once per conversation scope instead of on the first file selection.
	useEffect(() => {
		const controller = new AbortController();
		void refreshLimits(controller.signal);
		return () => controller.abort();
	}, [refreshLimits]);
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
					item.descriptor ??
					(await describeConversationFile(item.file, fileLimits));
				updateUpload(item.localId, { descriptor });
				const projection = await uploadConversationFile({
					client,
					conversationId,
					file: item.file,
					descriptor,
					idempotencyKey: `web-file-${item.localId}`,
					signal: controller.signal,
				});
				updateUpload(item.localId, {
					status: projection.status === "expired" ? "expired" : "available",
					projection,
				});
			} catch (error) {
				if (controller.signal.aborted) return;
				const expired =
					error instanceof ConversationFileTransferError && error.expired;
				const content =
					error instanceof ConversationFileTransferError &&
					error.reason === "content";
				updateUpload(item.localId, {
					status: expired ? "expired" : "failed",
					error: expired
						? "上传授权已过期，请重试。"
						: content
							? "文件内容不是有效的 UTF-8 文本，与文件类型不符。"
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
				const previewUrl = file.type.startsWith("image/")
					? URL.createObjectURL(file)
					: undefined;
				if (previewUrl) previewUrls.current.set(localId, previewUrl);
				const item: ConversationUpload = {
					localId,
					file,
					descriptor: null,
					projection: null,
					status: "queued",
					previewUrl,
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
		const previewUrl = previewUrls.current.get(localId);
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrls.current.delete(localId);
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

	const readResultFile = useCallback(
		async (file: ResultFile) => {
			if (!resultFilesEnabled || !conversationId || reading) return null;
			setReading(file.fileId);
			try {
				return await readResultFileContent({
					client,
					conversationId,
					fileId: file.fileId,
				});
			} finally {
				setReading(undefined);
			}
		},
		[client, conversationId, reading, resultFilesEnabled],
	);

	// #3228：回答内联图片与预览、下载走同一读取路径，但不占用「准备预览/下载」的单文件状态，
	// 一个回答中的多张图片可以并行读取。
	const readInlineResultFile = useCallback(
		async (file: Pick<ResultFile, "fileId">) => {
			if (!resultFilesEnabled || !conversationId) return null;
			return readResultFileContent({
				client,
				conversationId,
				fileId: file.fileId,
			});
		},
		[client, conversationId, resultFilesEnabled],
	);

	const download = useCallback(
		async (file: ResultFile) => {
			if (!resultFilesEnabled || !conversationId || downloading || reading)
				return false;
			setDownloading(file.fileId);
			try {
				const content = await readResultFile(file);
				if (!content) return false;
				const url = URL.createObjectURL(content);
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = file.name;
				anchor.click();
				setTimeout(() => URL.revokeObjectURL(url), 0);
				return true;
			} finally {
				setDownloading(undefined);
			}
		},
		[conversationId, downloading, readResultFile, reading, resultFilesEnabled],
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
		readResultFile,
		readInlineResultFile,
		downloading,
		reading,
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
	const inputRef = useRef<HTMLInputElement>(null);
	if (!attachmentsEnabled) return null;
	const unavailable = !limits || limitsError;
	return (
		<div className="space-y-2" data-testid="conversation-file-picker">
			<div className="flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="outline"
					disabled={unavailable}
					onClick={() => inputRef.current?.click()}
				>
					<Paperclip aria-hidden="true" /> 添加附件
				</Button>
				<span className="sr-only">
					<Input
						ref={inputRef}
						type="file"
						multiple
						tabIndex={-1}
						aria-label="添加附件"
						accept={limits?.mediaTypes.join(",")}
						disabled={unavailable}
						onChange={(event) => {
							if (event.currentTarget.files)
								onSelect([...event.currentTarget.files]);
							event.currentTarget.value = "";
						}}
					/>
				</span>
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
					{item.previewUrl ? (
						<img
							className="size-10 rounded border object-cover"
							src={item.previewUrl}
							alt=""
							aria-hidden="true"
						/>
					) : (
						<FileText
							aria-hidden="true"
							className="size-4 text-muted-foreground"
						/>
					)}
					<span className="min-w-0 flex-1 truncate">{item.file.name}</span>
					{item.status === "uploading" && <span role="status">上传中…</span>}
					{item.status === "available" && <span role="status">已上传</span>}
					{(item.status === "failed" || item.status === "expired") && (
						<>
							{/* 上传失败是操作结果：role="alert"；行内紧凑展示，不加图标（B-10）。 */}
							<Alert
								tone="danger"
								role="alert"
								icon={null}
								className="max-w-sm py-1"
							>
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
