import { describe, expect, it } from "vitest";
import { WecomApplicationCredentialsV1Schema } from "./wecom-application.ts";

const credentials = {
	state: "setup-state",
	corporationId: "corp",
	applicationId: "7",
	secret: "application-secret",
	token: "callback-token",
	encodingAesKey: "A".repeat(43),
};

describe("WeCom application credentials", () => {
	it("accepts separate application and callback credentials", () => {
		expect(WecomApplicationCredentialsV1Schema.parse(credentials)).toEqual(
			credentials,
		);
	});

	it.each([
		{ ...credentials, applicationId: "0" },
		{ ...credentials, encodingAesKey: "short" },
		{ ...credentials, unexpected: "field" },
	])("rejects invalid or unexpected credential fields", (input) => {
		expect(WecomApplicationCredentialsV1Schema.safeParse(input).success).toBe(
			false,
		);
	});
});
