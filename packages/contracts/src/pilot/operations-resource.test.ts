import { expect, it } from "vitest";
import { OperationsLinkV2Schema } from "./operations-resource.js";

it("withholds credential-bearing links and permits diagnostic object filters", () => {
	for (const parameter of [
		"password",
		"credential",
		"cookie",
		"session",
		"jwt",
		"access_token",
		"apiKey",
	]) {
		expect(
			OperationsLinkV2Schema.safeParse({
				kind: "logs",
				url: `https://diagnostics.example.test/?${parameter}=synthetic`,
			}).success,
		).toBe(false);
	}
	const link = {
		kind: "traces",
		url: "https://diagnostics.example.test/?namespace=platform-test&agentId=agent-1&sessionId=session-1",
	};
	expect(OperationsLinkV2Schema.parse(link)).toEqual(link);
});
