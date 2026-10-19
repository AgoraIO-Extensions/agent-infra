import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert.js";

afterEach(cleanup);

function alertElement(container: HTMLElement) {
	const element = container.querySelector('[data-slot="alert"]');
	if (!(element instanceof HTMLElement)) throw new Error("missing alert");
	return element;
}

describe("Alert", () => {
	it("does not set a live role when a tone is given without role", () => {
		const { container } = render(
			<Alert tone="info">
				<AlertTitle>最小审计数据</AlertTitle>
				<AlertDescription>说明</AlertDescription>
			</Alert>,
		);
		const element = alertElement(container);
		expect(element.getAttribute("role")).toBeNull();
		expect(element.getAttribute("aria-live")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("passes explicit status and alert roles through", () => {
		render(
			<>
				<Alert tone="info" role="status">
					<AlertDescription>已保存</AlertDescription>
				</Alert>
				<Alert tone="danger" role="alert">
					<AlertDescription>保存失败</AlertDescription>
				</Alert>
			</>,
		);
		expect(screen.getByRole("status").textContent).toBe("已保存");
		expect(screen.getByRole("alert").textContent).toBe("保存失败");
	});

	it("requires a tone and has no implicit role or icon-less fallback (B-10)", () => {
		// @ts-expect-error tone 必填：不再有缺省 tone 时默认 role=alert、无图标的兼容路径。
		const legacy = <Alert>旧调用点</Alert>;
		expect(legacy.props.tone).toBeUndefined();
		const { container } = render(
			<Alert tone="danger">
				<AlertDescription>失败说明</AlertDescription>
			</Alert>,
		);
		const element = alertElement(container);
		expect(element.getAttribute("role")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(element.dataset.tone).toBe("danger");
		expect(
			element
				.querySelector(":scope > svg")
				?.classList.contains("lucide-circle-alert"),
		).toBe(true);
	});

	it.each([
		["info", "lucide-info", "[&>svg]:text-(--accent)"],
		["warn", "lucide-triangle-alert", "[&>svg]:text-(--warning)"],
		["danger", "lucide-circle-alert", "[&>svg]:text-(--danger)"],
	] as const)("renders the default %s icon", (tone, iconClass, color) => {
		const { container } = render(
			<Alert tone={tone}>
				<AlertDescription>说明</AlertDescription>
			</Alert>,
		);
		const element = alertElement(container);
		const icon = element.querySelector(":scope > svg");
		expect(icon?.classList.contains(iconClass)).toBe(true);
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
		expect(element.className).toContain(color);
		// 只有图标变色，文字不变红。
		expect(element.className).not.toContain("text-destructive");
	});

	it("hides the icon with icon={null} and lays out title, description and action in one column", () => {
		const { container } = render(
			<Alert tone="danger" role="alert" icon={null}>
				<AlertTitle>读取失败</AlertTitle>
				<AlertDescription>请稍后重试。</AlertDescription>
				<AlertAction>
					<button type="button">重试</button>
				</AlertAction>
			</Alert>,
		);
		const element = alertElement(container);
		expect(element.querySelector("svg")).toBeNull();
		const content = element.querySelector('[data-slot="alert-content"]');
		expect(content?.children).toHaveLength(3);
		expect(screen.getByText("读取失败").tagName).toBe("STRONG");
		expect(
			content?.querySelector('[data-slot="alert-action"]')?.className,
		).not.toContain("absolute");
	});

	it("keeps decorative native elements and explicit-icon children in the content column", () => {
		const { container } = render(
			<>
				<Alert tone="info">
					<span aria-hidden="true">•</span>
					<AlertDescription>装饰</AlertDescription>
				</Alert>
				<Alert tone="info" icon={null}>
					<svg aria-hidden="true" data-testid="kept-icon" />
					<AlertDescription>显式图标</AlertDescription>
				</Alert>
			</>,
		);
		const [decorated, explicit] = Array.from(
			container.querySelectorAll('[data-slot="alert"]'),
		);
		expect(
			decorated?.querySelector('[data-slot="alert-content"] > span'),
		).not.toBeNull();
		expect(
			explicit?.querySelector(
				'[data-slot="alert-content"] [data-testid="kept-icon"]',
			),
		).not.toBeNull();
	});

	it("never turns the danger description text red", () => {
		const { container } = render(
			<Alert tone="danger" role="alert">
				<AlertDescription>失败</AlertDescription>
			</Alert>,
		);
		expect(alertElement(container).className).not.toContain("--danger-ink");
	});

	it("moves a leading icon child into the icon slot", () => {
		const { container } = render(
			<Alert tone="info">
				<svg aria-hidden="true" data-testid="legacy-icon" />
				<AlertTitle>Browser 工作流</AlertTitle>
			</Alert>,
		);
		const element = alertElement(container);
		expect(element.firstElementChild?.getAttribute("data-testid")).toBe(
			"legacy-icon",
		);
		expect(element.querySelector('[data-slot="alert-content"] svg')).toBeNull();
	});
});
