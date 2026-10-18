import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LoadingLine, Spinner } from "./spinner.js";

afterEach(cleanup);

describe("Spinner", () => {
	it("renders hidden md and sm spinners that stop under reduced motion", () => {
		const { container } = render(
			<>
				<Spinner />
				<Spinner size="sm" />
			</>,
		);
		const [md, sm] = Array.from(
			container.querySelectorAll('[data-slot="spinner"]'),
		);
		expect(md?.getAttribute("aria-hidden")).toBe("true");
		expect(md?.className).toContain("size-[15px]");
		expect(md?.className).toContain("border-t-(--accent-ink)");
		expect(md?.className).toContain("[animation-duration:0.8s]");
		expect(md?.className).toContain("motion-reduce:[animation-name:none]");
		expect(sm?.getAttribute("aria-hidden")).toBe("true");
		expect(sm?.className).toContain("size-[12px]");
		expect(sm?.className).toContain("border-[1.5px]");
		expect(sm?.className).toContain("border-t-foreground");
	});
});

describe("LoadingLine", () => {
	it("announces a status with a spinner", () => {
		render(<LoadingLine>正在读取申请…</LoadingLine>);
		const line = screen.getByRole("status");
		expect(line.textContent).toBe("正在读取申请…");
		expect(line.dataset.slot).toBe("loading-line");
		expect(line.querySelector('[data-slot="spinner"]')).not.toBeNull();
	});

	it("omits the role inside an existing live region", () => {
		const { container } = render(
			<LoadingLine announce={false}>正在加载 Agent…</LoadingLine>,
		);
		expect(screen.queryByRole("status")).toBeNull();
		const line = container.querySelector('[data-slot="loading-line"]');
		expect(line?.getAttribute("aria-live")).toBeNull();
	});
});
