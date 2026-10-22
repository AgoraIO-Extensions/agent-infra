import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";
import { BrowserActivityCard } from "./browser-activity-card.js";
import {
	browserTestNow,
	handoffEvent,
	operationEvent,
	sideEffectEvent,
} from "./browser-test-fixtures.js";

function renderCard(
	events: PersistedConversationEventV2[],
	props: Partial<Parameters<typeof BrowserActivityCard>[0]> = {},
) {
	const onCommand = vi.fn();
	const view = render(
		<BrowserActivityCard
			events={events}
			conversationId="conversation-1"
			executionId="execution-1"
			browserAvailable
			onCommand={onCommand}
			{...props}
		/>,
	);
	return { ...view, onCommand };
}

describe("BrowserActivityCard", () => {
	beforeEach(() => vi.useFakeTimers({ now: browserTestNow }));
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("renders one region with a status head and no alert", () => {
		renderCard([
			operationEvent(1, "completed"),
			handoffEvent(2, "completed"),
			sideEffectEvent(3, "pending", { pageRevision: 5 }),
		]);
		const region = screen.getByRole("region", { name: "浏览器操作请求" });
		expect(
			document.querySelectorAll("section.browser-capability"),
		).toHaveLength(1);
		expect(region.getAttribute("data-phase")).toBe("request");
		const head = within(region).getByRole("status");
		expect(head.getAttribute("aria-atomic")).toBe("true");
		expect(head.textContent).toContain("等待确认");
		expect(within(region).queryByRole("alert")).toBeNull();
		expect(region.textContent).not.toMatch(
			/Browser|browser_|origin|页面版本|Session|绑定|https?:\/\//,
		);
	});

	it("sends only the opaque confirmation id from the two request actions", () => {
		const { onCommand } = renderCard([sideEffectEvent(1, "pending")]);
		const region = screen.getByRole("region", { name: "浏览器操作请求" });
		const buttons = within(region)
			.getAllByRole("button")
			.filter((button) => button.textContent !== "查看操作记录");
		expect(buttons.map((button) => button.textContent)).toEqual([
			"允许这次操作",
			"拒绝",
		]);
		fireEvent.click(
			screen.getByRole("button", {
				name: "允许这次操作：提交 example.test",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "拒绝：提交 example.test" }),
		);
		expect(onCommand.mock.calls.map(([command]) => command)).toEqual([
			{ kind: "confirm_side_effect", confirmationId: "confirmation-1" },
			{ kind: "reject_side_effect", confirmationId: "confirmation-1" },
		]);
		expect(
			screen.queryByRole("button", { name: /确认执行|取消|暂停 Agent/ }),
		).toBeNull();
	});

	it("offers take over and stop for a requested handoff (NI-94)", () => {
		const { onCommand } = renderCard([handoffEvent(1, "requested")]);
		expect(screen.queryByRole("button", { name: /允许这次操作/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "接管浏览器" }));
		fireEvent.click(screen.getByRole("button", { name: "停止接管" }));
		expect(onCommand.mock.calls.map(([command]) => command)).toEqual([
			{ kind: "take_over", handoffId: "handoff-1" },
			{ kind: "revoke", handoffId: "handoff-1" },
		]);
		expect(screen.getByText(/MFA 验证/)).toBeTruthy();
	});

	it("offers return and stop while the user holds the browser", () => {
		const { onCommand } = renderCard([handoffEvent(1, "active")]);
		fireEvent.click(screen.getByRole("button", { name: "交还给 Agent" }));
		expect(onCommand).toHaveBeenCalledWith({
			kind: "return_to_agent",
			handoffId: "handoff-1",
		});
		expect(screen.queryByRole("button", { name: "交回 Agent" })).toBeNull();
	});

	it("shows stop only while the execution can still be stopped", () => {
		const events = [operationEvent(1, "started")];
		const { onCommand, rerender } = renderCard(events, { canStop: true });
		const stop = screen.getByRole("button", { name: "停止操作" });
		expect(stop.querySelector("svg")).not.toBeNull();
		fireEvent.click(stop);
		expect(onCommand).toHaveBeenCalledWith({ kind: "stop_execution" });
		rerender(
			<BrowserActivityCard
				events={events}
				conversationId="conversation-1"
				executionId="execution-1"
				browserAvailable
				onCommand={onCommand}
			/>,
		);
		expect(screen.queryByRole("button", { name: "停止操作" })).toBeNull();
	});

	it.each([
		[
			"waiting for confirmation",
			[operationEvent(1, "completed"), sideEffectEvent(2, "pending")],
			"浏览器操作请求",
			["允许这次操作", "拒绝"],
		],
		[
			"waiting for a handoff",
			[operationEvent(1, "completed"), handoffEvent(2, "requested")],
			"需要你接管浏览器",
			["接管浏览器", "停止"],
		],
		[
			"running",
			[
				operationEvent(1, "completed"),
				operationEvent(2, "started", { operationRef: "operation-2" }),
			],
			"浏览器操作进行中",
			["停止操作"],
		],
	])(
		"keeps only this phase's actions while %s (Z-09)",
		(_, events, title, labels) => {
			renderCard(events, { canStop: true });
			const region = screen.getByRole("region", { name: title });
			// 已有操作记录，但非终态卡不放「查看操作记录」；记录仍可从执行详情打开。
			expect(
				within(region)
					.getAllByRole("button")
					.map((button) => button.textContent),
			).toEqual(labels);
		},
	);

	it.each([
		["complete", [operationEvent(1, "completed")], "浏览器操作已完成"],
		["denied", [sideEffectEvent(1, "rejected")], "浏览器操作已拒绝"],
		["stopped", [sideEffectEvent(1, "cancelled")], "浏览器操作已停止"],
		["unknown", [operationEvent(1, "unknown")], "浏览器结果待核实"],
	])(
		"offers the operation record on the %s card (Z-09)",
		(_, events, title) => {
			renderCard(events);
			const region = screen.getByRole("region", { name: title });
			expect(
				within(region)
					.getAllByRole("button")
					.map((button) => button.textContent),
			).toEqual(["查看操作记录"]);
		},
	);

	it("leaves terminal cards without commands", () => {
		renderCard([operationEvent(1, "completed")]);
		const region = screen.getByRole("region", { name: "浏览器操作已完成" });
		expect(
			within(region)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["查看操作记录"]);
		expect(region.querySelectorAll("[data-active='true']")).toHaveLength(3);
	});

	it("drops the actions when the open request expires", () => {
		const { onCommand } = renderCard([
			sideEffectEvent(1, "pending", { expires: "2026-10-11T10:01:00.000Z" }),
		]);
		const allow = screen.getByRole("button", { name: /允许这次操作/ });
		act(() => {
			vi.advanceTimersByTime(61_000);
		});
		fireEvent.click(allow);
		expect(screen.queryByRole("button", { name: /允许这次操作/ })).toBeNull();
		expect(onCommand).not.toHaveBeenCalled();
		expect(
			screen.getByRole("region", { name: "浏览器操作已停止" }),
		).toBeTruthy();
	});

	it("disables actions while a command is pending but keeps them focusable (G5-04)", () => {
		const { onCommand } = renderCard([sideEffectEvent(1, "pending")], {
			busy: true,
		});
		const allow = screen.getByRole("button", {
			name: /允许这次操作/,
		}) as HTMLButtonElement;
		// 需求变化（#3215 G5-04）：命令处理中改用 aria-disabled（focusableWhenDisabled），按钮仍可聚焦，
		// 焦点不随原生 disabled 落到 body；仍不可操作。
		expect(allow.getAttribute("aria-disabled")).toBe("true");
		expect(allow.disabled).toBe(false);
		allow.focus();
		expect(document.activeElement).toBe(allow);
		fireEvent.click(allow);
		expect(onCommand).not.toHaveBeenCalled();
	});

	it("keeps the idle card out of the thread unless asked", () => {
		const { rerender, onCommand } = renderCard([]);
		expect(document.querySelector("section.browser-capability")).toBeNull();
		rerender(
			<BrowserActivityCard
				events={[]}
				executionId="execution-1"
				browserAvailable
				includeIdle
				onCommand={onCommand}
			/>,
		);
		const region = screen.getByRole("region", { name: "浏览器操作" });
		expect(region.textContent).toContain("可请求");
		expect(within(region).queryByRole("button")).toBeNull();
	});
});
