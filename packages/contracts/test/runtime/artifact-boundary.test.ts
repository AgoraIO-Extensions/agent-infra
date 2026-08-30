import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("RuntimeHost published artifact boundary", () => {
	it("keeps Driver-native identifiers and protocol details out of worker OpenAPI", async () => {
		const artifact = await readFile(
			new URL(
				"../../artifacts/openapi/runtime-host.v1.openapi.json",
				import.meta.url,
			),
			"utf8",
		);

		expect(artifact).not.toMatch(
			/nativeSession|vendor|stdio|rawProtocol|protocolEvent/i,
		);
	});
});
