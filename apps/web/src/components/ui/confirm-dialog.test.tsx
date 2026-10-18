import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button.js";
import { ConfirmDialog } from "./confirm-dialog.js";

afterEach(cleanup);

describe("ConfirmDialog", () => {
	it("requires an explicit confirm label", () => {
		type Props = Parameters<typeof ConfirmDialog>[0];
		// @ts-expect-error confirmLabel 必须写明动作，没有默认值。
		const missing: Props = {
			title: "撤销这张 API 凭证？",
			description: "撤销后不能恢复。",
			onConfirm: () => undefined,
			trigger: <Button>撤销</Button>,
		};
		const required: undefined extends Props["confirmLabel"] ? false : true =
			true;
		expect(missing).toBeTruthy();
		expect(required).toBe(true);
	});

	it("shows the subject and consequence, and only confirms once", async () => {
		const onConfirm = vi.fn();
		render(
			<ConfirmDialog
				title="撤销这张 API 凭证？"
				subject={{ name: "credential-1", detail: "权限：agent:read" }}
				description="撤销后不能恢复。"
				confirmLabel="撤销凭证"
				onConfirm={onConfirm}
				trigger={<Button variant="outline">撤销</Button>}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "撤销" }));
		const dialog = await screen.findByRole("dialog", {
			name: "撤销这张 API 凭证？",
		});
		expect(within(dialog).getByText("credential-1")).toBeTruthy();
		expect(within(dialog).getByText("权限：agent:read")).toBeTruthy();
		expect(onConfirm).not.toHaveBeenCalled();
		const confirm = within(dialog).getByRole("button", { name: "撤销凭证" });
		expect(confirm.className).toContain("bg-destructive");
		expect(
			within(dialog).getByRole("button", { name: "取消" }).className,
		).toContain("text-muted-foreground");
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		expect(onConfirm).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("cancels without confirming", async () => {
		const onConfirm = vi.fn();
		render(
			<ConfirmDialog
				title="停用这个应用？"
				description="停用后平台拒绝新任务。"
				confirmLabel="停用应用"
				onConfirm={onConfirm}
				trigger={<Button variant="outline">停用应用</Button>}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "停用应用" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(onConfirm).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "停用应用" }),
		);
	});

	it("disables both the trigger and the confirm button", async () => {
		const onConfirm = vi.fn();
		const { rerender } = render(
			<ConfirmDialog
				open
				disabled
				title="停止这个 Agent？"
				description="停止后暂不能发送消息。"
				confirmLabel="停止 Agent"
				onConfirm={onConfirm}
				trigger={<Button>停止中…</Button>}
			/>,
		);
		const dialog = await screen.findByRole("dialog");
		const confirm = within(dialog).getByRole("button", { name: "停止 Agent" });
		expect(confirm.hasAttribute("disabled")).toBe(true);
		fireEvent.click(confirm);
		expect(onConfirm).not.toHaveBeenCalled();
		rerender(
			<ConfirmDialog
				open={false}
				disabled
				title="停止这个 Agent？"
				description="停止后暂不能发送消息。"
				confirmLabel="停止 Agent"
				onConfirm={onConfirm}
				trigger={<Button>停止中…</Button>}
			/>,
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const trigger = screen.getByRole("button", { name: "停止中…" });
		expect(
			trigger.hasAttribute("disabled") ||
				trigger.getAttribute("aria-disabled") === "true",
		).toBe(true);
	});

	it("supports controlled open state and a final focus target", async () => {
		const onConfirm = vi.fn();
		function Controlled() {
			const [open, setOpen] = useState(false);
			const target = useRef<HTMLHeadingElement>(null);
			return (
				<>
					<h2 ref={target} tabIndex={-1}>
						应用名
					</h2>
					<ConfirmDialog
						open={open}
						onOpenChange={setOpen}
						finalFocus={target}
						tone="default"
						title="重启编程助手？"
						description="重启期间暂不能发送消息。"
						confirmLabel="确认重启"
						onConfirm={onConfirm}
						trigger={<Button variant="outline">重启 Agent</Button>}
					/>
				</>
			);
		}
		render(<Controlled />);
		fireEvent.click(screen.getByRole("button", { name: "重启 Agent" }));
		const dialog = await screen.findByRole("dialog", {
			name: "重启编程助手？",
		});
		const confirm = within(dialog).getByRole("button", { name: "确认重启" });
		expect(confirm.className).not.toContain("bg-destructive");
		fireEvent.click(confirm);
		expect(onConfirm).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "应用名" }),
			),
		);
	});
});
