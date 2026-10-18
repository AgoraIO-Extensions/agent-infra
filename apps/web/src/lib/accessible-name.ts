/**
 * 同页出现多个可见文字相同、作用对象不同的按钮或链接时，
 * 可访问名称写成「{可见文字}：{对象名}」（全角冒号）。
 *
 * - 名称始终以完整的可见文字开头（Label in Name），不得拆开或改写；
 * - 可见文字与对象名都去除首尾空白，对象名为空时只返回可见文字；
 * - 可见文字随状态变化时，调用方传入当前文案（例如「验证中…」）。
 */
export function withObjectName(
	visible: string,
	object?: string | null,
): string {
	const label = visible.trim();
	const target = object?.trim();
	return target ? `${label}：${target}` : label;
}
