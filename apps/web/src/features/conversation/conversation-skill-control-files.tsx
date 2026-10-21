import { Paperclip, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import type { Client } from "../../pilot/generated/client/index.js";
import { client as defaultClient } from "../../pilot/generated/client.gen.js";
import type { FileLimitsV1 } from "../../pilot/generated/index.js";
import {
	ConversationFileTransferError,
	describeConversationFile,
	uploadConversationFile,
} from "./conversation-file-transfer.js";
import {
	type SkillControlFileEntry,
	skillControlFileIds,
	skillControlFileLimitV1,
	skillControlFileSelectionError,
	skillControlFilesReady,
} from "./conversation-skill-control-file-model.js";

/**
 * 已选 Skill 的控制文件：上传复用平台文件授权路径（conversation-file-transfer），
 * 只保留完成上传的文件 id，顺序与用户选择一致。上传失败的文件不会被静默省略。
 */
export function useSkillControlFiles({
	conversationId,
	limits,
	enabled,
	client = defaultClient,
}: {
	conversationId: string;
	limits?: FileLimitsV1;
	/** Agent 是否允许上传附件；关闭时不读取限制也不提供上传入口。 */
	enabled: boolean;
	client?: Client;
}) {
	const [entries, setEntries] = useState<SkillControlFileEntry[]>([]);
	const [error, setError] = useState<string>();
	const controllers = useRef(new Map<string, AbortController>());

	useEffect(
		() => () => {
			for (const controller of controllers.current.values()) controller.abort();
			controllers.current.clear();
		},
		[],
	);

	const update = useCallback(
		(localId: string, patch: Partial<SkillControlFileEntry>) => {
			setEntries((current) =>
				current.map((entry) =>
					entry.localId === localId ? { ...entry, ...patch } : entry,
				),
			);
		},
		[],
	);

	const transfer = useCallback(
		async (entry: SkillControlFileEntry, fileLimits: FileLimitsV1) => {
			const controller = new AbortController();
			controllers.current.set(entry.localId, controller);
			update(entry.localId, { status: "uploading", error: undefined });
			try {
				const descriptor = await describeConversationFile(
					entry.file,
					fileLimits,
				);
				const projection = await uploadConversationFile({
					client,
					conversationId,
					file: entry.file,
					descriptor,
					idempotencyKey: `web-skill-file-${entry.localId}`,
					signal: controller.signal,
				});
				update(entry.localId, {
					status: projection.status === "expired" ? "expired" : "available",
					fileId: projection.fileId,
				});
			} catch (failure) {
				if (controller.signal.aborted) return;
				const expired =
					failure instanceof ConversationFileTransferError && failure.expired;
				update(entry.localId, {
					status: expired ? "expired" : "failed",
					error: expired ? "上传授权已过期，请重试。" : "上传失败，请重试。",
				});
			} finally {
				controllers.current.delete(entry.localId);
			}
		},
		[client, conversationId, update],
	);

	const addFiles = useCallback(
		(selected: readonly File[]) => {
			if (!enabled || !conversationId || selected.length === 0) return;
			const rejection = skillControlFileSelectionError(
				entries.length,
				selected,
			);
			if (rejection) {
				setError(rejection);
				return;
			}
			if (!limits?.mediaTypes.includes(skillControlFileLimitV1.mediaType)) {
				setError("当前会话不支持上传 text/plain 控制文件。");
				return;
			}
			setError(undefined);
			for (const file of selected) {
				const entry: SkillControlFileEntry = {
					localId: crypto.randomUUID(),
					file,
					status: "uploading",
				};
				setEntries((current) => [...current, entry]);
				void transfer(entry, limits);
			}
		},
		[conversationId, enabled, entries.length, limits, transfer],
	);

	const remove = useCallback((localId: string) => {
		controllers.current.get(localId)?.abort();
		controllers.current.delete(localId);
		setEntries((current) =>
			current.filter((entry) => entry.localId !== localId),
		);
		setError(undefined);
	}, []);

	const retry = useCallback(
		(localId: string) => {
			const entry = entries.find((item) => item.localId === localId);
			if (
				!entry ||
				(entry.status !== "failed" && entry.status !== "expired") ||
				!limits
			)
				return;
			void transfer(entry, limits);
		},
		[entries, limits, transfer],
	);

	const clear = useCallback(() => {
		for (const controller of controllers.current.values()) controller.abort();
		controllers.current.clear();
		setEntries([]);
		setError(undefined);
	}, []);

	return {
		entries,
		error,
		ready: skillControlFilesReady(entries),
		attachmentIds: skillControlFileIds(entries),
		addFiles,
		remove,
		retry,
		clear,
	};
}

export type SkillControlFilePickerProps = Readonly<{
	attachmentsEnabled: boolean;
	limits?: FileLimitsV1;
	limitsError: boolean;
	entries: readonly SkillControlFileEntry[];
	error?: string;
	onSelect: (files: readonly File[]) => void;
	onRemove: (localId: string) => void;
	onRetry: (localId: string) => void;
}>;

/** 设计 .skill-files：Skill 选择条下方展示控制文件限制、上传状态与移除 / 重试入口。 */
export function SkillControlFilePicker({
	attachmentsEnabled,
	limits,
	limitsError,
	entries,
	error,
	onSelect,
	onRemove,
	onRetry,
}: SkillControlFilePickerProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const unavailable = !attachmentsEnabled || !limits || limitsError;
	return (
		<div className="space-y-2" data-testid="skill-control-file-picker">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium text-sm">Skill 控制文件</span>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={unavailable}
					onClick={() => inputRef.current?.click()}
				>
					<Paperclip aria-hidden="true" /> 添加文本文件
				</Button>
				<span className="sr-only">
					<Input
						ref={inputRef}
						type="file"
						multiple
						tabIndex={-1}
						aria-label="添加 Skill 控制文件"
						accept={skillControlFileLimitV1.mediaType}
						disabled={unavailable}
						onChange={(event) => {
							if (event.currentTarget.files)
								onSelect([...event.currentTarget.files]);
							event.currentTarget.value = "";
						}}
					/>
				</span>
			</div>
			<p className="text-muted-foreground text-xs" role="status">
				仅支持 {skillControlFileLimitV1.mediaType} 文本文件，最多{" "}
				{skillControlFileLimitV1.maxFiles} 个，单个文件不超过{" "}
				{skillControlFileLimitV1.maxBytes} 字节。
			</p>
			{!attachmentsEnabled && (
				<p className="text-muted-foreground text-xs" role="status">
					当前 Agent 不支持上传控制文件，只能提交任务说明。
				</p>
			)}
			{attachmentsEnabled && limitsError && (
				<p className="text-muted-foreground text-xs" role="status">
					文件限制暂不可用，上传入口已关闭。
				</p>
			)}
			{attachmentsEnabled && !limitsError && !limits && (
				<p className="text-muted-foreground text-xs" role="status">
					正在读取文件限制…
				</p>
			)}
			{error && (
				<Alert tone="danger" role="alert" icon={null} className="max-w-sm py-1">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			{entries.map((entry) => (
				<div
					key={entry.localId}
					className="flex items-center gap-2 text-sm"
					data-file-status={entry.status}
				>
					<span className="min-w-0 flex-1 truncate">{entry.file.name}</span>
					{entry.status === "uploading" && <span role="status">上传中…</span>}
					{entry.status === "available" && <span role="status">已上传</span>}
					{(entry.status === "failed" || entry.status === "expired") && (
						<>
							<Alert
								tone="danger"
								role="alert"
								icon={null}
								className="max-w-sm py-1"
							>
								<AlertDescription>{entry.error}</AlertDescription>
							</Alert>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => onRetry(entry.localId)}
							>
								<RotateCw aria-hidden="true" /> 重试
							</Button>
						</>
					)}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-label={`移除控制文件 ${entry.file.name}`}
						onClick={() => onRemove(entry.localId)}
					>
						<X aria-hidden="true" />
					</Button>
				</div>
			))}
		</div>
	);
}
