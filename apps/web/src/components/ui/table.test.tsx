import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./table.js";

function renderTable(mobileLayout?: "scroll" | "cards") {
	return render(
		<Table aria-label="审批" mobileLayout={mobileLayout}>
			<TableHeader>
				<TableRow>
					<TableHead>申请</TableHead>
					<TableHead>
						<span className="sr-only">操作</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				<TableRow>
					<TableCell data-label="申请">
						<strong>Release assistant</strong>
						<small>说明</small>
					</TableCell>
					<TableCell data-cell="actions">
						<button type="button">审阅申请</button>
					</TableCell>
				</TableRow>
			</TableBody>
		</Table>,
	);
}

afterEach(cleanup);

describe("Table", () => {
	it("wraps card-layout cell content in a value container next to its label", () => {
		renderTable("cards");

		const table = screen.getByRole("table", { name: "审批" });
		expect(
			table
				.closest('[data-slot="table-container"]')
				?.getAttribute("data-mobile-layout"),
		).toBe("cards");
		const cell = screen.getByRole("cell", { name: /Release assistant/ });
		expect(cell.getAttribute("data-label")).toBe("申请");
		const value = cell.querySelector('[data-slot="table-cell-value"]');
		expect(value?.textContent).toBe("Release assistant说明");
		const actions = screen
			.getByRole("button", { name: "审阅申请" })
			.closest('[data-slot="table-cell"]');
		expect(actions?.getAttribute("data-cell")).toBe("actions");
		expect(actions?.hasAttribute("data-label")).toBe(false);
	});

	it("keeps scroll-layout tables as plain cells", () => {
		renderTable();

		expect(
			screen
				.getByRole("table", { name: "审批" })
				.closest('[data-slot="table-container"]')
				?.getAttribute("data-mobile-layout"),
		).toBe("scroll");
		expect(document.querySelector('[data-slot="table-cell-value"]')).toBeNull();
	});
});
