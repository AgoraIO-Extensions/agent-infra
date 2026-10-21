import { Download, FileText, Image as ImageIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../components/ui/dialog.js";
import type { ResultFile } from "./conversation-files.js";

const maxPreviewBytes = 1024 * 1024;

const textExtensions = new Set([
	".c",
	".cc",
	".cpp",
	".css",
	".diff",
	".go",
	".h",
	".hpp",
	".html",
	".java",
	".js",
	".json",
	".jsx",
	".log",
	".md",
	".patch",
	".py",
	".rs",
	".sh",
	".sql",
	".svg",
	".ts",
	".tsx",
	".txt",
	".xml",
	".yaml",
	".yml",
]);

export type ArtifactPreviewKind =
	| "image"
	| "pdf"
	| "html"
	| "text"
	| "diff"
	| "none";

function extension(name: string) {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

export function artifactPreviewKind(
	file: Pick<ResultFile, "name" | "mediaType">,
): ArtifactPreviewKind {
	if (file.mediaType.startsWith("image/")) return "image";
	if (file.mediaType === "application/pdf") return "pdf";
	if (file.mediaType === "text/html" || extension(file.name) === ".html")
		return "html";
	if (
		file.mediaType === "text/x-diff" ||
		file.mediaType === "text/x-patch" ||
		extension(file.name) === ".diff" ||
		extension(file.name) === ".patch"
	)
		return "diff";
	if (
		file.mediaType.startsWith("text/") ||
		textExtensions.has(extension(file.name))
	)
		return "text";
	return "none";
}

export function artifactCanPreview(
	file: Pick<ResultFile, "name" | "mediaType" | "sizeBytes">,
) {
	return (
		artifactPreviewKind(file) !== "none" && file.sizeBytes <= maxPreviewBytes
	);
}

type DiffRow = {
	kind: "file" | "hunk" | "add" | "del" | "context" | "meta";
	text: string;
};

export function parseUnifiedDiff(value: string) {
	let additions = 0;
	let deletions = 0;
	const rows: DiffRow[] = [];
	for (const line of value.split(/\r?\n/)) {
		if (
			line.startsWith("diff --git") ||
			line.startsWith("--- ") ||
			line.startsWith("+++ ")
		) {
			rows.push({ kind: "file", text: line });
		} else if (line.startsWith("@@")) {
			rows.push({ kind: "hunk", text: line });
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			additions += 1;
			rows.push({ kind: "add", text: line });
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			deletions += 1;
			rows.push({ kind: "del", text: line });
		} else if (line.startsWith(" ")) {
			rows.push({ kind: "context", text: line });
		} else if (line.length > 0) {
			rows.push({ kind: "meta", text: line });
		}
	}
	return { additions, deletions, rows };
}

function useObjectUrl(value: Blob | null) {
	const [url, setUrl] = useState<string>();
	useEffect(() => {
		if (!value) {
			setUrl(undefined);
			return;
		}
		const next = URL.createObjectURL(value);
		setUrl(next);
		return () => URL.revokeObjectURL(next);
	}, [value]);
	return url;
}

function DiffPreview({ text }: { text: string }) {
	const parsed = useMemo(() => parseUnifiedDiff(text), [text]);
	return (
		<div
			className="artifact-diff space-y-3"
			data-testid="artifact-diff-preview"
		>
			<fieldset className="flex flex-wrap gap-3 text-xs">
				<legend className="sr-only">代码差异统计</legend>
				<span className="text-emerald-700 dark:text-emerald-300">
					+{parsed.additions} 新增
				</span>
				<span className="text-red-700 dark:text-red-300">
					-{parsed.deletions} 删除
				</span>
			</fieldset>
			<section className="artifact-diff-code" aria-label="代码差异">
				<pre>
					{parsed.rows.map((row, index) => (
						<div
							key={`${index}-${row.text}`}
							className={`artifact-diff-row artifact-diff-${row.kind}`}
						>
							{row.text || " "}
						</div>
					))}
				</pre>
			</section>
		</div>
	);
}

function TextPreview({
	content,
	kind,
}: {
	content: Blob;
	kind: "text" | "diff";
}) {
	const [text, setText] = useState<string>();
	const [error, setError] = useState(false);
	useEffect(() => {
		let active = true;
		setText(undefined);
		setError(false);
		void content
			.text()
			.then((value) => {
				if (active) setText(value);
			})
			.catch(() => {
				if (active) setError(true);
			});
		return () => {
			active = false;
		};
	}, [content]);
	if (error)
		return (
			<Alert tone="danger">
				<AlertDescription>文件内容无法读取。</AlertDescription>
			</Alert>
		);
	if (text === undefined) return <p role="status">正在准备预览…</p>;
	return kind === "diff" ? (
		<DiffPreview text={text} />
	) : (
		<section className="artifact-text-preview" aria-label="文本预览">
			<pre>{text}</pre>
		</section>
	);
}

export function ArtifactPreviewDialog({
	file,
	content,
	open,
	loading,
	error,
	onOpenChange,
	onRetry,
	onDownload,
}: {
	file: ResultFile | undefined;
	content: Blob | null;
	open: boolean;
	loading: boolean;
	error?: string;
	onOpenChange: (open: boolean) => void;
	onRetry: () => void;
	onDownload: () => void;
}) {
	const kind = file ? artifactPreviewKind(file) : "none";
	const url = useObjectUrl(content);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="artifact-preview-dialog"
				aria-describedby={undefined}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{kind === "image" ? (
							<ImageIcon aria-hidden="true" />
						) : (
							<FileText aria-hidden="true" />
						)}
						{file?.name ?? "产物预览"}
					</DialogTitle>
				</DialogHeader>
				<DialogBody>
					{loading && <p role="status">正在准备预览…</p>}
					{error && (
						<Alert tone="danger" className="space-y-2">
							<AlertDescription>{error}</AlertDescription>
							<Button variant="outline" onClick={onRetry}>
								重新读取
							</Button>
						</Alert>
					)}
					{!loading && !error && content && kind === "image" && (
						<img
							className="max-h-[60dvh] max-w-full rounded border object-contain"
							src={url}
							alt={file?.name ?? "结果图片"}
						/>
					)}
					{!loading && !error && content && kind === "pdf" && (
						<iframe
							className="h-[60dvh] w-full rounded border"
							src={url}
							title={file?.name ?? "PDF 预览"}
							sandbox=""
						/>
					)}
					{!loading && !error && content && kind === "html" && (
						<iframe
							className="h-[60dvh] w-full rounded border"
							src={url}
							title={file?.name ?? "HTML 预览"}
							sandbox=""
						/>
					)}
					{!loading &&
						!error &&
						content &&
						(kind === "text" || kind === "diff") && (
							<TextPreview content={content} kind={kind} />
						)}
					{!loading && !error && kind === "none" && (
						<p>该文件类型暂不支持在线预览，请下载后查看。</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={onDownload}>
						<Download aria-hidden="true" />
						下载
					</Button>
					<DialogClose render={<Button variant="default">关闭</Button>} />
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
