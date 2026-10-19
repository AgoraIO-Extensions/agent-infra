const han = /\p{Script=Han}/u;
const latinOrDigit = /[A-Za-z0-9]/;

/** 前一段以汉字结尾、后一段以拉丁字母或数字开头（或反过来）时返回一个空格。 */
function boundarySpace(before: string, after: string) {
	const last = before.at(-1);
	const first = after.at(0);
	if (!last || !first) return "";
	return (han.test(last) && latinOrDigit.test(first)) ||
		(latinOrDigit.test(last) && han.test(first))
		? " "
		: "";
}

/**
 * 拼接可见文案的标签模板：插值与相邻文字之间一边是汉字、一边是拉丁字母或数字时补一个空格，
 * 例如 cjkSpaced`重启${"Release assistant"}？` →「重启 Release assistant？」、
 * cjkSpaced`${"可用 Agent"}无法读取` →「可用 Agent 无法读取」。
 *
 * - 只在插值边界判断，不改动静态文字或插值内部的写法；
 * - 中文标点（：？。…）、已有空白与空插值不触发补空格；
 * - 只用于页面上显示的文案，不用于 ID、URL 或请求参数。
 */
export function cjkSpaced(
	strings: TemplateStringsArray,
	...values: readonly unknown[]
): string {
	let text = strings[0] ?? "";
	values.forEach((value, index) => {
		for (const part of [String(value), strings[index + 1] ?? ""]) {
			text += boundarySpace(text, part) + part;
		}
	});
	return text;
}
