import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMark, agentMarkGlyph, agentMarkTone } from "./agent-mark.js";

afterEach(cleanup);

describe("AgentMark", () => {
	it("renders the first glyph without an icon and hides it from assistive technology", () => {
		const { container } = render(
			<AgentMark name="release assistant" agentId="agent-pilot-1" />,
		);
		const mark = container.querySelector('[data-slot="agent-mark"]');
		expect(mark?.textContent).toBe("R");
		expect(mark?.getAttribute("aria-hidden")).toBe("true");
		expect(mark?.querySelector("svg")).toBeNull();
		expect(mark?.className).toContain("size-[42px]");
		expect(mark?.className).toContain("rounded-[12px]");
		expect(mark?.className).toContain("text-[19px]");
		expect(mark?.className).toContain("[font-family:var(--font-display)]");
	});

	it("uses the first character of Chinese names", () => {
		expect(agentMarkGlyph("编程助手")).toBe("编");
		expect(agentMarkGlyph("  knowledge")).toBe("K");
	});

	it("keeps the tone stable for an Agent and honours an explicit tone", () => {
		const tone = agentMarkTone("agent-pilot-1");
		expect(["fg", "blue", "soft"]).toContain(tone);
		expect(agentMarkTone("agent-pilot-1")).toBe(tone);
		const tones = new Set(
			Array.from({ length: 24 }, (_, index) => agentMarkTone(`agent-${index}`)),
		);
		expect(tones.size).toBe(3);
		const { container } = render(
			<AgentMark name="Knowledge" agentId="agent-pilot-1" tone="soft" />,
		);
		const mark = container.querySelector('[data-slot="agent-mark"]');
		expect(mark?.getAttribute("data-tone")).toBe("soft");
		expect(mark?.className).toContain("bg-(--accent-soft)");
	});
});
