import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";

describe("Tabs", () => {
	it("uses vertical arrow keys when rendered vertically", async () => {
		render(
			<Tabs defaultValue="first" orientation="vertical">
				<TabsList activateOnFocus aria-label="Vertical views">
					<TabsTrigger value="first">First</TabsTrigger>
					<TabsTrigger value="second">Second</TabsTrigger>
				</TabsList>
				<TabsContent value="first">First view</TabsContent>
				<TabsContent value="second">Second view</TabsContent>
			</Tabs>,
		);

		const first = screen.getByRole("tab", { name: "First" });
		const second = screen.getByRole("tab", { name: "Second" });
		expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe(
			"vertical",
		);
		act(() => first.focus());
		fireEvent.keyDown(first, { key: "ArrowDown" });
		await waitFor(() =>
			expect(second.getAttribute("aria-selected")).toBe("true"),
		);
		expect(document.activeElement).toBe(second);
		expect(screen.getByRole("tabpanel", { name: "Second" }).textContent).toBe(
			"Second view",
		);
	});
});
