import {
	type ExecutionFailureCategoryV1,
	executionFailureMessageV1,
} from "./execution-failure.js";
import {
	parseWecomAnswerReferencesV1,
	rewriteWecomAnswerV1,
	type WecomAnswerReferenceParserV1,
} from "./wecom-reply-media.js";

/**
 * 企微回复文本的组合规则（WECOM-text-deployment.md「共用执行与回复」「思考过程」）。终态回复与
 * #3377 的进度帧共用，只在 Core 内部使用。
 */

/** #2982：企微单条回复的字节上限，答案与思考过程共用。 */
export const wecomReplyMaximumBytesV1 = 20_480;
const wecomThinkingTruncatedNotice = "（思考过程较长，已截断）";
/** #3377：已有回答超过单条回复余量时的截短提示。 */
const wecomAnswerTruncatedNotice = "（回答较长，已截断）";
/** #3077：回复有效期内回答仍未就绪时附在已有回答之后的固定超时提示。 */
export const wecomReplyTimeoutTextV1 =
	"回复超时，Agent 未能在企微回复时限内完成，请稍后重试";
/** 映射到的会话不可用时的固定提示（#3184）。 */
export const wecomConversationUnavailableTextV1 =
	"当前会话不可用，发送 /new 开始新会话";

/** 在 UTF-8 码点边界截取不超过 `maxBytes` 的前缀。 */
export function truncateUtf8V1(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const point of text) {
		const size = Buffer.byteLength(point);
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += point.length;
	}
	return text.slice(0, end);
}

/**
 * #2982：按企微被动回复的思考过程样式组合 `<think>思考过程</think>`、空行与答案。摘要与原始推理
 * 各自按顺序拼接，先摘要后原始推理，与 Web 一致。思考内容里的 `<think>`、`</think>` 字面量先换成
 * 全角尖括号，不能提前闭合或另起思考块。答案优先：思考过程只用答案之外的预算，放不下或没有读完时
 * 在码点边界截短并附提示；连提示都放不下时返回 undefined，只发答案。
 */
export function composeWecomThinkingReplyV1(
	answer: string,
	thinking: {
		readonly parts: readonly {
			readonly kind: "raw" | "summary";
			readonly text: string;
		}[];
		readonly complete: boolean;
	},
	rewrite?: (content: string) => string | undefined,
) {
	const joined = (kind: "raw" | "summary") =>
		thinking.parts
			.filter((part) => part.kind === kind)
			.map((part) => part.text)
			.join("");
	const combined = [joined("summary"), joined("raw")]
		.filter(Boolean)
		.join("\n\n");
	// #3229：思考过程中的 `sandbox:` 引用与答案按同样的规划改写；无法确认时不附带思考过程。
	const rewritten = rewrite ? rewrite(combined) : combined;
	if (rewritten === undefined) return undefined;
	const content = rewritten.replace(/<(\s*\/?\s*think\b[^<>]*)>/gi, "＜$1＞");
	if (!content.trim()) return undefined;
	const budget =
		wecomReplyMaximumBytesV1 -
		Buffer.byteLength(`<think></think>\n\n${answer}`);
	if (thinking.complete && Buffer.byteLength(content) <= budget)
		return `<think>${content}</think>\n\n${answer}`;
	const room = budget - Buffer.byteLength(wecomThinkingTruncatedNotice);
	const cut = room > 0 ? truncateUtf8V1(content, room) : "";
	if (!cut.trim()) return undefined;
	return `<think>${cut}${wecomThinkingTruncatedNotice}</think>\n\n${answer}`;
}

/**
 * #3377：尚未完成的回答前缀（进度帧与超时定稿）。结果文件尚未确认，回答中的 `sandbox:` 引用一律
 * 改写为文件名与“未发布”，不附末尾清单；无法解析引用时不展示回答，只保留阶段或提示。
 */
export function partialWecomAnswerV1(
	answer: string,
	parse: WecomAnswerReferenceParserV1,
): string {
	if (!answer) return "";
	try {
		return rewriteWecomAnswerV1({
			answer,
			references: parseWecomAnswerReferencesV1(answer, parse),
			files: [],
			skipped: new Map(),
			appendUnreferenced: false,
		});
	} catch {
		return "";
	}
}

/**
 * 把 `head` 与回答拼成不超过 `maxBytes` 的文本：回答放不下或本身没有读完时在码点边界截短并附
 * 提示；`tail` 总是完整保留在末尾。
 */
export function composeWecomBoundedTextV1(input: {
	readonly head?: string;
	readonly answer: string;
	readonly answerComplete: boolean;
	readonly tail?: string;
	readonly maxBytes?: number;
}): string {
	const maxBytes = input.maxBytes ?? wecomReplyMaximumBytesV1;
	const join = (answer: string) =>
		[input.head, answer, input.tail]
			.filter((part): part is string => Boolean(part?.trim()))
			.join("\n\n");
	const answer = input.answer.trim() ? input.answer : "";
	const whole = join(answer);
	if (input.answerComplete && Buffer.byteLength(whole) <= maxBytes)
		return whole;
	if (!answer) return truncateUtf8V1(whole, maxBytes);
	const room = maxBytes - Buffer.byteLength(join(wecomAnswerTruncatedNotice));
	const cut = room > 0 ? truncateUtf8V1(answer, room) : "";
	return truncateUtf8V1(
		join(cut.trim() ? `${cut}${wecomAnswerTruncatedNotice}` : ""),
		maxBytes,
	);
}

/**
 * #3377：执行失败的企微说明（工程 Spec §16.1.1、WECOM-text-deployment.md 固定文案）。会话不可用
 * 附 `/new` 指引；排队超时使用排队提示的固定文案；内部错误附追踪编号。
 */
export function wecomExecutionFailureTextV1(
	category: ExecutionFailureCategoryV1,
	traceId?: string | null,
): string {
	if (category === "conversation_unavailable")
		return `本次任务执行失败，${wecomConversationUnavailableTextV1}`;
	if (category === "queue_timeout")
		return "排队超时，等待超过时限仍未开始，本条消息未处理，请稍后重新发送";
	return `本次任务执行失败，${executionFailureMessageV1(category, traceId)}`;
}
