import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DirectoryNames } from "../directory-names.js";
import {
	AuditPrincipalName,
	AuditRecordDetail,
	auditDetailHeading,
} from "./audit-record-detail.js";
import { auditRecord } from "./audit-test-fixtures.js";

afterEach(cleanup);

// 目录只认识 user-a；其余用户为未解析。
const names: DirectoryNames = {
	status: "ready",
	resolve: (id) =>
		id === "user-a"
			? { id, name: "审计用户甲", secondary: "", resolved: true }
			: { id, name: "未识别的用户", secondary: "", resolved: false },
	retry: () => undefined,
};

function facts(container: HTMLElement) {
	return Object.fromEntries(
		[...container.querySelectorAll("dt")].map((dt) => [
			dt.textContent,
			dt.nextElementSibling as HTMLElement,
		]),
	);
}

describe("AuditRecordDetail", () => {
	it("titles the record as event · outcome and moves the outcome into a facts row", () => {
		const record = auditRecord();
		expect(auditDetailHeading(record)).toBe("任务 API 访问 · 访问获准");
		const { container } = render(
			<AuditRecordDetail record={record} names={names} />,
		);
		// 面板标题由页面渲染；记录内容里不再有第二个 h2 或标题区徽章。
		expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
		const rows = facts(container);
		expect(Object.keys(rows).slice(0, 2)).toEqual(["结果", "事件"]);
		const outcome = rows.结果?.querySelector('[data-slot="badge"]');
		expect(outcome?.textContent).toBe("访问获准");
		expect(rows.事件?.textContent).toBe("任务 API 访问");
		expect(rows.动作代码).toBeUndefined();
		expect(container.textContent).not.toContain("task.api.access");
		expect(rows.对象类型?.textContent).toBe("Agent");
		for (const dl of container.querySelectorAll("dl"))
			expect(dl.className).toBe("review-facts");
		// 每个 dt 后紧跟它的 dd，两列对齐（不再包一层 div）。
		for (const dt of container.querySelectorAll("dt"))
			expect(dt.nextElementSibling?.tagName).toBe("DD");
	});

	it("shows principal names first with the complete ID as monospace secondary text", () => {
		const record = {
			...auditRecord(),
			originalPrincipal: { kind: "application" as const, id: "app-123456789" },
		};
		const { container } = render(
			<AuditRecordDetail record={record} names={names} />,
		);
		const rows = facts(container);
		const actor = rows.可信操作主体 as HTMLElement;
		expect(actor.textContent).toBe("审计用户甲user-a");
		expect(within(actor).getByText("user-a").className).toContain("font-mono");
		const original = rows.原发起主体 as HTMLElement;
		expect(original.textContent).toBe("应用app-123456789");
		expect(within(original).getByText("app-123456789").className).toContain(
			"font-mono",
		);
		// ID 与引用类字段使用等宽字体；详情不放复制或展开按钮。
		for (const label of [
			"审计 ID",
			"对象 ID",
			"请求尝试 ID",
			"原 Execution ID",
			"Trace ID",
		])
			expect(rows[label]?.className).toBe("font-mono");
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});
});

describe("AuditPrincipalName", () => {
	it("renders list principals as names or type plus a short monospace ID, never as buttons", () => {
		const view = render(
			<p>
				<AuditPrincipalName kind="user" id="user-a" names={names} />
			</p>,
		);
		expect(view.container.textContent).toBe("审计用户甲");
		view.rerender(
			<p>
				<AuditPrincipalName
					kind="application"
					id="application-0123456789abcdef"
					names={names}
				/>
			</p>,
		);
		expect(view.container.textContent).toBe("应用 applicat…");
		const code = view.container.querySelector("code");
		expect(code?.getAttribute("title")).toBe("application-0123456789abcdef");
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});
});
