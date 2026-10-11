import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type BrowserHandoffBindingV1,
	BrowserHandoffPanel,
	type BrowserHandoffPanelStateV1,
	type BrowserSideEffectConfirmationV1,
} from "./browser-handoff-panel.js";

const binding: BrowserHandoffBindingV1 = {
	subjectId: "subject-1",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 2,
	resourceFence: 7,
	capabilityVersion: 1,
	pageRevision: 4,
};

const requested: BrowserHandoffPanelStateV1 = {
	handoffId: "handoff-1",
	status: "requested",
	reason: "mfa",
	expiresAt: "2026-10-11T12:00:00.000Z",
	binding,
};

const confirmation: BrowserSideEffectConfirmationV1 = {
	confirmationId: "confirmation-1",
	status: "pending",
	operation: "submit",
	targetOrigin: "https://example.test/",
	redactedTargetSummary: "提交公开表单（已脱敏）",
	binding,
};

describe("Browser handoff and confirmation panel", () => {
	afterEach(() => cleanup());

	it("offers takeover and passes only the opaque id plus verified binding", () => {
		const onTakeOver = vi.fn();
		const onPauseAgent = vi.fn();
		render(
			<BrowserHandoffPanel
				currentBinding={binding}
				handoff={requested}
				onPauseAgent={onPauseAgent}
				onTakeOver={onTakeOver}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toContain("MFA 验证");
		expect(screen.getByRole("alert").textContent).toContain(
			"Agent、Session 和授权绑定由服务端维护。",
		);
		expect(screen.getByRole("alert").textContent).toContain("页面版本：4");
		screen.getByRole("button", { name: "暂停 Agent" }).click();
		screen.getByRole("button", { name: "接管浏览器" }).click();
		expect(onPauseAgent).toHaveBeenCalledWith({ id: "handoff-1", binding });
		expect(onTakeOver).toHaveBeenCalledWith({ id: "handoff-1", binding });
	});

	it.each([
		["active", "交回 Agent"],
		["returning", "正在重新校验页面、Session 和授权状态。"],
		["completed", "本次接管已经结束，不能重复使用原请求。"],
		["revoked", "本次接管已经结束，不能重复使用原请求。"],
		["expired", "本次接管已经结束，不能重复使用原请求。"],
		["crashed", "浏览器已崩溃"],
		["unknown", "状态待核实"],
	] as const)("renders the %s handoff state safely", (status, detail) => {
		const onReturnToAgent = vi.fn();
		const handoff = {
			...requested,
			status,
			...(status === "unknown"
				? { terminalReasonCode: "BROWSER_HANDOFF_RETURN_UNCONFIRMED" }
				: {}),
		} as BrowserHandoffPanelStateV1;
		render(
			<BrowserHandoffPanel
				handoff={handoff}
				currentBinding={binding}
				onReturnToAgent={onReturnToAgent}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain(detail);
		if (status === "active") {
			screen.getByRole("button", { name: "交回 Agent" }).click();
			expect(onReturnToAgent).toHaveBeenCalledWith({
				id: "handoff-1",
				binding,
			});
		} else {
			expect(screen.queryByRole("button")).toBeNull();
		}
	});

	it("renders a bounded confirmation and sends only its opaque id", () => {
		const onConfirmSideEffect = vi.fn();
		const onRejectSideEffect = vi.fn();
		const onCancelConfirmation = vi.fn();
		render(
			<BrowserHandoffPanel
				confirmation={confirmation}
				currentBinding={binding}
				browserAvailable
				onCancelConfirmation={onCancelConfirmation}
				onConfirmSideEffect={onConfirmSideEffect}
				onRejectSideEffect={onRejectSideEffect}
			/>,
		);
		expect(screen.getByText("https://example.test")).toBeTruthy();
		expect(screen.getByText("提交公开表单（已脱敏）")).toBeTruthy();
		expect(screen.getByText(/密码、MFA、Cookie/)).toBeTruthy();
		expect(screen.queryByText(binding.subjectId)).toBeNull();
		screen.getByRole("button", { name: "确认执行" }).click();
		screen.getByRole("button", { name: "拒绝" }).click();
		screen.getByRole("button", { name: "取消" }).click();
		expect(onConfirmSideEffect).toHaveBeenCalledWith({
			id: "confirmation-1",
			binding,
		});
		expect(onRejectSideEffect).toHaveBeenCalledWith({
			id: "confirmation-1",
			binding,
		});
		expect(onCancelConfirmation).toHaveBeenCalledWith({
			id: "confirmation-1",
			binding,
		});
	});

	it("fails closed for unsafe origins, invalid bindings and unknown outcomes", () => {
		render(
			<BrowserHandoffPanel
				currentBinding={binding}
				browserAvailable
				confirmation={{
					...confirmation,
					targetOrigin: "https://example.test/private?token=secret",
				}}
				handoff={{
					...requested,
					status: "unknown",
					binding: { ...binding, resourceFence: 0 },
				}}
			/>,
		);
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByText("https://example.test")).toBeNull();
	});

	it("blocks a stale current binding and an expired handoff", () => {
		const onTakeOver = vi.fn();
		const stale = { ...binding, pageRevision: binding.pageRevision + 1 };
		render(
			<BrowserHandoffPanel
				currentBinding={stale}
				handoff={requested}
				onTakeOver={onTakeOver}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain("无法核验");
		expect(screen.queryByRole("button")).toBeNull();
		cleanup();

		render(
			<BrowserHandoffPanel
				currentBinding={binding}
				handoff={requested}
				now={() => Date.parse("2026-10-11T13:00:00.000Z")}
				onTakeOver={onTakeOver}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain("已过期");
		expect(screen.queryByRole("button")).toBeNull();
		expect(onTakeOver).not.toHaveBeenCalled();
	});

	it("blocks confirmation while the browser or handoff is unavailable", () => {
		const onConfirmSideEffect = vi.fn();
		render(
			<BrowserHandoffPanel
				browserAvailable
				confirmation={confirmation}
				currentBinding={binding}
				handoff={{ ...requested, status: "crashed" }}
				onConfirmSideEffect={onConfirmSideEffect}
			/>,
		);
		expect(
			screen
				.getAllByRole("alert")
				.map((alert) => alert.textContent)
				.join(" "),
		).toContain("不会执行此副作用");
		expect(screen.queryByRole("button")).toBeNull();
		expect(onConfirmSideEffect).not.toHaveBeenCalled();
	});
});
