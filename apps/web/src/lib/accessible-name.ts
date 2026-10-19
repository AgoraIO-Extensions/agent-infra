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

/**
 * 同页多个对象的显示名相同（例如多次提问「继续」、多次调用同一命令）时，按出现顺序加
 * 「（第 N 次）」，让「{可见文字}：{对象名}」仍可区分（N-12）；不重复的名称原样返回。
 */
export function distinctObjectNames(names: readonly string[]): string[] {
	const totals = new Map<string, number>();
	for (const name of names) totals.set(name, (totals.get(name) ?? 0) + 1);
	const seen = new Map<string, number>();
	return names.map((name) => {
		if ((totals.get(name) ?? 0) < 2) return name;
		const count = (seen.get(name) ?? 0) + 1;
		seen.set(name, count);
		return `${name}（第 ${count} 次）`;
	});
}
