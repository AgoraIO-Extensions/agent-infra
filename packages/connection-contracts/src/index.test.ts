import { describe, expect, it } from "vitest";

import { connectionBrowserOpenApi } from "./index";

describe("Connection Browser OpenAPI", () => {
	it("keeps the versioned browser surface free of caller identity selectors", () => {
		expect(connectionBrowserOpenApi.openapi).toBe("3.1.0");
		const serialized = JSON.stringify(connectionBrowserOpenApi);
		for (const forbidden of [
			'"actorPrincipalId"',
			'"credential"',
			'"accessToken"',
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});
});
