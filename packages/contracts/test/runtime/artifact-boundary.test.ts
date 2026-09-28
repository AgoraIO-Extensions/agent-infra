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

	it("requires private Relay Key delivery on both V4 operations", async () => {
		const artifact = JSON.parse(
			await readFile(
				new URL(
					"../../artifacts/openapi/runtime-host.v4.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		for (const [path, schema] of [
			["turns", "RuntimeSubmitTurnTransportV4"],
			["instructions", "RuntimeSupplementTransportV4"],
		] as const) {
			expect(
				artifact.paths[`/internal/runtime/v4/${path}`].post.requestBody.content[
					"application/json"
				].schema.$ref,
			).toBe(`#/components/schemas/${schema}`);
			expect(artifact.components.schemas[schema].required).toEqual([
				"businessRequest",
				"privateKeyField",
			]);
		}
	});
});
