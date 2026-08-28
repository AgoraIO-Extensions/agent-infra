import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));

describe("contracts package surface", () => {
	it("publishes standard artifacts without publishing test-only clients", async () => {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

		expect(manifest.exports["./openapi/common.v1"]).toBe(
			"./artifacts/openapi/common.v1.openapi.json",
		);
		expect(manifest.exports["./json-schema/common.v1"]).toBe(
			"./artifacts/json-schema/common.v1.schema.json",
		);
		expect(manifest.files).toEqual(["dist", "artifacts"]);
		expect(JSON.stringify(manifest.exports)).not.toContain("test");
	});
});
