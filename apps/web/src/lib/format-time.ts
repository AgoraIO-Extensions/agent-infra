export type TimestampStyle = "relative" | "absolute";
export type TimestampValue = string | number | Date | null | undefined;
export type FormattedTimestamp = { text: string; full: string };

const pad = (value: number) => String(value).padStart(2, "0");

/** 解析契约时间值；空值或无法解析的值返回 null。 */
export function parseTimestamp(value: TimestampValue): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const date =
		value instanceof Date
			? new Date(value.getTime())
			: new Date(typeof value === "number" ? value : Date.parse(value));
	return Number.isNaN(date.getTime()) ? null : date;
}

function sameLocalDay(a: Date, b: Date) {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

function clock(date: Date) {
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function calendarDate(date: Date, withYear: boolean) {
	const monthDay = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
	return withYear ? `${date.getFullYear()} 年 ${monthDay}` : monthDay;
}

/**
 * 全站唯一的时间显示格式。一律使用浏览器本地时区，并按本地自然日比较；
 * 24 小时制，不输出 ISO 原文、英文月份或 AM/PM。
 */
export function formatTimestamp(
	value: TimestampValue,
	options: { now?: Date; style?: TimestampStyle } = {},
): FormattedTimestamp | null {
	const date = parseTimestamp(value);
	if (!date) return null;
	const full = `${calendarDate(date, true)} ${clock(date)}:${pad(date.getSeconds())}`;
	if (options.style === "absolute")
		return { text: `${calendarDate(date, true)} ${clock(date)}`, full };
	const now = options.now ?? new Date();
	const elapsed = now.getTime() - date.getTime();
	if (elapsed >= 0 && elapsed < 60_000) return { text: "刚刚", full };
	if (sameLocalDay(date, now)) return { text: `今天 ${clock(date)}`, full };
	// 用本地日历的前一天比较，跨夏令时或 0 点前后都不会误判为「今天」。
	const yesterday = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate() - 1,
	);
	if (sameLocalDay(date, yesterday))
		return { text: `昨天 ${clock(date)}`, full };
	return {
		text: calendarDate(date, date.getFullYear() !== now.getFullYear()),
		full,
	};
}
