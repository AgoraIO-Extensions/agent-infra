import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useRowRemovalFocus } from "./use-row-removal-focus.js";

afterEach(cleanup);

function Rows({ initial }: { initial: readonly string[] }) {
	const [rows, setRows] = useState(initial);
	const focusAfterRemoval = useRowRemovalFocus();
	return (
		<>
			{rows.map((row, index) => (
				<button
					// 与页面一样按序号复用行，id 也按序号给出。
					id={`row-remove-${index}`}
					key={index}
					onClick={() => {
						setRows((current) => current.filter((_, at) => at !== index));
						focusAfterRemoval(index, (at) => `row-remove-${at}`, "row-add");
					}}
					type="button"
				>
					移除 {row}
				</button>
			))}
			<button id="row-add" type="button">
				添加
			</button>
		</>
	);
}

describe("useRowRemovalFocus", () => {
	it("focuses the next row at the same position, then the previous row, then the add button", () => {
		render(<Rows initial={["甲", "乙", "丙"]} />);
		// 移除中间一行：同一位置现在是下一行「丙」。
		fireEvent.click(screen.getByRole("button", { name: "移除 乙" }));
		expect(document.activeElement?.textContent).toBe("移除 丙");
		// 移除最后一行：没有下一行，到上一行「甲」。
		fireEvent.click(screen.getByRole("button", { name: "移除 丙" }));
		expect(document.activeElement?.textContent).toBe("移除 甲");
		// 移除唯一一行：到「添加」。
		fireEvent.click(screen.getByRole("button", { name: "移除 甲" }));
		expect(document.activeElement?.id).toBe("row-add");
	});
});
