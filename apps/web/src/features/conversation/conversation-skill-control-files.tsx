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
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import type { Client } from "../../pilot/generated/client/index.js";
import { client as defaultClient } from "../../pilot/generated/client.gen.js";
import type { FileLimitsV1 } from "../../pilot/generated/index.js";
import {
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
import {
	UploadRowList,
	uploadFailure,
	uploadRowRetryable,
	useUploadRows,
} from "./conversation-upload-rows.js";

/** 会话文件限制是否接受控制文件的类型；不接受时整块只留一行说明（#3267 N8-1-03）。 */
function acceptsControlFiles(limits: FileLimitsV1) {
	return limits.mediaTypes.includes(skillControlFileLimitV1.mediaType);
}

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
			update(entry.localId, {
				status: "uploading",
				error: undefined,
				retryable: undefined,
			});
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
				// 与会话附件同一套失败分类：内容不是 UTF-8 文本时给出原因，不提供「重试」。
				update(entry.localId, uploadFailure(failure));
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
			// 区块在限制不接受 text/plain 时不提供入口；这里仍按同一条件拒绝，不创建上传。
			if (!limits || !acceptsControlFiles(limits)) return;
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
			if (!entry || !limits || !uploadRowRetryable(entry)) return;
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

/**
 * 已选 Skill 的控制文件区块。导出稿暂无此区块（待设计回写），结构、尺寸与状态以
 * docs/development/web-ui.md「对话 Skill 控制文件」为准：与已选 Skill 卡、错误行同一套内缩；
 * 可上传时为标题、「添加文本文件」与一行限制说明；不可上传、限制读取中、不可用或会话限制
 * 不接受 text/plain 时只有一行说明。文件行、播报与焦点与会话附件共用 conversation-upload-rows。
 */
export function SkillControlFilePicker({
	attachmentsEnabled,
	limits,
	limitsError,
	entries,
	error,
	onSelect,
	onRemove,
	onRetry,
	textarea,
}: SkillControlFilePickerProps & {
	/** 移除后「添加文本文件」不可用时，焦点回到输入框而不是 body。 */
	textarea: RefObject<HTMLTextAreaElement | null>;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const addRef = useRef<HTMLButtonElement>(null);
	const limitId = useId();
	const rows = useMemo(
		() =>
			entries.map((entry) => ({
				localId: entry.localId,
				name: entry.file.name,
				status: entry.status,
				error: entry.error,
				retryable: entry.retryable,
			})),
		[entries],
	);
	const { names, announcement, announceRemoval } = useUploadRows(rows);
	// 不能上传时只保留一行说明：不显示禁用的入口，也不显示此时没有意义的限制。
	const notice = !attachmentsEnabled
		? "当前 Agent 不支持上传控制文件，只能提交任务说明。"
		: limitsError
			? "文件限制暂不可用，上传入口已关闭。"
			: !limits
				? "正在读取文件限制…"
				: !acceptsControlFiles(limits)
					? "当前会话不接受 text/plain 文件，只能提交任务说明。"
					: undefined;
	return (
		<div
			className="skill-control-files"
			data-testid="skill-control-file-picker"
		>
			{notice ? (
				<p className="skill-control-files-notice">{notice}</p>
			) : (
				<div className="skill-control-files-head">
					<div>
						<strong>Skill 控制文件</strong>
						<small id={limitId}>
							仅支持 {skillControlFileLimitV1.mediaType} 文本文件，最多{" "}
							{skillControlFileLimitV1.maxFiles} 个，单个文件不超过{" "}
							{skillControlFileLimitV1.maxBytes} 字节。
						</small>
					</div>
					<Button
						ref={addRef}
						type="button"
						variant="outline"
						size="sm"
						aria-describedby={limitId}
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
							onChange={(event) => {
								if (event.currentTarget.files)
									onSelect([...event.currentTarget.files]);
								event.currentTarget.value = "";
							}}
						/>
					</span>
				</div>
			)}
			{error && (
				<Alert
					tone="danger"
					role="alert"
					icon={null}
					className="capability-inline-alert"
				>
					{error}
				</Alert>
			)}
			{rows.length > 0 && (
				<UploadRowList
					rows={rows}
					names={names}
					variant="compact"
					removeLabel="移除控制文件"
					onRetry={onRetry}
					onRemove={(localId, name) => {
						// 被移除的行随即卸载：先把焦点交给「添加文本文件」，入口不可用时交给输入框。
						(addRef.current ?? textarea.current)?.focus();
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
