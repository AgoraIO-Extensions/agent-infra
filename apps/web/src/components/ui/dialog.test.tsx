import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
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

function Example({ showCloseButton }: { showCloseButton?: boolean }) {
	return (
		<Dialog>
			<DialogTrigger render={<Button variant="outline" />}>打开</DialogTrigger>
			<DialogContent showCloseButton={showCloseButton}>
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
		const closeButtons = within(dialog).getAllByRole("button", {
			name: "关闭",
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
		expect(within(dialog).queryByRole("button", { name: "关闭" })).toBeNull();
	});

	it("uses the design surface without blur or animation on the backdrop", async () => {
		render(<Example />);
		fireEvent.click(screen.getByRole("button", { name: "打开" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.className).toContain("rounded-[16px]");
		expect(dialog.className).toContain("max-h-[min(88dvh,760px)]");
		expect(dialog.className).toContain("p-[19px]");
		expect(dialog.className).toContain("md:p-6");
		const backdrop = document.querySelector('[data-slot="dialog-overlay"]');
		expect(backdrop?.className).toContain("z-[80]");
		expect(backdrop?.className).not.toMatch(/blur|animate/);
	});
});
