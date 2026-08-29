import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDocument } from "zod-openapi";

import {
	pilotBrowserOpenApiPathsV1,
	pilotBrowserSchemasV1,
	pilotSseSchemasV1,
} from "../../src/pilot/index.js";

describe("Pilot standard artifacts", () => {
	it("generates browser OpenAPI 3.1 from the Zod-authored HTTP schemas", () => {
		const document = createDocument({
			openapi: "3.1.0",
			info: { title: "Agent Infra Pilot Browser API", version: "1.0.0" },
			paths: pilotBrowserOpenApiPathsV1,
			components: { schemas: pilotBrowserSchemasV1 },
		});

		expect(document.openapi).toBe("3.1.0");
		expect(document.paths).toHaveProperty(
			"/api/v1/conversations/{conversationId}/messages",
		);
		expect(document.paths).not.toHaveProperty(
			"/api/v1/conversations/{conversationId}/events",
		);
		expect(Object.keys(document.components?.schemas ?? {}).sort()).toEqual(
			Object.keys(pilotBrowserSchemasV1).sort(),
		);
		expect(
			document.components?.schemas?.AgentApplicationCreateRequestV1,
		).toHaveProperty(
			"properties.modelConfiguration.properties.options.items.properties.credentialValue.writeOnly",
			true,
		);
		expect(
			document.components?.schemas?.AgentApplicationCreateRequestV1,
		).toHaveProperty(
			"properties.secrets.items.properties.value.writeOnly",
			true,
		);
	});

	it("generates JSON Schema 2020-12 for SSE messages", () => {
		const schemas = Object.fromEntries(
			Object.entries(pilotSseSchemasV1).map(([name, schema]) => [
				name,
				z.toJSONSchema(schema, {
					target: "draft-2020-12",
					unrepresentable: "throw",
				}),
			]),
		);

		expect(schemas.ConversationSseMessageV1).toHaveProperty(
			"$schema",
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(schemas.HeartbeatSignalV1).toHaveProperty(
			"properties.type.const",
			"heartbeat",
		);
	});
});
