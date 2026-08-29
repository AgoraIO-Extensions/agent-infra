import { describe, expect, it } from "vitest";

import { MessageCommandRequestV1Schema } from "../../src/pilot/index.js";

describe("Pilot consumer contract boundaries", () => {
	it("fails closed for unknown browser command versions", () => {
		expect(
			MessageCommandRequestV1Schema.safeParse({
				schemaVersion: 2,
				text: "hello",
			}).success,
		).toBe(false);
	});
});
