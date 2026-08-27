import { describe, expect, it } from "vitest";

import { connectionBrowserOpenApi } from "./index";

describe("Connection Browser OpenAPI", () => {
	it("keeps the versioned browser surface free of caller identity selectors", () => {
		expect(connectionBrowserOpenApi.openapi).toBe("3.1.0");
		const serialized = JSON.stringify(connectionBrowserOpenApi);
		for (const forbidden of ['"actorPrincipalId"', '"credential"']) {
			expect(serialized).not.toContain(forbidden);
		}
		// One schema property plus the same field in that schema's required list.
		expect(serialized.match(/"accessToken"/g)).toHaveLength(2);
		expect(
			connectionBrowserOpenApi.components.schemas.ProviderCredentialRequest,
		).toEqual({
			additionalProperties: false,
			properties: {
				accessToken: { maxLength: 8192, minLength: 1, type: "string" },
				providerId: { enum: ["bitbucket"], type: "string" },
			},
			required: ["providerId", "accessToken"],
			type: "object",
		});
	});
});
