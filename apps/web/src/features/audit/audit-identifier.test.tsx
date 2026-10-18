import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditIdentifier, shortIdentifier } from "./audit-identifier.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AuditIdentifier", () => {
	it("keeps compact values inspectable through native disclosure", () => {
		const value = "agent-0123456789abcdef0123456789abcdef";
		render(<AuditIdentifier value={value} label="Agent ID" compact />);

		expect(shortIdentifier(value)).toBe("agent-01…abcdef");
		expect(screen.getByText("agent-01…abcdef")).toBeTruthy();
		const expandButton = screen.getByRole("button", {
			name: "展开完整Agent ID",
		});
		expect(expandButton.getAttribute("aria-expanded")).toBe("false");

		fireEvent.click(expandButton);
		expect(screen.getByText(value, { exact: true })).toBeTruthy();
		expect(expandButton.getAttribute("aria-expanded")).toBe("true");
	});

	it("renders the complete detail value and copies it with an explicit label", async () => {
		const value = "execution-0123456789abcdef0123456789abcdef";
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		render(<AuditIdentifier value={value} label="原 Execution ID" />);

		expect(screen.getByText(value, { exact: true })).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "复制原 Execution ID" }),
		);

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(value));
		expect(
			screen.getByRole("button", { name: "已复制原 Execution ID" }),
		).toBeTruthy();
	});
});
