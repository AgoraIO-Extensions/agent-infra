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

	it("publishes V4 event read and ACK wire contracts", async () => {
		const openapi = JSON.parse(
			await readFile(
				new URL(
					"../../artifacts/openapi/runtime-host.v4.openapi.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const jsonSchema = JSON.parse(
			await readFile(
				new URL(
					"../../artifacts/json-schema/runtime.v4.schema.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		for (const [path, request, response] of [
			[
				"events/read",
				"RuntimeEventReadRequestV4",
				"RuntimeEventReplayResponseV4",
			],
			["events/ack", "RuntimeEventAckRequestV4", "RuntimeEventAckResponseV4"],
		] as const) {
			const operation = openapi.paths[`/internal/runtime/v4/${path}`].post;
			expect(
				operation.requestBody.content["application/json"].schema.$ref,
			).toBe(`#/components/schemas/${request}`);
			expect(
				operation.responses["200"].content["application/json"].schema.$ref,
			).toBe(`#/components/schemas/${response}`);
			expect(openapi.components.schemas[request]).toBeDefined();
			expect(openapi.components.schemas[response]).toBeDefined();
			expect(jsonSchema.$defs[request]).toBeDefined();
			expect(jsonSchema.$defs[response]).toBeDefined();
		}
	});
});
