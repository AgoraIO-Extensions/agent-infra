import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { Route } from "../routes/chat.index";

describe("chat entry without an Agent", () => {
	it("redirects /chat to the conversation picker (#2297)", () => {
		let thrown: unknown;
		try {
			(Route.options.beforeLoad as () => void)();
		} catch (error) {
			thrown = error;
		}
		expect(isRedirect(thrown)).toBe(true);
		expect((thrown as { options: unknown }).options).toMatchObject({
			to: "/agents",
			search: { mode: "conversation" },
			replace: true,
		});
	});
});
