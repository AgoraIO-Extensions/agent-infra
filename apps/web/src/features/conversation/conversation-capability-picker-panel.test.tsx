import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

const replacementCapabilities: readonly ConversationCapabilityV1[] = [
	{
		...capabilities[0],
		version: "2.0.0",
	},
];

const twoCapabilities: readonly ConversationCapabilityV1[] = [
	...capabilities,
	{
		kind: "command",
		name: "workspace-list",
		description: "List approved workspace files",
		source: "platform",
	},
];

describe("ConversationCapabilityPickerPanel", () => {
	afterEach(cleanup);

	it("filters, selects and confirms without submitting a request", () => {
		render(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="alice:agent-a:conversation-a"
				disabled={false}
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
			screen.getByText(
				"选择已保存在当前草稿中；执行接缝尚未接入，未提交请求。",
			),
		).toBeTruthy();
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

	it("clears a selection when the capability directory replaces it", () => {
		const { rerender } = render(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="alice:agent-a:conversation-a"
				disabled={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		fireEvent.click(screen.getByRole("button", { name: /workspace-summary/ }));
		fireEvent.change(screen.getByRole("textbox", { name: "能力参数" }), {
			target: { value: "README.md" },
		});
		fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
		rerender(
			<ConversationCapabilityPickerPanel
				capabilities={replacementCapabilities}
				scopeKey="alice:agent-a:conversation-a"
				disabled={false}
			/>,
		);
		expect(screen.queryByRole("textbox", { name: "能力参数" })).toBeNull();
		expect(
			screen.queryByText(
				"选择已保存在当前草稿中；执行接缝尚未接入，未提交请求。",
			),
		).toBeNull();
	});

	it("does not consume keyboard shortcuts during IME composition", () => {
		render(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="alice:agent-a:conversation-a"
				disabled={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		const search = screen.getByRole("textbox", { name: "搜索命令或 Skill" });
		fireEvent.keyDown(search, { key: "Enter", isComposing: true });
		expect(screen.queryByRole("textbox", { name: "能力参数" })).toBeNull();
	});

	it("clears draft state while unavailable and after availability returns", () => {
		const { rerender } = render(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="alice:agent-a:conversation-a"
				disabled={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		fireEvent.click(screen.getByRole("button", { name: /workspace-summary/ }));
		fireEvent.change(screen.getByRole("textbox", { name: "能力参数" }), {
			target: { value: "README.md" },
		});
		fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
		rerender(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="alice:agent-a:conversation-a"
				disabled
			/>,
		);
		expect(screen.queryByRole("textbox", { name: "能力参数" })).toBeNull();
		expect(
			screen.queryByText(
				"选择已保存在当前草稿中；执行接缝尚未接入，未提交请求。",
			),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /workspace-summary/ }),
		).toBeNull();
		rerender(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="alice:agent-a:conversation-a"
				disabled={false}
			/>,
		);
		expect(screen.queryByRole("textbox", { name: "能力参数" })).toBeNull();
	});

	it("clamps the keyboard index when the directory shrinks", () => {
		const { rerender } = render(
			<ConversationCapabilityPickerPanel
				capabilities={twoCapabilities}
				scopeKey="alice:agent-a:conversation-a"
				disabled={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		const search = screen.getByRole("textbox", { name: "搜索命令或 Skill" });
		fireEvent.keyDown(search, { key: "ArrowDown" });
		rerender(
			<ConversationCapabilityPickerPanel
				capabilities={capabilities}
				scopeKey="alice:agent-a:conversation-a"
				disabled={false}
			/>,
		);
		fireEvent.keyDown(search, { key: "Enter" });
		expect(screen.getByRole("textbox", { name: "能力参数" })).toBeTruthy();
	});
});
