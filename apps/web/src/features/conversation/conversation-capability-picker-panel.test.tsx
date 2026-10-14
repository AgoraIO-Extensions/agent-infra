import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationCapabilityV1 } from "./conversation-capability-picker.js";
import { ConversationCapabilityPickerPanel } from "./conversation-capability-picker-panel.js";

const capabilities: readonly ConversationCapabilityV1[] = [
	{
		kind: "skill",
		name: "workspace-summary",
		description: "Summarize approved workspace files",
		source: "skillhub",
		version: "1.0.0",
		parameterHint: "file",
	},
];

describe("ConversationCapabilityPickerPanel", () => {
	afterEach(cleanup);

	it("filters, selects and confirms once through the admission callback", () => {
		const onConfirm = vi.fn();
		render(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="alice:agent-a:conversation-a"
				disabled={false}
				onConfirm={onConfirm}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		fireEvent.change(
			screen.getByRole("textbox", { name: "搜索命令或 Skill" }),
			{
				target: { value: "workspace" },
			},
		);
		fireEvent.click(screen.getByRole("button", { name: /workspace-summary/ }));
		fireEvent.change(screen.getByRole("textbox", { name: "能力参数" }), {
			target: { value: "README.md" },
		});
		fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
		expect(
			screen.getByText("选择已确认，正在通过当前会话接缝提交。"),
		).toBeTruthy();
		expect(onConfirm).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("does not expose an empty picker or controls for an unavailable scope", () => {
		const { container } = render(
			<ConversationCapabilityPickerPanel
				capabilities={[]}
				scopeKey="scope"
				disabled
			/>,
		);
		expect(container.firstChild).toBeNull();
	});

	it("clears the draft when the scope or authorized capability version changes", () => {
		const { rerender } = render(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="scope-a"
				disabled={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		fireEvent.click(screen.getByRole("button", { name: /workspace-summary/ }));
		fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
		expect(screen.getByText(/选择已确认/)).toBeTruthy();
		rerender(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities.map((capability) => ({
					...capability,
					identity: "replaced-package",
				}))}
				scopeKey="scope-b"
				disabled={false}
			/>,
		);
		expect(screen.queryByText(/选择已确认/)).toBeNull();
		expect(screen.queryByText(/workspace-summary 参数/)).toBeNull();
	});

	it("clears the draft when the Agent becomes unavailable", () => {
		const { rerender } = render(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="scope"
				disabled={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		fireEvent.click(screen.getByRole("button", { name: /workspace-summary/ }));
		fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
		expect(screen.getByText(/选择已确认/)).toBeTruthy();
		rerender(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="scope"
				disabled
			/>,
		);
		expect(screen.queryByText(/选择已确认/)).toBeNull();
		expect(screen.queryByText(/workspace-summary 参数/)).toBeNull();
	});

	it("leaves IME composition keys to the input method", () => {
		render(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="scope"
				disabled={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		const input = screen.getByRole("textbox", { name: "搜索命令或 Skill" });
		fireEvent.keyDown(input, { key: "Enter", isComposing: true });
		expect(screen.queryByText(/workspace-summary 参数/)).toBeNull();
	});
});
