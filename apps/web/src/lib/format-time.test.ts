// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { formatTimestamp } from "./format-time";

const originalTimeZone = process.env.TZ;
afterEach(() => {
	// 原值为空时删除变量，避免写入字符串 "undefined"。
	if (originalTimeZone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimeZone;
});

const text = (value: Parameters<typeof formatTimestamp>[0], now: Date) =>
	formatTimestamp(value, { now })?.text;

describe.each(["UTC", "Asia/Shanghai"])("formatTimestamp in %s", (zone) => {
	it("formats relative natural-day labels in the local time zone", () => {
		process.env.TZ = zone;
		const now = new Date(2026, 9, 18, 10, 22);
		expect(text(new Date(2026, 9, 18, 10, 21, 30), now)).toBe("刚刚");
		expect(text(new Date(2026, 9, 18, 10, 17), now)).toBe("今天 10:17");
		expect(text(new Date(2026, 9, 17, 14, 22), now)).toBe("昨天 14:22");
		expect(text(new Date(2026, 6, 25, 9, 0), now)).toBe("7 月 25 日");
		expect(text(new Date(2025, 11, 31, 23, 0), now)).toBe(
			"2025 年 12 月 31 日",
		);
		expect(
			formatTimestamp(new Date(2026, 9, 18, 10, 17), {
				now,
				style: "absolute",
			}),
		).toEqual({
			text: "2026 年 10 月 18 日 10:17",
			full: "2026 年 10 月 18 日 10:17:00",
		});
		expect(formatTimestamp(new Date(2026, 9, 18, 10, 17, 9), { now })).toEqual({
			text: "今天 10:17",
			full: "2026 年 10 月 18 日 10:17:09",
		});
	});

	it("converts UTC contract values to the local wall clock", () => {
		process.env.TZ = zone;
		const now = new Date("2026-10-18T02:22:00Z");
		expect(
			formatTimestamp("2026-10-18T02:17:00Z", { now, style: "absolute" }),
		).toEqual(
			zone === "UTC"
				? {
						text: "2026 年 10 月 18 日 02:17",
						full: "2026 年 10 月 18 日 02:17:00",
					}
				: {
						text: "2026 年 10 月 18 日 10:17",
						full: "2026 年 10 月 18 日 10:17:00",
					},
		);
		expect(text("2026-10-18T02:17:00Z", now)).toBe(
			zone === "UTC" ? "今天 02:17" : "今天 10:17",
		);
	});

	it("compares calendar days rather than 24-hour windows", () => {
		process.env.TZ = zone;
		expect(
			text(new Date(2026, 9, 17, 23, 50), new Date(2026, 9, 18, 0, 5)),
		).toBe("昨天 23:50");
		expect(
			text(new Date(2026, 9, 18, 0, 10), new Date(2026, 9, 18, 23, 55)),
		).toBe("今天 00:10");
		expect(
			text(new Date(2026, 9, 16, 23, 59), new Date(2026, 9, 18, 0, 1)),
		).toBe("10 月 16 日");
		// 时钟偏差导致稍晚于 now 的同日值仍显示当天时间。
		expect(
			text(new Date(2026, 9, 18, 10, 30), new Date(2026, 9, 18, 10, 22)),
		).toBe("今天 10:30");
	});
});

it("returns null for empty or invalid values", () => {
	for (const value of [null, undefined, "", "not-a-date", Number.NaN])
		expect(formatTimestamp(value)).toBeNull();
});

it("never emits ISO text, English months or AM/PM", () => {
	const now = new Date(2026, 9, 18, 10, 22);
	for (const value of [
		"2026-09-03T08:00:00Z",
		"2026-10-18T01:00:00.000Z",
		new Date(2024, 1, 29, 16, 0),
	]) {
		for (const style of ["relative", "absolute"] as const) {
			const result = formatTimestamp(value, { now, style });
			expect(result).not.toBeNull();
			expect(`${result?.text} ${result?.full}`).not.toMatch(
				/T\d\d:|Z\b|AM|PM|[A-Z][a-z]{2}\b/,
			);
		}
	}
});

it("does not decide 'today' with a millisecond day window", () => {
	const source = readFileSync(new URL("./format-time.ts", import.meta.url), {
		encoding: "utf8",
	});
	expect(source).not.toMatch(/86_?400_?000|24 \* 60 \* 60/);
});
