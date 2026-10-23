import { FileText, Paperclip, RotateCw, X } from "lucide-react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { distinctObjectNames, withObjectName } from "@/lib/accessible-name";
import { Alert } from "../../components/ui/alert.js";
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
	type SkillControlFileStatus,
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

const uploadStatusLabels = {
	uploading: "上传中…",
	available: "已上传",
} as const;

/**
 * 只在上传状态变化时播报（#3259）：一个常驻的 live region 读出「{文件名} 上传中… / 已上传」
 * 与移除结果；行内状态与静态说明不再各带 role="status"。失败由行内 role="alert" 播报，这里不重复。
 */
function useUploadAnnouncement(
	entries: readonly SkillControlFileEntry[],
	names: readonly string[],
) {
	const [message, setMessage] = useState("");
	const previous = useRef(new Map<string, SkillControlFileStatus>());
	useEffect(() => {
		const changes = entries.flatMap((entry, index) =>
			previous.current.get(entry.localId) !== entry.status &&
			(entry.status === "uploading" || entry.status === "available")
				? [`${names[index]} ${uploadStatusLabels[entry.status]}`]
				: [],
		);
		previous.current = new Map(
			entries.map((entry) => [entry.localId, entry.status]),
		);
		if (changes.length > 0) setMessage(changes.join("；"));
	}, [entries, names]);
	return [message, setMessage] as const;
}

/**
 * 已选 Skill 的控制文件区块。导出稿暂无此区块（待设计回写），结构、尺寸与状态以
 * docs/development/web-ui.md「对话 Skill 控制文件」为准：与已选 Skill 卡、错误行同一套内缩；
 * 可上传时为标题、「添加文本文件」与一行限制说明，不可上传、限制读取中或不可用时只有一行说明。
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
	const names = useMemo(
		() => distinctObjectNames(entries.map((entry) => entry.file.name)),
		[entries],
	);
	const [announcement, announce] = useUploadAnnouncement(entries, names);
	// 不能上传时只保留一行说明：不显示禁用的入口，也不显示此时没有意义的限制。
	const notice = !attachmentsEnabled
		? "当前 Agent 不支持上传控制文件，只能提交任务说明。"
		: limitsError
			? "文件限制暂不可用，上传入口已关闭。"
			: !limits
				? "正在读取文件限制…"
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
			{entries.length > 0 && (
				<ul className="skill-control-file-list">
					{entries.map((entry, index) => (
						<SkillControlFileRow
							key={entry.localId}
							entry={entry}
							name={names[index] ?? entry.file.name}
							onRetry={onRetry}
							onRemove={(localId) => {
								// 被移除的行随即卸载：先把焦点交给「添加文本文件」，入口不可用时交给输入框。
								(addRef.current ?? textarea.current)?.focus();
								announce(`已移除 ${names[index] ?? entry.file.name}`);
								onRemove(localId);
							}}
						/>
					))}
				</ul>
			)}
			<p className="sr-only" role="status">
				{announcement}
			</p>
		</div>
	);
}

function SkillControlFileRow({
	entry,
	name,
	onRemove,
	onRetry,
}: {
	entry: SkillControlFileEntry;
	/** 同名文件按出现顺序区分后的名称，用于行内操作的可访问名称（N-12）。 */
	name: string;
	onRemove: (localId: string) => void;
	onRetry: (localId: string) => void;
}) {
	const removeRef = useRef<HTMLButtonElement>(null);
	const failed = entry.status === "failed" || entry.status === "expired";
	return (
		<li className="skill-control-file" data-file-status={entry.status}>
			<FileText aria-hidden="true" />
			<div className="skill-control-file-copy">
				<span className="skill-control-file-name" title={entry.file.name}>
					{entry.file.name}
				</span>
				{failed ? (
					<Alert
						tone="danger"
						role="alert"
						icon={null}
						className="capability-inline-alert"
					>
						{entry.error}
					</Alert>
				) : (
					<small>{uploadStatusLabels[entry.status]}</small>
				)}
			</div>
			{failed && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					aria-label={withObjectName("重试", name)}
					onClick={() => {
						// 重试后「重试」随失败状态卸载：焦点留在同一行的移除按钮上。
						removeRef.current?.focus();
						onRetry(entry.localId);
					}}
				>
					<RotateCw aria-hidden="true" /> 重试
				</Button>
			)}
			<Button
				ref={removeRef}
				type="button"
				variant="ghost"
				size="icon"
				aria-label={`移除控制文件 ${name}`}
				onClick={() => onRemove(entry.localId)}
			>
				<X aria-hidden="true" />
			</Button>
		</li>
	);
}
