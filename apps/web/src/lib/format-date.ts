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
	if (delta >= 0 && delta < 86_400_000)
		return `今天 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)}`;
	return formatDateTime(value);
}
