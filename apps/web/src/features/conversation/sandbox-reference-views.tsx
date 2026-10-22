import { FileText } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import { Button } from "../../components/ui/button.js";
import { withObjectName } from "../../lib/accessible-name.js";
import {
	artifactCanPreview,
	artifactPreviewKind,
	useObjectUrl,
} from "./conversation-artifact-preview.js";
import { formatBytes, type ResultFile } from "./conversation-files.js";

/**
 * #3228：一条回答渲染 `sandbox:` 引用所需的上下文（工程 Spec §15.4.3 的图片 URL 例外）。
 * 只有命中 `files` 的引用才会经 `readImage` 读取；其余引用一律不发起网络请求。
 */
export type SandboxReferences = Readonly<{
	/** 同一执行内已确认结果文件，按规范化 `workspaceReference` 索引。 */
	files: ReadonlyMap<string, ResultFile>;
	/** 执行已结束：未命中的引用即「未发送」；进行中时结果尚未发布，显示「待发送」。 */
	settled: boolean;
	/** 经当前 File Grant 读取内存 Blob；拒绝或失败返回 null。 */
	readImage?: (file: Pick<ResultFile, "fileId">) => Promise<Blob | null>;
	/** 打开现有预览；内联图片已读到内容时直接复用该 Blob。 */
	onPreview?: (file: ResultFile, content?: Blob) => void;
	onDownload?: (file: ResultFile) => void;
	previewingFileId?: string;
	downloadingFileId?: string;
	/**
	 * 回答中以图片或文件卡渲染了某个结果文件时登记，返回注销函数；下方结果文件列表据此只列名称，
	 * 不再重复渲染预览与下载入口。
	 */
	onRendered?: (fileId: string) => () => void;
}>;

const noReferences: SandboxReferences = { files: new Map(), settled: true };

export const SandboxReferencesContext =
	createContext<SandboxReferences>(noReferences);

/** 回答中实际显示了该结果文件的图片或文件卡：登记给回复卡。 */
function useRenderedFile(fileId: string | undefined) {
	const { onRendered } = useContext(SandboxReferencesContext);
	useLayoutEffect(
		() => (fileId && onRendered ? onRendered(fileId) : undefined),
		[fileId, onRendered],
	);
}

/** 未命中、无效或读取失败的引用：纯文本占位，不加载任何 URL。 */
function NotSent({ kind, label }: { kind: "image" | "file"; label?: string }) {
	const { settled } = useContext(SandboxReferencesContext);
	const state = settled ? "未发送" : "待发送";
	return (
		<span className="sandbox-reference-missing" data-sandbox-state={state}>
			{kind === "image" ? "图片" : "文件"}
			{state}
			{label ? `：${label}` : ""}
		</span>
	);
}

/** `![说明](sandbox:path)`：命中且可预览的图片内联显示，其他命中文件显示为文件卡。 */
export function SandboxImageReference({
	reference,
	alt,
	repeat,
	nested,
}: {
	reference: string;
	alt?: string;
	repeat: boolean;
	nested: boolean;
}) {
	const references = useContext(SandboxReferencesContext);
	const file = reference ? references.files.get(reference) : undefined;
	const label = alt?.trim() || file?.name || "";
	if (repeat) return <span>[图片：{label || "未提供说明"}]</span>;
	if (!file) return <NotSent kind="image" label={label} />;
	if (
		!references.readImage ||
		artifactPreviewKind(file) !== "image" ||
		!artifactCanPreview(file)
	)
		// 类型或大小超出预览上限：只给文件卡（下载），不内联（§15.4.3）。
		return nested ? (
			<span>[图片：{label}]</span>
		) : (
			<SandboxFileCard file={file} caption={alt?.trim() || undefined} />
		);
	return (
		<InlineImage
			file={file}
			label={label}
			read={references.readImage}
			interactive={!nested}
		/>
	);
}

function InlineImage({
	file,
	label,
	read,
	interactive,
}: {
	file: ResultFile;
	label: string;
	read: NonNullable<SandboxReferences["readImage"]>;
	interactive: boolean;
}) {
	const { onPreview } = useContext(SandboxReferencesContext);
	const { fileId } = file;
	const [result, setResult] = useState<{
		fileId: string;
		content: Blob | null;
	}>();
	useEffect(() => {
		let active = true;
		read({ fileId }).then(
			(content) => {
				if (active) setResult({ fileId, content });
			},
			() => {
				if (active) setResult({ fileId, content: null });
			},
		);
		return () => {
			active = false;
		};
	}, [fileId, read]);
	const content = result?.fileId === fileId ? result.content : undefined;
	const url = useObjectUrl(content ?? null);
	// 读取失败时不登记：下方列表保留该文件的预览与下载入口，作为重试途径。
	useRenderedFile(content === null ? undefined : fileId);
	// 读取被拒绝（撤权、跨主体或跨会话、过期）与未发送显示同一占位，不区分原因。
	if (content === null) return <NotSent kind="image" label={label} />;
	if (!content || !url)
		return (
			<span className="sandbox-reference-loading">正在加载图片：{label}</span>
		);
	const image = <img className="sandbox-image-content" src={url} alt={label} />;
	return interactive && onPreview ? (
		<button
			type="button"
			className="sandbox-image"
			aria-label={withObjectName("预览图片", label)}
			onClick={() => onPreview(file, content)}
		>
			{image}
		</button>
	) : (
		<span className="sandbox-image">{image}</span>
	);
}

/** `[说明](sandbox:path)`：命中显示为文件卡；未命中显示说明文字并注明「文件未发送」。 */
export function SandboxLinkReference({
	reference,
	text,
	repeat,
	children,
}: {
	reference: string;
	text: string;
	repeat: boolean;
	children: ReactNode;
}) {
	const { files } = useContext(SandboxReferencesContext);
	const file = reference ? files.get(reference) : undefined;
	if (repeat) return <span>{children}</span>;
	if (!file)
		return (
			<span>
				{children}
				{text.trim() ? "（" : ""}
				<NotSent kind="file" />
				{text.trim() ? "）" : ""}
			</span>
		);
	const caption = text.trim();
	return (
		<SandboxFileCard
			file={file}
			caption={caption && caption !== file.name ? children : undefined}
		/>
	);
}

/** 回答内的结果文件卡：名称、类型、大小、预览与下载，沿用现有 File Grant 读取。 */
export function SandboxFileCard({
	file,
	caption,
}: {
	file: ResultFile;
	caption?: ReactNode;
}) {
	const { onPreview, onDownload, previewingFileId, downloadingFileId } =
		useContext(SandboxReferencesContext);
	const previewing = previewingFileId === file.fileId;
	const downloading = downloadingFileId === file.fileId;
	useRenderedFile(file.fileId);
	return (
		// biome-ignore lint/a11y/useSemanticElements: 文件卡位于段落内，只能是短语内容，不能用 fieldset。
		<span
			className="sandbox-file-card"
			role="group"
			aria-label={withObjectName("结果文件", file.name)}
		>
			<FileText aria-hidden="true" className="sandbox-file-card-icon" />
			<span className="sandbox-file-card-body">
				{caption && (
					<span className="sandbox-file-card-caption">{caption}</span>
				)}
				<span className="sandbox-file-card-name" title={file.name}>
					{file.name}
				</span>
				<span className="sandbox-file-card-meta">
					{file.mediaType} · {formatBytes(file.sizeBytes)}
				</span>
			</span>
			{(onPreview || onDownload) && (
				<span className="sandbox-file-card-actions">
					{onPreview && artifactCanPreview(file) && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={previewing}
							aria-label={withObjectName(
								previewing ? "准备预览…" : "预览",
								file.name,
							)}
							onClick={() => onPreview(file)}
						>
							{previewing ? "准备预览…" : "预览"}
						</Button>
					)}
					{onDownload && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={downloading}
							aria-label={withObjectName(
								downloading ? "准备下载…" : "下载",
								file.name,
							)}
							onClick={() => onDownload(file)}
						>
							{downloading ? "准备下载…" : "下载"}
						</Button>
					)}
				</span>
			)}
		</span>
	);
}
