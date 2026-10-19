import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	BrowserOperationRecordDialog,
	browserAuditEntries,
	browserAuditFacts,
	browserAuditRecords,
} from "./browser-audit-view.js";
import {
	handoffEvent,
	operationEvent,
	sideEffectEvent,
} from "./browser-test-fixtures.js";

afterEach(() => cleanup());

const entries = (
	events: PersistedConversationEventV2[],
	executionId = "execution-1",
) => browserAuditEntries(events, "conversation-1", executionId);

describe("browser operation records", () => {
	it("aggregates each object to its latest state and isolates executions", () => {
		const result = entries([
			operationEvent(1, "intent"),
			operationEvent(2, "completed"),
			handoffEvent(3, "requested"),
			handoffEvent(4, "active"),
			handoffEvent(5, "completed"),
			sideEffectEvent(6, "pending"),
			sideEffectEvent(7, "unknown"),
			operationEvent(8, "completed", { executionId: "execution-foreign" }),
		]);
		expect(result.map((entry) => [entry.kind, entry.status])).toEqual([
			["operation", "completed"],
			["handoff", "completed"],
			["side_effect", "unknown"],
		]);
		expect(result[1]?.statusLabel).toBe("已交回 Agent");
		expect(result.at(-1)?.detail).toBe("example.test · 提交公开表单（已脱敏）");
	});

	it("keeps a newer handoff state when an older event arrives later", () => {
		const result = entries([
			handoffEvent(5, "completed"),
			handoffEvent(3, "active"),
		]);
		expect(result.map((entry) => entry.status)).toEqual(["completed"]);
		expect(
			entries([
				handoffEvent(1, "requested", { handoffId: "handoff-1" }),
				handoffEvent(2, "requested", { handoffId: "handoff-2" }),
			]),
		).toHaveLength(2);
	});

	it("drops records whose binding, origin or summary cannot be verified", () => {
		expect(
			entries([
				sideEffectEvent(1, "pending", {
					targetOrigin: "https://example.test/private?token=secret",
					unchecked: true,
				}),
				sideEffectEvent(2, "pending", {
					binding: { conversationId: "conversation-foreign" },
					unchecked: true,
				}),
				sideEffectEvent(3, "pending", {
					confirmationId: "confirmation-3",
					summary: "\u0007",
					unchecked: true,
				}),
				handoffEvent(4, "requested", {
					binding: { executionId: "execution-foreign" },
					unchecked: true,
				}),
			]),
		).toEqual([]);
		const [record] = entries([
			sideEffectEvent(1, "pending", {
				summary: `第一行\u0000${"长".repeat(400)}`,
			}),
		]);
		expect(record?.detail).not.toContain("\u0000");
		expect(record?.detail?.length).toBe("example.test · ".length + 160);
	});

	it("bounds the list to the latest fifty objects", () => {
		const many = Array.from({ length: 55 }, (_, index) =>
			handoffEvent(index + 1, "active", { handoffId: `handoff-${index + 1}` }),
		);
		const { entries: bounded, truncated } = browserAuditRecords(
			many,
			"conversation-1",
			"execution-1",
		);
		expect(bounded).toHaveLength(50);
		expect(bounded[0]?.sequence).toBe(6);
		expect(truncated).toBe(true);
		expect(
			browserAuditRecords(many.slice(0, 50), "conversation-1", "execution-1")
				.truncated,
		).toBe(false);
	});

	it.each([
		["operation", "intent", "正在受理", "blue"],
		["operation", "started", "执行中", "blue"],
		["operation", "completed", "已完成", "green"],
		["operation", "failed", "执行失败", "red"],
		["operation", "unknown", "待核实", "red"],
		["handoff", "requested", "等待接管", "amber"],
		["handoff", "active", "接管中", "amber"],
		["handoff", "returning", "正在交回", "blue"],
		["handoff", "completed", "已交回 Agent", "green"],
		["handoff", "revoked", "已停止", "red"],
		["handoff", "crashed", "浏览器已崩溃", "red"],
		["handoff", "unknown", "待核实", "red"],
		["handoff", "expired", "已过期", "gray"],
		["side_effect", "pending", "等待确认", "amber"],
		["side_effect", "confirmed", "已确认", "green"],
		["side_effect", "rejected", "已拒绝", "red"],
		["side_effect", "cancelled", "已取消", "red"],
		["side_effect", "unknown", "待核实", "red"],
		["side_effect", "expired", "已过期", "gray"],
	] as const)("labels %s %s as %s (%s)", (kind, status, label, tone) => {
		const event =
			kind === "operation"
				? operationEvent(1, status as "intent")
				: kind === "handoff"
					? handoffEvent(1, status as "requested")
					: sideEffectEvent(1, status as "pending");
		expect(entries([event])[0]).toMatchObject({
			status,
			statusLabel: label,
			tone,
		});
	});

	it("summarises the facts without IDs or guessed people", () => {
		expect(
			browserAuditFacts(entries([operationEvent(1, "completed")])),
		).toEqual([
			{ label: "域名", value: "未记录" },
			{ label: "操作范围", value: "打开页面" },
			{ label: "接管人", value: "无需接管" },
			{ label: "结果", value: "已完成" },
			{ label: "凭证", value: "不进入模型或平台记录" },
		]);
		// 设计「接管人 陈昊 · MFA」：operatorId 是会话主体本人，与当前登录用户一致时显示姓名（NW-01）。
		expect(
			browserAuditFacts(
				entries([
					operationEvent(1, "completed", { toolId: "browser_observe" }),
					handoffEvent(2, "completed"),
					sideEffectEvent(3, "confirmed", { operation: "unregistered" }),
				]),
				{ userId: "operator-secret-1", displayName: "陈昊" },
			).map((fact) => fact.value),
		).toEqual([
			"example.test",
			"读取页面、外部操作",
			"陈昊 · MFA 验证",
			"已确认",
			"不进入模型或平台记录",
		]);
	});

	it("never shows the operator ID when the operator is not the signed-in user", () => {
		const handoff = entries([handoffEvent(1, "completed")]);
		for (const viewer of [
			undefined,
			{ userId: "someone-else", displayName: "林默" },
		]) {
			const value = browserAuditFacts(handoff, viewer).find(
				(fact) => fact.label === "接管人",
			)?.value;
			expect(value).toBe("未识别的用户 · MFA 验证");
			expect(value).not.toContain("operator-secret-1");
			expect(value).not.toContain("林默");
		}
		// 显示名为空时同样不回退到 ID。
		expect(
			browserAuditFacts(handoff, {
				userId: "operator-secret-1",
				displayName: "  ",
			})[2],
		).toEqual({ label: "接管人", value: "未识别的用户 · MFA 验证" });
	});

	it("shows the handoff state and reason before anyone has taken over", () => {
		const requested = handoffEvent(1, "requested");
		if (requested.type !== "browser.handoff") throw new Error("fixture");
		const { operatorId: _operator, ...payload } = requested.payload;
		expect(
			browserAuditFacts(entries([{ ...requested, payload }]), {
				userId: "operator-secret-1",
				displayName: "陈昊",
			})[2],
		).toEqual({ label: "接管人", value: "等待接管 · MFA 验证" });
	});
});

describe("BrowserOperationRecordDialog", () => {
	function open(events: PersistedConversationEventV2[]) {
		const view = render(
			<BrowserOperationRecordDialog
				conversationId="conversation-1"
				executionId="execution-1"
				events={events}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "查看操作记录" }));
		return view;
	}

	it("renders nothing when the execution has no browser records", () => {
		render(
			<BrowserOperationRecordDialog
				conversationId="conversation-1"
				executionId="execution-1"
				events={[
					operationEvent(1, "completed", { executionId: "execution-2" }),
				]}
			/>,
		);
		expect(screen.queryByRole("button", { name: "查看操作记录" })).toBeNull();
	});

	it("opens a read-only modal with facts, a step list and one primary close", async () => {
		open([
			operationEvent(1, "completed"),
			handoffEvent(2, "completed"),
			sideEffectEvent(3, "unknown", { operation: "unregistered.op" }),
		]);
		const dialog = await screen.findByRole("dialog", {
			name: "浏览器操作记录",
		});
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(
			[...dialog.querySelectorAll("dt")].map((item) => item.textContent),
		).toEqual(["域名", "操作范围", "接管人", "结果", "凭证"]);
		expect(
			within(dialog)
				.getAllByRole("button")
				.map(
					(button) => button.textContent || button.getAttribute("aria-label"),
				),
		).toEqual(["关闭", "关闭"]);
		const list = within(dialog).getByRole("list", { name: "操作步骤" });
		const items = within(list).getAllByRole("listitem");
		expect(items).toHaveLength(3);
		for (const item of items) {
			expect(item.getAttribute("role")).toBeNull();
			expect(item.getAttribute("aria-label")).toBeNull();
			expect(item.querySelector("time")?.getAttribute("dateTime")).toBe(
				"2026-10-11T09:59:00.000Z",
			);
			expect(item.textContent).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
		}
		expect(within(dialog).queryByRole("alert")).toBeNull();
		const live = within(dialog).getByRole("status");
		expect(live.textContent).toBe("");
		expect(dialog.textContent).toContain("结果待核实的操作不会自动重试。");
		expect(dialog.textContent).not.toMatch(
			/Browser|恢复|服务端|browser_\w+|https?:\/\/|unregistered|operator-secret-1|handoff-1|confirmation-1|action-|execution-1/,
		);
	});

	it("names the signed-in operator in the facts without exposing the ID", async () => {
		render(
			<BrowserOperationRecordDialog
				conversationId="conversation-1"
				executionId="execution-1"
				events={[handoffEvent(1, "completed")]}
				viewer={{ userId: "operator-secret-1", displayName: "陈昊" }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "查看操作记录" }));
		const dialog = await screen.findByRole("dialog", {
			name: "浏览器操作记录",
		});
		const terms = [...dialog.querySelectorAll("dt")];
		const operator = terms.find((term) => term.textContent === "接管人");
		expect(operator?.nextElementSibling?.textContent).toBe("陈昊 · MFA 验证");
		expect(dialog.textContent).not.toContain("operator-secret-1");
	});

	it("announces only the latest change while open", async () => {
		const events = [operationEvent(1, "started")];
		const { rerender } = open(events);
		const dialog = await screen.findByRole("dialog", {
			name: "浏览器操作记录",
		});
		const live = within(dialog).getByRole("status");
		expect(live.textContent).toBe("");
		act(() =>
			rerender(
				<BrowserOperationRecordDialog
					conversationId="conversation-1"
					executionId="execution-1"
					events={[
						...events,
						operationEvent(2, "completed"),
						handoffEvent(3, "requested"),
					]}
				/>,
			),
		);
		await waitFor(() => expect(live.textContent).toBe("人工接管 · 等待接管"));
	});

	it("shows the fifty-item limit note only when objects were dropped", async () => {
		open(
			Array.from({ length: 55 }, (_, index) =>
				handoffEvent(index + 1, "active", {
					handoffId: `handoff-${index + 1}`,
				}),
			),
		);
		const dialog = await screen.findByRole("dialog", {
			name: "浏览器操作记录",
		});
		expect(within(dialog).getAllByRole("listitem")).toHaveLength(50);
		expect(dialog.textContent).toContain("仅显示最近 50 条");
	});
});
