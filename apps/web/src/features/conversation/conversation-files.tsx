import { FileLimitsV1Schema } from "@agent-infra/contracts/files";
import { Paperclip } from "lucide-react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
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
	describeConversationFile,
	uploadConversationFile,
} from "./conversation-file-transfer.js";
import {
	UploadRowList,
	uploadFailure,
	uploadRowRetryable,
	useUploadRows,
} from "./conversation-upload-rows.js";

type UploadStatus = "queued" | "uploading" | "available" | "failed" | "expired";

export type ConversationUpload = {
	localId: string;
	file: File;
	descriptor: FileDescriptorV1 | null;
	projection: FileProjectionV1 | null;
	status: UploadStatus;
	previewUrl?: string;
	error?: string;
	/** 失败能否原样重试；预检拒绝与内容不是 UTF-8 文本为 false（#3267）。 */
	retryable?: boolean;
};

/** 上传前按当前会话限制拒绝的原因（PRD §12.1：上传前拒绝不符合要求的文件）。 */
export function preflightRejection(
	file: Pick<File, "size" | "type">,
	limits: Pick<FileLimitsV1, "maxBytes" | "mediaTypes">,
) {
	if (file.size > limits.maxBytes)
		return `文件超过 ${formatBytes(limits.maxBytes)} 限制。`;
	if (!limits.mediaTypes.includes(file.type || "application/octet-stream"))
		return "当前 Agent 不支持此文件类型。";
	return undefined;
}

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
			updateUpload(item.localId, {
				status: "uploading",
				error: undefined,
				retryable: undefined,
			});
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
				// 与 Skill 控制文件同一套失败分类（conversation-upload-rows）：内容不是 UTF-8 文本
				// 是确定性失败，只给原因不给「重试」。
				updateUpload(item.localId, uploadFailure(error));
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
				const rejection = preflightRejection(file, fileLimits);
				if (rejection) {
					// 上传前按会话限制拒绝（PRD §12.1）：确定性失败，保留原因，不提供「重试」。
					updateUpload(localId, {
						status: "failed",
						error: rejection,
						retryable: false,
					});
					continue;
				}
				void transfer(item, fileLimits);
			}
		},
		[
			attachmentsEnabled,
			conversationId,
			limits,
			refreshLimits,
			transfer,
			updateUpload,
		],
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
			if (!item || !uploadRowRetryable(item)) return;
			void (async () => {
				const fileLimits =
					item.status === "expired"
						? await refreshLimits()
						: (limits ?? (await refreshLimits()));
				if (!fileLimits) return;
				// 授权过期后重读的限制可能已经不接受这个文件：按预检原因停下，不再重试。
				const rejection = preflightRejection(item.file, fileLimits);
				if (rejection) {
					updateUpload(localId, {
						status: "failed",
						error: rejection,
						retryable: false,
					});
					return;
				}
				await transfer(item, fileLimits);
			})();
		},
		[limits, refreshLimits, transfer, updateUpload, uploads],
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

/**
 * 「会话文件」折叠条内的附件区（#3267）：导出稿只画了收起摘要与两行示例，限制、读取中、
 * 不可用、拒绝原因与缩略图以 docs/development/web-ui.md「对话会话文件附件」为准。与 Skill
 * 控制文件同一套规则：不能上传时只有一行说明；可上传时为「添加附件」与一行限制说明（静态，
 * 不是 live region）；文件行、播报与动作后的焦点共用 conversation-upload-rows。
 */
export function ConversationFilePicker({
	attachmentsEnabled,
	limits,
	limitsError,
	uploads,
	onSelect,
	onRemove,
	onRetry,
	fallbackFocus,
}: {
	attachmentsEnabled: boolean;
	limits?: FileLimitsV1;
	limitsError: boolean;
	uploads: readonly ConversationUpload[];
	onSelect: (files: readonly File[]) => void;
	onRemove: (localId: string) => void;
	onRetry: (localId: string) => void;
	/** 移除后「添加附件」不可用时的焦点去处（对话输入框），不让焦点落到 body。 */
	fallbackFocus?: RefObject<HTMLElement | null>;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const addRef = useRef<HTMLButtonElement>(null);
	const limitId = useId();
	const rows = useMemo(
		() =>
			uploads.map((item) => ({
				localId: item.localId,
				name: item.file.name,
				status: item.status,
				error: item.error,
				retryable: item.retryable,
				thumbnail: item.previewUrl,
			})),
		[uploads],
	);
	const { names, announcement, announceRemoval } = useUploadRows(rows);
	if (!attachmentsEnabled) return null;
	// 不能上传时只保留一行说明：不显示禁用的入口，也不显示此时没有意义的限制（#3259 同一规则）。
	const notice = limitsError
		? "文件限制暂不可用，上传入口已关闭。"
		: !limits
			? "正在读取文件限制…"
			: undefined;
	return (
		<div className="conversation-files" data-testid="conversation-file-picker">
			{notice || !limits ? (
				<p className="conversation-files-notice">{notice}</p>
			) : (
				<div className="conversation-files-head">
					<Button
						ref={addRef}
						type="button"
						variant="outline"
						aria-describedby={limitId}
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
							// 与可见的「添加附件」不同名：同页不出现同名控件（N-12）。
							aria-label="选择附件文件"
							accept={limits.mediaTypes.join(",")}
							onChange={(event) => {
								if (event.currentTarget.files)
									onSelect([...event.currentTarget.files]);
								event.currentTarget.value = "";
							}}
						/>
					</span>
					<small id={limitId}>
						支持 {limits.mediaTypes.join(", ")}，单文件最大{" "}
						{formatBytes(limits.maxBytes)}
					</small>
				</div>
			)}
			{rows.length > 0 && (
				<UploadRowList
					rows={rows}
					names={names}
					variant="card"
					removeLabel="移除附件"
					onRetry={onRetry}
					onRemove={(localId, name) => {
						// 被移除的行随即卸载：先把焦点交给「添加附件」，入口不可用时交给输入框。
						(addRef.current ?? fallbackFocus?.current)?.focus();
						announceRemoval(name);
						onRemove(localId);
					}}
				/>
			)}
			<p className="sr-only" role="status">
				{announcement}
			</p>
		</div>
	);
}

export function formatBytes(value: number) {
	if (value < 1024) return `${value} B`;
	if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
	if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
	return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
