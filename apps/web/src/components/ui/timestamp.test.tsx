import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ClockProvider } from "@/lib/clock";
import { Timestamp } from "./timestamp";

const originalTimeZone = process.env.TZ;
afterEach(() => {
	cleanup();
	// 原值为空时删除变量，避免写入字符串 "undefined"。
	if (originalTimeZone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimeZone;
});

it("renders the contract value in <time> with the full local time as title", () => {
	process.env.TZ = "Asia/Shanghai";
	render(
		<ClockProvider now={() => new Date("2026-10-18T02:22:00Z")}>
			<Timestamp value="2026-10-17T09:40:05Z" />
		</ClockProvider>,
	);
	const time = screen.getByText("昨天 17:40");
	expect(time.tagName).toBe("TIME");
	expect(time.getAttribute("datetime")).toBe("2026-10-17T09:40:05Z");
	expect(time.getAttribute("title")).toBe("2026 年 10 月 17 日 17:40:05");
});

it("supports absolute style and renders nothing for invalid values", () => {
	process.env.TZ = "UTC";
	const { container } = render(
		<>
			<Timestamp value="2026-10-16T06:38:14.270Z" style="absolute" />
			<Timestamp value="invalid" />
			<Timestamp value={null} />
		</>,
	);
	expect(container.querySelectorAll("time")).toHaveLength(1);
	expect(screen.getByText("2026 年 10 月 16 日 06:38").tagName).toBe("TIME");
});
