import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button.js";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./dialog.js";

afterEach(cleanup);

function Example({
	showCloseButton,
	variant,
}: {
	showCloseButton?: boolean;
	variant?: "modal" | "skill";
}) {
	return (
		<Dialog>
			<DialogTrigger render={<Button variant="outline" />}>打开</DialogTrigger>
			<DialogContent showCloseButton={showCloseButton} variant={variant}>
				<DialogHeader>
					<DialogTitle>停止这个 Agent？</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<DialogDescription>停止后暂不能发送消息。</DialogDescription>
				</DialogBody>
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>取消</DialogClose>
					<Button variant="destructive">停止 Agent</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

describe("Dialog", () => {
	it("is modal, labelled by its title and focuses its own container", async () => {
		render(<Example />);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		const dialog = await screen.findByRole("dialog", {
			name: "停止这个 Agent？",
		});
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		const title = within(dialog).getByRole("heading", {
			name: "停止这个 Agent？",
		});
		expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
		await waitFor(() => expect(document.activeElement).toBe(dialog));
	});

	it("renders exactly one close button inside the header", async () => {
		render(<Example />);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		const dialog = await screen.findByRole("dialog");
		// 图标关闭钮名为「关闭弹窗」，不与页脚的「关闭」等文字按钮重名（X-04）。
		const closeButtons = within(dialog).getAllByRole("button", {
			name: "关闭弹窗",
		});
		expect(closeButtons).toHaveLength(1);
		expect(
			closeButtons[0]?.closest('[data-slot="dialog-header"]'),
		).not.toBeNull();
		expect(closeButtons[0]?.className).not.toContain("absolute");
		const footer = dialog.querySelector('[data-slot="dialog-footer"]');
		expect(footer?.className).toContain("justify-end");
		expect(footer?.className).not.toContain("flex-col-reverse");
		fireEvent.click(closeButtons[0] as HTMLElement);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("omits the close button when showCloseButton is false", async () => {
		render(<Example showCloseButton={false} />);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).queryByRole("button", { name: "关闭弹窗" }),
		).toBeNull();
		expect(within(dialog).queryByRole("button", { name: "关闭" })).toBeNull();
	});

	it("moves focus to the page heading when the trigger is removed after closing", async () => {
		function Removable() {
			const [present, setPresent] = React.useState(true);
			return (
				<main id="main-content" tabIndex={-1}>
					<h1 tabIndex={-1}>审阅队列</h1>
					{present ? (
						<Dialog>
							<DialogTrigger render={<Button variant="outline" />}>
								审阅
							</DialogTrigger>
							<DialogContent>
								<DialogHeader>
									<DialogTitle>审阅发布申请</DialogTitle>
								</DialogHeader>
								<DialogFooter>
									<DialogClose
										render={<Button />}
										// 提交成功：弹窗关闭，随后该行离开列表、触发按钮卸载。
										onClick={() => setTimeout(() => setPresent(false), 30)}
									>
										批准发布
									</DialogClose>
								</DialogFooter>
							</DialogContent>
						</Dialog>
					) : null}
				</main>
			);
		}
		render(<Removable />);
		const trigger = screen.getByRole("button", { name: "审阅" });
		trigger.focus();
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "批准发布" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "审阅队列" }),
			),
		);
	});

	it("does not take focus back after the user moves it elsewhere", async () => {
		function Removable() {
			const [present, setPresent] = React.useState(true);
			return (
				<main id="main-content" tabIndex={-1}>
					<h1 tabIndex={-1}>审阅队列</h1>
					<Button onClick={() => setPresent(false)}>移除</Button>
					{present ? <Example /> : null}
				</main>
			);
		}
		render(<Removable />);
		const open = screen.getByRole("button", { name: "打开" });
		open.focus();
		fireEvent.click(open);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(document.activeElement).toBe(open));
		const other = screen.getByRole("button", { name: "移除" });
		other.focus();
		fireEvent.click(other);
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "打开" })).toBeNull(),
		);
		expect(document.activeElement).toBe(other);
	});

	it("stops guarding focus once the address changes, including the query", async () => {
		function Removable() {
			const [present, setPresent] = React.useState(true);
			return (
				<main id="main-content" tabIndex={-1}>
					<h1 tabIndex={-1}>审阅队列</h1>
					{present ? (
						<Dialog>
							<DialogTrigger render={<Button variant="outline" />}>
								审阅
							</DialogTrigger>
							<DialogContent>
								<DialogHeader>
									<DialogTitle>审阅发布申请</DialogTitle>
								</DialogHeader>
								<DialogFooter>
									<DialogClose
										render={<Button />}
										onClick={() =>
											setTimeout(() => {
												// 同一路径换了查询参数：新视图由页面自己的焦点管理接手。
												history.pushState(null, "", "?scope=done");
												setPresent(false);
											}, 30)
										}
									>
										批准发布
									</DialogClose>
								</DialogFooter>
							</DialogContent>
						</Dialog>
					) : null}
				</main>
			);
		}
		const before = `${location.pathname}${location.search}`;
		try {
			render(<Removable />);
			const trigger = screen.getByRole("button", { name: "审阅" });
			trigger.focus();
			fireEvent.click(trigger);
			const dialog = await screen.findByRole("dialog");
			fireEvent.click(within(dialog).getByRole("button", { name: "批准发布" }));
			await waitFor(() => expect(document.activeElement).toBe(trigger));
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "审阅" })).toBeNull(),
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(document.activeElement).not.toBe(
				screen.getByRole("heading", { name: "审阅队列" }),
			);
		} finally {
			history.replaceState(null, "", before);
		}
	});

	it("uses the design surface without blur or animation on the backdrop", async () => {
		render(<Example />);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.className).toContain("rounded-[16px]");
		expect(dialog.className).toContain("max-h-[min(88dvh,760px)]");
		expect(dialog.className).toContain("p-[19px]");
		expect(dialog.className).toContain("md:p-6");
		expect(dialog.getAttribute("data-variant")).toBe("modal");
		const backdrop = document.querySelector('[data-slot="dialog-overlay"]');
		expect(backdrop?.className).toContain("z-[80]");
		expect(backdrop?.className).not.toMatch(/blur|animate/);
	});

	it("uses the design .skill-dialog surface, title, text close and action gap for the skill variant", async () => {
		render(<Example variant="skill" />);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		const dialog = await screen.findByRole("dialog", {
			name: "停止这个 Agent？",
		});
		expect(dialog.getAttribute("data-variant")).toBe("skill");
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		for (const token of [
			"rounded-[14px]",
			"max-h-[86dvh]",
			"w-[calc(100%-36px)]",
			"max-w-[620px]",
			"p-[18px]",
			"md:p-6",
			"[box-shadow:var(--shadow)]",
		])
			expect(dialog.className).toContain(token);
		expect(dialog.className).not.toContain("rounded-[16px]");
		const title = within(dialog).getByRole("heading", {
			name: "停止这个 Agent？",
		});
		expect(title.className).toContain("text-[20px]");
		expect(title.className).toContain("font-semibold");
		expect(title.className).toContain("leading-[1.4]");
		// 关闭是页眉里的 ghost 文字按钮「关闭」，没有图标钮。
		expect(
			within(dialog).queryByRole("button", { name: "关闭弹窗" }),
		).toBeNull();
		const close = within(dialog).getByRole("button", { name: "关闭" });
		expect(close.textContent).toBe("关闭");
		expect(close.closest('[data-slot="dialog-header"]')).not.toBeNull();
		const footer = dialog.querySelector('[data-slot="dialog-footer"]');
		expect(footer?.className).toContain("mt-5");
		expect(footer?.className).not.toContain("mt-6");
		fireEvent.click(close);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
