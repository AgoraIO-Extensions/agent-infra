/**
 * Invocation V2 的 Skill 控制文件限制（PRD §11.3、§12.1；契约 §2887）：
 * 浏览器只上传已就绪的 `text/plain` 文件，按选择顺序最多 4 个、每个不超过
 * 4096 字节；文件 id 由平台文件上传接口返回，页面不构造摘要或授权。
 */
export const skillControlFileLimitV1 = Object.freeze({
	maxFiles: 4,
	maxBytes: 4096,
	mediaType: "text/plain",
} as const);

export type SkillControlFileStatus =
	| "uploading"
	| "available"
	| "failed"
	| "expired";

export type SkillControlFileEntry = Readonly<{
	localId: string;
	file: File;
	status: SkillControlFileStatus;
	fileId?: string;
	error?: string;
	/** 失败能否原样重试；内容不是 UTF-8 文本等确定性失败为 false（#3267）。 */
	retryable?: boolean;
}>;

type SelectableFile = Pick<File, "type" | "size">;

export function skillControlFileError(file: SelectableFile) {
	if (file.type !== skillControlFileLimitV1.mediaType)
		return `仅支持 ${skillControlFileLimitV1.mediaType} 文本文件。`;
	if (file.size > skillControlFileLimitV1.maxBytes)
		return `单个控制文件不能超过 ${skillControlFileLimitV1.maxBytes} 字节。`;
	return undefined;
}

/** 整批选择先整体校验：任一文件不合规时不创建上传，避免半批文件静默缺失。 */
export function skillControlFileSelectionError(
	existing: number,
	selected: readonly SelectableFile[],
) {
	if (existing + selected.length > skillControlFileLimitV1.maxFiles)
		return `最多只能附加 ${skillControlFileLimitV1.maxFiles} 个控制文件。`;
	for (const file of selected) {
		const error = skillControlFileError(file);
		if (error) return error;
	}
	return undefined;
}

/** 只提交已完成上传的文件；顺序就是用户选择顺序。 */
export function skillControlFileIds(
	entries: readonly SkillControlFileEntry[],
): readonly string[] {
	return entries.flatMap((entry) =>
		entry.status === "available" && entry.fileId ? [entry.fileId] : [],
	);
}

/** 上传中或上传失败时不能提交调用：已选控制文件不能被静默省略。 */
export function skillControlFilesReady(
	entries: readonly SkillControlFileEntry[],
) {
	return entries.every(
		(entry) => entry.status === "available" && entry.fileId !== undefined,
	);
}
