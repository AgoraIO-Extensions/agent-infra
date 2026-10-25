import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
// 后注册的 afterEach 先执行：先换回真实定时器，再由 cleanup 卸载。
afterEach(() => {
	vi.useRealTimers();
});

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

/**
 * 页面标题与弹窗分两个根渲染：卸载弹窗（连同触发按钮）后页面标题仍在，焦点落到 body 时
 * 仍在看护的话会被移到标题上。弹窗打开后改用假定时器，再点「取消」关闭，此时看护刚开始、
 * 它的定时器都还挂起。
 */
async function closeDialogOverPage() {
	render(
		<main id="main-content" tabIndex={-1}>
			<h1 tabIndex={-1}>审阅队列</h1>
		</main>,
	);
	const view = render(<Example />);
	const open = screen.getByRole("button", { name: "打开" });
	open.focus();
	fireEvent.click(open);
	const dialog = await screen.findByRole("dialog");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
	expect(screen.queryByRole("dialog")).toBeNull();
	return {
		heading: screen.getByRole("heading", { name: "审阅队列" }),
		unmountDialog: () => view.unmount(),
	};
}

/** 模拟测试文件结束后 jsdom 环境卸载：从全局移除这些键，run 结束后原样恢复。 */
function withoutBrowserGlobals(
	keys: readonly ("document" | "location")[],
	run: () => void,
) {
	const saved = keys.map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	for (const key of keys) Reflect.deleteProperty(globalThis, key);
	try {
		for (const key of keys) expect(key in globalThis).toBe(false);
		run();
	} finally {
		for (const [key, descriptor] of saved)
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
	}
}

/** 触发一次 DOM 改动并等观察器回调执行完。 */
async function mutateDom() {
	const node = document.createElement("p");
	document.body.append(node);
	await Promise.resolve();
	node.remove();
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

	it("clears its pending timers and observer when the guard stops right after closing", async () => {
		const { unmountDialog } = await closeDialogOverPage();
		const pending = vi.getTimerCount();
		// 用户按下指针：看护停止，它的 0ms 检查与 10 秒到期两个定时器一并清除。
		fireEvent.pointerDown(document.body);
		expect(vi.getTimerCount()).toBe(pending - 2);
		// 触发按钮随后卸载、焦点落到 body：已停止的看护不再把焦点移到页面标题。
		unmountDialog();
		await mutateDom();
		expect(() => vi.runAllTimers()).not.toThrow();
		await mutateDom();
		expect(document.activeElement).toBe(document.body);
	});

	it("ends the guard without reading location or document when the environment is torn down before its close check", async () => {
		const { unmountDialog } = await closeDialogOverPage();
		// 测试结束：cleanup 先卸载组件，jsdom 随后从全局移除 document 与 location，
		// 挂起的 0ms 检查这时才执行（#3056 的 CI 失败）。
		unmountDialog();
		withoutBrowserGlobals(["document", "location"], () => {
			expect(() => vi.advanceTimersByTime(0)).not.toThrow();
		});
		await Promise.resolve();
		expect(document.activeElement).toBe(document.body);
		// 看护已随环境卸载结束：之后的 DOM 改动与到期都不移动焦点。
		await mutateDom();
		expect(() => vi.runAllTimers()).not.toThrow();
		expect(document.activeElement).toBe(document.body);
	});

	it("ends the guard without reading document when the environment is torn down before it expires", async () => {
		const { heading, unmountDialog } = await closeDialogOverPage();
		unmountDialog();
		await Promise.resolve();
		vi.advanceTimersByTime(0);
		// 环境仍在时保持 #3048 的行为：触发按钮卸载后焦点移到页面标题。
		expect(document.activeElement).toBe(heading);
		withoutBrowserGlobals(["document", "location"], () => {
			expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
		});
		// 看护已到期结束：焦点再落到 body 也不再移回标题。
		heading.blur();
		await mutateDom();
		expect(document.activeElement).toBe(document.body);
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

// #3419 N14-09：调用方指定了 finalFocus 的弹窗关闭（含随所在分区卸载）时，目标已不在文档、焦点落到 body，
// 交给壳层兜底的同一个去处（页面 h1，不可聚焦时 #main-content），不滚动；目标仍在时照常回到目标。
describe("Dialog with an explicit finalFocus", () => {
	afterEach(() => {
		fireEvent.pointerDown(document.body);
	});

	function Section({
		present,
		open,
		onOpenChange,
	}: {
		present: boolean;
		open: boolean;
		onOpenChange: (open: boolean) => void;
	}) {
		const trigger = React.useRef<HTMLButtonElement>(null);
		return (
			<main id="main-content" tabIndex={-1}>
				<h1 tabIndex={-1}>API 凭证</h1>
				{present ? (
					<section>
						<Dialog open={open} onOpenChange={onOpenChange}>
							<DialogTrigger
								ref={trigger}
								render={<Button variant="outline" />}
							>
								撤销：凭证
							</DialogTrigger>
							<DialogContent finalFocus={trigger}>
								<DialogHeader>
									<DialogTitle>撤销这张 API 凭证？</DialogTitle>
								</DialogHeader>
								<DialogFooter>
									<DialogClose render={<Button variant="ghost" />}>
										取消
									</DialogClose>
								</DialogFooter>
							</DialogContent>
						</Dialog>
					</section>
				) : (
					<p role="alert">登录状态已失效，请重新登录后再试。</p>
				)}
			</main>
		);
	}

	it("hands focus to the page heading without scrolling when the dialog unmounts with its section", async () => {
		const view = render(
			<Section present open={false} onOpenChange={() => undefined} />,
		);
		const trigger = screen.getByRole("button", { name: "撤销：凭证" });
		trigger.focus();
		view.rerender(<Section present open onOpenChange={() => undefined} />);
		await screen.findByRole("dialog");
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		// 后台重读读到登录失效：分区连同弹窗与触发按钮一起换成提示。
		view.rerender(
			<Section present={false} open onOpenChange={() => undefined} />,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { name: "API 凭证" }),
			),
		);
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		focus.mockRestore();
	});

	it("still returns focus to a finalFocus target that is in the document", async () => {
		function Controlled() {
			const [open, setOpen] = React.useState(false);
			return <Section present open={open} onOpenChange={setOpen} />;
		}
		render(<Controlled />);
		const trigger = screen.getByRole("button", { name: "撤销：凭证" });
		trigger.focus();
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(document.activeElement).toBe(trigger);
	});
});
