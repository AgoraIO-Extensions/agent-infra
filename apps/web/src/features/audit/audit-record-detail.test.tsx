import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DirectoryNames } from "../directory-names.js";
import { auditObjectName } from "./audit-labels.js";
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
			originalPrincipal: {
				kind: "application" as const,
				id: "app-123456789",
				displayName: null,
			},
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

	it("shows server-permitted object, Agent and application names next to complete IDs (#2909)", () => {
		const record = {
			...auditRecord(),
			subject: {
				kind: "agent" as const,
				subjectId: "agent-a",
				displayName: "编程助手",
			},
			agentDisplayName: "编程助手",
			originalPrincipal: {
				kind: "application" as const,
				id: "app-123456789",
				displayName: "运维机器人",
			},
		};
		const { container } = render(
			<AuditRecordDetail record={record} names={names} />,
		);
		const rows = facts(container);
		expect(rows.对象名称?.textContent).toBe("编程助手");
		expect(rows["Agent 名称"]?.textContent).toBe("编程助手");
		expect(rows["Agent ID"]?.textContent).toBe("agent-a");
		const original = rows.原发起主体 as HTMLElement;
		expect(original.textContent).toBe("应用 · 运维机器人app-123456789");
		expect(within(original).getByText("app-123456789").className).toContain(
			"font-mono",
		);
	});

	it("does not explain why a name is missing (#2909)", () => {
		const { container } = render(
			<AuditRecordDetail record={auditRecord()} names={names} />,
		);
		const rows = facts(container);
		// 无权查看、不存在与无法确认一律显示「未提供」，不暴露对象是否存在。
		expect(rows.对象名称?.textContent).toBe("未提供");
		expect(rows["Agent 名称"]?.textContent).toBe("未提供");
		const execution = render(
			<AuditRecordDetail
				record={{
					...auditRecord(),
					subject: {
						kind: "execution",
						subjectId: "execution-a",
						displayName: null,
					},
					agentId: null,
				}}
				names={names}
			/>,
		);
		const executionRows = facts(execution.container);
		expect(executionRows.对象名称).toBeUndefined();
		expect(executionRows["Agent 名称"]).toBeUndefined();
	});
});

describe("auditObjectName", () => {
	it("prefers the object name, then the owning Agent name, then the type (#2909)", () => {
		const base = auditRecord();
		expect(auditObjectName(base)).toBe("Agent");
		expect(
			auditObjectName({
				...base,
				subject: { ...base.subject, displayName: "编程助手" },
			}),
		).toBe("编程助手");
		expect(
			auditObjectName({
				...base,
				subject: {
					kind: "agent_application",
					subjectId: "application-a",
					displayName: "数据助手",
				},
			}),
		).toBe("数据助手");
		expect(
			auditObjectName({
				...base,
				subject: {
					kind: "execution",
					subjectId: "execution-a",
					displayName: null,
				},
				agentDisplayName: "编程助手",
			}),
		).toBe("编程助手 · Execution");
		// Agent 对象自身没有名称时，不借用 agentDisplayName 冒充对象名称。
		expect(auditObjectName({ ...base, agentDisplayName: "编程助手" })).toBe(
			"Agent",
		);
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
		// #2909：服务端按权限返回应用名称时显示名称，完整 ID 留在 title 与详情。
		view.rerender(
			<p>
				<AuditPrincipalName
					kind="application"
					id="application-0123456789abcdef"
					displayName="运维机器人"
					names={names}
				/>
			</p>,
		);
		expect(view.container.textContent).toBe("应用 · 运维机器人");
		expect(view.container.querySelector("code")).toBeNull();
		expect(view.container.querySelector("[title]")?.getAttribute("title")).toBe(
			"application-0123456789abcdef",
		);
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});
});
