import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithAgentRouter } from "../agent-discovery/test-router.js";
import {
	OperationsEntry,
	type OperationsEntryState,
} from "./operations-entry.js";

const idleCollection = {
	captureFailures: 0,
	exportFailures: 0,
	droppedLogs: 0,
	invalidRecords: 0,
};

const notConnected: Extract<OperationsEntryState, { kind: "ready" }> = {
	kind: "ready",
	statuses: {
		health: "unknown",
		agents: "unknown",
		dependencies: "unknown",
		alerts: "unknown",
	},
	collection: idleCollection,
};

function facts(region: HTMLElement) {
	const list = region.querySelector("dl");
	if (!list) throw new Error("facts missing");
	expect(list.className).toBe("review-facts");
	return [...list.querySelectorAll("dt")].map((term) => [
		term.textContent,
		term.nextElementSibling?.textContent,
	]);
}

function chip(region: HTMLElement) {
	const badge = region.querySelector('[data-slot="badge"]');
	if (!(badge instanceof HTMLElement)) throw new Error("chip missing");
	return [badge.textContent, badge.dataset.tone];
}

async function show(
	state: OperationsEntryState,
	options: { isAdministrator?: boolean; isRefreshing?: boolean } = {},
) {
	const onRefresh = vi.fn();
	await renderWithAgentRouter(
		<OperationsEntry
			isAdministrator={options.isAdministrator ?? true}
			isRefreshing={options.isRefreshing}
			onRefresh={onRefresh}
			state={state}
		/>,
	);
	return onRefresh;
}

function regions() {
	return screen
		.queryAllByRole("region")
		.filter((region) => region.matches('[data-slot="card"]'));
}

describe("OperationsEntry", () => {
	it("shows the page head and four domains, marking every domain without a data source as not connected", async () => {
		const onRefresh = await show(notConnected);
		expect(screen.getByText("系统管理 / 运维观测").className).toBe(
			"page-eyebrow",
		);
		const heading = screen.getByRole("heading", {
			level: 1,
			name: "先确认平台状态，再定位故障。",
		});
		expect(heading.getAttribute("tabindex")).toBe("-1");
		expect(
			regions().map(
				(region) =>
					within(region).getByRole("heading", { level: 2 }).textContent,
			),
		).toEqual(["平台健康", "Agent 与任务", "依赖", "告警"]);
		for (const name of ["平台健康", "Agent 与任务", "依赖"]) {
			const region = screen.getByRole("region", { name });
			expect(chip(region)).toEqual(["未接入", "gray"]);
			expect(facts(region).at(-1)).toEqual(["数据来源", "未接入"]);
		}
		const alerts = screen.getByRole("region", { name: "告警" });
		expect(chip(alerts)).toEqual(["未接入", "gray"]);
		expect(facts(alerts)).toEqual([
			["覆盖", "服务不可用、持续积压与异常错误"],
			["告警出口", "未接入"],
			["观测采集", "Platform API · 正常"],
			["采集失败", "0 次"],
			["导出失败", "0 次"],
			["丢弃日志", "0 条"],
			["无效记录", "0 条"],
			["最近导出失败", "无"],
		]);
		const refresh = screen.getByRole("button", { name: "刷新运维状态" });
		expect((refresh as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(refresh);
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it("reports collection failures from the query on the alert domain only", async () => {
		await show({
			kind: "ready",
			statuses: { ...notConnected.statuses, alerts: "degraded" },
			collection: {
				captureFailures: 1,
				exportFailures: 2,
				droppedLogs: 3,
				invalidRecords: 4,
				lastExportFailureAt: "2026-10-13T00:00:00.000Z",
			},
		});
		const alerts = screen.getByRole("region", { name: "告警" });
		expect(chip(alerts)).toEqual(["降级", "amber"]);
		expect(facts(alerts).slice(2, 7)).toEqual([
			["观测采集", "Platform API · 有失败"],
			["采集失败", "1 次"],
			["导出失败", "2 次"],
			["丢弃日志", "3 条"],
			["无效记录", "4 条"],
		]);
		expect(alerts.querySelector("time")?.getAttribute("dateTime")).toBe(
			"2026-10-13T00:00:00.000Z",
		);
		expect(chip(screen.getByRole("region", { name: "平台健康" }))).toEqual([
			"未接入",
			"gray",
		]);
	});

	it("maps the remaining domain statuses to explicit chip tones", async () => {
		await show({
			kind: "ready",
			statuses: {
				health: "healthy",
				agents: "unavailable",
				dependencies: "degraded",
				alerts: "unknown",
			},
			collection: idleCollection,
		});
		expect(chip(screen.getByRole("region", { name: "平台健康" }))).toEqual([
			"正常",
			"green",
		]);
		expect(chip(screen.getByRole("region", { name: "Agent 与任务" }))).toEqual([
			"不可用",
			"red",
		]);
		const dependencies = screen.getByRole("region", { name: "依赖" });
		expect(chip(dependencies)).toEqual(["降级", "amber"]);
		expect(facts(dependencies).at(-1)).toEqual(["数据来源", "正式观测查询"]);
	});

	it("shows a loading line without domains and disables refresh while reading", async () => {
		await show({ kind: "loading" }, { isRefreshing: true });
		expect(screen.getByRole("status").textContent).toBe("正在读取观测状态…");
		expect(regions()).toHaveLength(0);
		// 需求变化（#3235 I6-01）：读取中改为可聚焦的禁用（aria-disabled），不再用原生 disabled，
		// 否则获得焦点的按钮被禁用后焦点落到 body。
		const refresh = screen.getByRole("button", {
			name: "刷新运维状态",
		}) as HTMLButtonElement;
		expect(refresh.getAttribute("aria-disabled")).toBe("true");
		expect(refresh.disabled).toBe(false);
	});

	it("uses the shared unavailable card with one retry and no domains", async () => {
		const onRefresh = await show({
			kind: "unavailable",
			message: "观测服务当前不可用。",
		});
		const card = screen.getByRole("alert");
		expect(card.dataset.kind).toBe("unavailable");
		expect(
			within(card).getByRole("heading", { level: 2, name: "服务暂不可用" }),
		).toBeTruthy();
		expect(card.textContent).toContain("观测服务当前不可用。");
		expect(
			screen.getAllByRole("button").map((button) => button.textContent),
		).toEqual(["重新读取观测状态"]);
		fireEvent.click(screen.getByRole("button", { name: "重新读取观测状态" }));
		expect(onRefresh).toHaveBeenCalledOnce();
		expect(regions()).toHaveLength(0);
	});

	it("shows a not-connected card without actions when the deployment has no query entry", async () => {
		await show({ kind: "not-connected" });
		const card = screen.getByRole("alert");
		expect(
			within(card).getByRole("heading", { level: 2, name: "观测查询未接入" }),
		).toBeTruthy();
		expect(card.textContent).toContain(
			"当前部署没有提供运维观测查询，页面不显示指标或告警。",
		);
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(regions()).toHaveLength(0);
	});

	it.each([
		["a non-administrator session", false, notConnected],
		["a server denial", true, { kind: "denied" } as const],
	] as const)(
		"shows the unauthorized card for %s without operational facts",
		async (_case, isAdministrator, state) => {
			await show(state, { isAdministrator });
			const card = document.querySelector('[data-slot="state-card"]');
			if (!(card instanceof HTMLElement)) throw new Error("state card missing");
			expect(card.dataset.kind).toBe("unauthorized");
			expect(card.getAttribute("role")).toBeNull();
			expect(card.textContent).toContain("你没有访问运维观测的权限。");
			expect(
				within(card).getByRole("link", { name: "返回工作台" }),
			).toBeTruthy();
			expect(screen.queryAllByRole("button")).toHaveLength(0);
			expect(regions()).toHaveLength(0);
			expect(screen.queryByText("告警出口")).toBeNull();
		},
	);
});
