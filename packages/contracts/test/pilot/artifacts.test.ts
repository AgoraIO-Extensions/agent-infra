import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDocument } from "zod-openapi";

import {
	pilotBrowserOpenApiPathsV1,
	pilotBrowserSchemasV1,
	pilotDelegatedSchemasV1,
	pilotSseSchemasV1,
} from "../../src/pilot/index.js";

function generateJsonSchema(schemas: Record<string, z.ZodType>) {
	return Object.fromEntries(
		Object.entries(schemas).map(([name, schema]) => [
			name,
			z.toJSONSchema(schema, {
				target: "draft-2020-12",
				unrepresentable: "throw",
			}),
		]),
	);
}

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
			"/api/v1/conversations/{conversationId}/events",
		);
		expect(Object.keys(document.components?.schemas ?? {}).sort()).toEqual(
			Object.keys(pilotBrowserSchemasV1).sort(),
		);
	});

	it("generates JSON Schema 2020-12 for SSE and delegated contracts", () => {
		const sse = generateJsonSchema(pilotSseSchemasV1);
		const delegated = generateJsonSchema(pilotDelegatedSchemasV1);

		expect(sse.ConversationSseMessageV1).toHaveProperty(
			"$schema",
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(delegated.ExecutionGrantClaimsV1).toHaveProperty(
			"properties.actionSetVersion",
		);

		const ajv = new Ajv2020({ strict: true });
		ajv.addFormat("date-time", true);
		const delegatedResultSchema = delegated.DelegatedActionResultV1;
		if (!delegatedResultSchema)
			throw new Error("Delegated result schema missing");
		const validateDelegatedResult = ajv.compile(delegatedResultSchema);
		for (const key of [
			"token",
			"Authorization",
			"cookie",
			"access_token_value",
			"privateKey",
			"apiKey",
			"secret",
			"credential",
			"password",
		]) {
			expect(
				validateDelegatedResult({
					schemaVersion: 1,
					requestId: "request-1",
					traceId: "trace-1",
					callId: "call-1",
					status: "succeeded",
					actionId: "github.issues.read",
					actionVersion: "v3",
					completedAt: "2026-08-28T10:00:01Z",
					output: { levelOne: { levelTwo: { [key]: "blocked" } } },
				}),
			).toBe(false);
		}
	});
});
