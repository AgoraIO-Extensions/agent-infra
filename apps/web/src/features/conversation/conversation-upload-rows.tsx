import { FileText, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { distinctObjectNames, withObjectName } from "@/lib/accessible-name";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConversationFileTransferError } from "./conversation-file-transfer.js";

/**
 * 会话文件附件与 Skill 控制文件共用的上传行规则（#3259、#3267）。两处只在排版上不同
 * （附件为导出稿 `.chat-file-row` 式行卡，控制文件为输入框内的紧凑行），状态文案、失败分类、
 * 「重试」是否出现、播报与动作后的焦点都在这里定义，避免两套规则再次分叉。
 */
export type UploadRowStatus =
	| "queued"
	| "uploading"
	| "available"
	| "failed"
	| "expired";

export type UploadRow = Readonly<{
	localId: string;
	name: string;
	status: UploadRowStatus;
	/** 失败与过期时的原因，显示在文件名下方。 */
	error?: string;
	/**
	 * 失败是否可以原样重试。预检拒绝（类型、大小）与内容不是 UTF-8 文本是确定性失败，
	 * 重试必然得到同样结果，不提供「重试」；缺省视为可重试。
	 */
	retryable?: boolean;
	/** 图片附件的本地缩略图（对象 URL）。 */
	thumbnail?: string;
}>;

const statusLabels: Readonly<Partial<Record<UploadRowStatus, string>>> = {
	queued: "上传中…",
	uploading: "上传中…",
	available: "已上传",
};

export const contentNotTextMessage =
	"文件内容不是有效的 UTF-8 文本，与文件类型不符。";

export type UploadFailure = Readonly<{
	status: "failed" | "expired";
	error: string;
	retryable: boolean;
}>;

/**
 * 上传链失败到行状态的唯一映射：授权过期与临时失败可重试；声明为文本却不是 UTF-8 文本
 * （#3257 的 reason=content）在浏览器侧就能确定，重试不会改变结果，只保留原因与移除。
 */
export function uploadFailure(failure: unknown): UploadFailure {
	if (failure instanceof ConversationFileTransferError && failure.expired)
		return {
			status: "expired",
			error: "上传授权已过期，请重试。",
			retryable: true,
		};
	if (
		failure instanceof ConversationFileTransferError &&
		failure.reason === "content"
	)
		return { status: "failed", error: contentNotTextMessage, retryable: false };
	return { status: "failed", error: "上传失败，请重试。", retryable: true };
}

export function uploadRowFailed(row: Pick<UploadRow, "status">) {
	return row.status === "failed" || row.status === "expired";
}

export function uploadRowRetryable(
	row: Pick<UploadRow, "status" | "retryable">,
) {
	return uploadRowFailed(row) && row.retryable !== false;
}

/**
 * 只在上传状态变化时播报（#3259）：区块内一个常驻 live region 读出「{文件名} 上传中… / 已上传」
 * 与移除结果；行内状态与静态说明不带 role="status"。失败由行内 role="alert" 播报，这里不重复。
 * 首次挂载只记下当前状态作为基线：重新挂载（例如窄屏切回对话）不把已有文件当作新变化播报。
 */
export function useUploadRows(rows: readonly UploadRow[]) {
	const names = useMemo(
		() => distinctObjectNames(rows.map((row) => row.name)),
		[rows],
	);
	const [announcement, setAnnouncement] = useState("");
	const previous = useRef<Map<string, UploadRowStatus>>(undefined);
	useEffect(() => {
		const before = previous.current;
		previous.current = new Map(rows.map((row) => [row.localId, row.status]));
		if (!before) return;
		// 只播报变成「上传中」「已上传」的行；排队（queued）不播报，开始上传时才读出。
		const changes = rows.flatMap((row, index) =>
			before.get(row.localId) !== row.status &&
			(row.status === "uploading" || row.status === "available")
				? [`${names[index]} ${statusLabels[row.status]}`]
				: [],
		);
		if (changes.length > 0) setAnnouncement(changes.join("；"));
	}, [rows, names]);
	const announceRemoval = useCallback((name: string) => {
		setAnnouncement(`已移除 ${name}`);
	}, []);
	return { names, announcement, announceRemoval };
}

const variants = {
	/** 会话文件附件：导出稿 `.chat-file-row` 行卡，「重试」为 outline。 */
	card: {
		list: "conversation-file-list",
		row: "conversation-file",
		copy: "conversation-file-copy",
		name: "conversation-file-name",
		retry: "outline",
	},
	/** Skill 控制文件：输入框内的紧凑行（#3259），「重试」为带图标的 ghost。 */
	compact: {
		list: "skill-control-file-list",
		row: "skill-control-file",
		copy: "skill-control-file-copy",
		name: "skill-control-file-name",
		retry: "ghost",
	},
} as const;

/**
 * 文件逐行为图标（或缩略图）、名称与下方一行状态；可重试的失败有「重试：{文件名}」，
 * 行尾为图标按钮「{removeLabel} {文件名}」。同名文件按出现顺序加「（第 N 次）」（N-12）。
 * 重试后「重试」随失败状态卸载，焦点先交给同一行的移除按钮；移除后的焦点由调用方给出。
 */
export function UploadRowList({
	rows,
	names,
	variant,
	removeLabel,
	onRetry,
	onRemove,
}: {
	rows: readonly UploadRow[];
	names: readonly string[];
	variant: keyof typeof variants;
	removeLabel: string;
	onRetry: (localId: string) => void;
	/** 被移除的行随即卸载：调用方先把焦点交给区块入口（或输入框），再移除。 */
	onRemove: (localId: string, name: string) => void;
}) {
	const classes = variants[variant];
	return (
		<ul className={classes.list}>
			{rows.map((row, index) => (
				<UploadRowItem
					key={row.localId}
					row={row}
					name={names[index] ?? row.name}
					classes={classes}
					removeLabel={removeLabel}
					onRetry={onRetry}
					onRemove={onRemove}
				/>
			))}
		</ul>
	);
}

function UploadRowItem({
	row,
	name,
	classes,
	removeLabel,
	onRetry,
	onRemove,
}: {
	row: UploadRow;
	/** 同名文件按出现顺序区分后的名称，用于行内操作的可访问名称。 */
	name: string;
	classes: (typeof variants)[keyof typeof variants];
	removeLabel: string;
	onRetry: (localId: string) => void;
	onRemove: (localId: string, name: string) => void;
}) {
	const removeRef = useRef<HTMLButtonElement>(null);
	const failed = uploadRowFailed(row);
	return (
		<li className={classes.row} data-file-status={row.status}>
			{row.thumbnail ? (
				<img
					className="upload-row-thumbnail"
					src={row.thumbnail}
					alt=""
					aria-hidden="true"
				/>
			) : (
				<FileText aria-hidden="true" />
			)}
			<div className={classes.copy}>
				<span className={classes.name} title={row.name}>
					{row.name}
				</span>
				{failed ? (
					<Alert
						tone="danger"
						role="alert"
						icon={null}
						className="capability-inline-alert upload-row-error"
					>
						{row.error}
					</Alert>
				) : (
					<small>{statusLabels[row.status]}</small>
				)}
			</div>
			{uploadRowRetryable(row) && (
				<Button
					type="button"
					variant={classes.retry}
					size="sm"
					aria-label={withObjectName("重试", name)}
					onClick={() => {
						// 重试后「重试」随失败状态卸载：焦点留在同一行的移除按钮上。
						removeRef.current?.focus();
						onRetry(row.localId);
					}}
				>
					{classes.retry === "ghost" && <RotateCw aria-hidden="true" />} 重试
				</Button>
			)}
			<Button
				ref={removeRef}
				type="button"
				variant="ghost"
				size="icon"
				aria-label={`${removeLabel} ${name}`}
				onClick={() => onRemove(row.localId, name)}
			>
				<X aria-hidden="true" />
			</Button>
		</li>
	);
}
