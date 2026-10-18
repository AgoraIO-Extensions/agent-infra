import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IdentifierText } from "./identifier-text";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const longValue = "a".repeat(8) + "b".repeat(32);

it("shows a monospace short form with the full value as title", () => {
	render(<IdentifierText value={longValue} label="审计 ID" />);
	const code = screen.getByText("aaaaaaaa…");
	expect(code.getAttribute("title")).toBe(longValue);
	expect(code.className).toContain("font-mono");
	expect(document.body.textContent).not.toContain(longValue);
	cleanup();
	render(<IdentifierText value="short-id-12c" label="审计 ID" />);
	expect(screen.getByText("short-id-12c")).toBeTruthy();
});

it("copies the full value and announces the result for 1.6s", async () => {
	vi.useFakeTimers();
	const writeText = vi.fn(async () => undefined);
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	render(<IdentifierText value={longValue} label="审计 ID" copyable />);
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "复制 审计 ID" }));
	});
	expect(writeText).toHaveBeenCalledWith(longValue);
	expect(screen.getByRole("status").textContent).toBe("已复制");
	act(() => {
		vi.advanceTimersByTime(1600);
	});
	expect(screen.queryByRole("status")).toBeNull();
});

it("omits the copy button when the clipboard is unavailable", () => {
	vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
	render(<IdentifierText value={longValue} label="审计 ID" copyable />);
	expect(screen.queryByRole("button")).toBeNull();
});
