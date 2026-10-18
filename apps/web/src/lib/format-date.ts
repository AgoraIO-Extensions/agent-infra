export function formatDateTime(value: string | null | undefined) {
	if (!value) return "未提供";
	const date = new Date(value);
	if (Number.isNaN(date.valueOf())) return "时间暂不可用";
	return new Intl.DateTimeFormat("zh-CN", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

export function formatRelativeDate(value: string | null | undefined) {
	if (!value) return "未提供";
	const date = new Date(value);
	if (Number.isNaN(date.valueOf())) return "时间暂不可用";
	const delta = Date.now() - date.valueOf();
	if (delta >= 0 && delta < 60_000) return "刚刚";
	const parts = (input: Date) =>
		Object.fromEntries(
			new Intl.DateTimeFormat("zh-CN", {
				year: "numeric",
				month: "numeric",
				day: "numeric",
			})
				.formatToParts(input)
				.filter(({ type }) => ["year", "month", "day"].includes(type))
				.map(({ type, value: part }) => [type, part]),
		) as Record<"year" | "month" | "day", string>;
	const today = parts(new Date());
	const target = parts(date);
	const key = (item: typeof today) => `${item.year}-${item.month}-${item.day}`;
	const clock = new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
	if (key(today) === key(target)) return `今天 ${clock}`;
	const yesterday = new Date();
	yesterday.setDate(yesterday.getDate() - 1);
	if (key(parts(yesterday)) === key(target)) return `昨天 ${clock}`;
	const currentYear = today.year === target.year;
	return currentYear
		? `${target.month}月${target.day}日 ${clock}`
		: formatDateTime(value);
}
