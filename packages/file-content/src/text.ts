/**
 * 纯文本判定与文本子类型声明规则的唯一实现（工程 Spec §15.4.1，#3257）。
 *
 * 本模块不引用 Node 内置模块或第三方依赖：服务端内容探测（`createContentProbe`）与 Web 上传前
 * 检查共用这一份规则，Web 经 `@agent-infra/file-content/text` 引用，不另写白名单或文本判定。
 */

/** 字节只能确认为纯文本、无法确认子类型时的识别结果。 */
export const PLAIN_TEXT_MEDIA_TYPE_V1 = "text/plain";

/**
 * 平台维护的文本子类型白名单。字节识别为纯文本时，只有声明类型在此列表内才会被采用。
 * 调用方、FileLimits 声明与请求体都不能扩展它；增减须修改本常量并同步工程 Spec §15.4.1。
 */
export const TEXT_SUBTYPE_DECLARATIONS_V1: readonly string[] = Object.freeze([
	"application/json",
	"text/csv",
	"text/markdown",
	"text/tab-separated-values",
]);

export function isTextSubtypeDeclarationV1(
	mediaType: string | undefined,
): mediaType is string {
	return (
		mediaType !== undefined && TEXT_SUBTYPE_DECLARATIONS_V1.includes(mediaType)
	);
}

/**
 * 规范化媒体类型：字节识别为 `text/plain` 且声明类型在白名单内时采用声明类型，否则采用字节
 * 识别结果。调用方随后核对规范化结果与声明一致，不一致即拒绝，因此白名单之外的文本子类型、
 * 以及字节不是纯文本的白名单声明（例如实际是 PNG）都会被拒绝。没有声明类型时即字节识别结果。
 */
export function resolveFileMediaTypeV1(
	detectedMediaType: string,
	declaredMediaType?: string,
): string {
	return detectedMediaType === PLAIN_TEXT_MEDIA_TYPE_V1 &&
		isTextSubtypeDeclarationV1(declaredMediaType)
		? declaredMediaType
		: detectedMediaType;
}

/**
 * 声明类型只能由纯文本字节满足（`text/plain` 或白名单子类型）时为 true。这是规范化规则成立的
 * 必要条件而非充分条件：Web 据此在上传前提前拒绝非文本内容，最终结果仍以服务端核验为准。
 */
export function requiresTextContentV1(declaredMediaType: string): boolean {
	return (
		declaredMediaType === PLAIN_TEXT_MEDIA_TYPE_V1 ||
		isTextSubtypeDeclarationV1(declaredMediaType)
	);
}

/**
 * 流式纯文本判定：整体是合法 UTF-8，且除制表符、换行与回车外不含 C0 控制字符（含 NUL）和 DEL。
 */
export function createTextContentDetectorV1() {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = true;
	return {
		write(chunk: Uint8Array) {
			if (!text) return;
			try {
				decoder.decode(chunk, { stream: true });
			} catch {
				text = false;
				return;
			}
			if (
				chunk.some(
					(value) =>
						(value < 32 && value !== 9 && value !== 10 && value !== 13) ||
						value === 127,
				)
			)
				text = false;
		},
		finish(): boolean {
			if (text) {
				try {
					decoder.decode();
				} catch {
					text = false;
				}
			}
			return text;
		},
	};
}

/** 对已在内存中的完整内容执行同一纯文本判定。 */
export function isTextContentV1(bytes: Uint8Array): boolean {
	const detector = createTextContentDetectorV1();
	detector.write(bytes);
	return detector.finish();
}
