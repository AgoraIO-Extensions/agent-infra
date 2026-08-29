import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDocument } from "zod-openapi";

import {
	pilotBrowserOpenApiPathsV1,
	pilotBrowserSchemasV1,
	pilotDelegatedOpenApiPathsV1,
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

	it("generates JSON Schema 2020-12 for SSE and delegated contracts", () => {
		const schemas = generateJsonSchema(pilotSseSchemasV1);
		const delegated = generateJsonSchema(pilotDelegatedSchemasV1);

		expect(schemas.ConversationSseMessageV1).toHaveProperty(
			"$schema",
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(schemas.HeartbeatSignalV1).toHaveProperty(
			"properties.type.const",
			"heartbeat",
		);
		expect(delegated.ExecutionGrantClaimsV1).toHaveProperty(
			"properties.sessionGeneration",
		);

		const ajv = new Ajv2020({ strict: true });
		ajv.addFormat("date-time", true);
		const delegatedResultSchema = delegated.DelegatedActionResultV1;
		if (!delegatedResultSchema)
			throw new Error("Delegated result schema missing");
		const validateDelegatedResult = ajv.compile(delegatedResultSchema);
		const result = {
			schemaVersion: 1,
			requestId: "request-1",
			idempotencyKey: "idempotency-1",
			traceId: "trace-1",
			callId: "call-1",
			status: "succeeded",
			actionId: "github.issues.read",
			actionVersion: "v3",
			completedAt: "2026-08-28T10:00:01Z",
			output: { accepted: true },
		};
		expect(validateDelegatedResult(result)).toBe(true);
		expect(
			validateDelegatedResult({ ...result, idempotencyKey: undefined }),
		).toBe(false);
		for (const key of ["token", "tokenResponse", "jwt", "secretAccessKey"]) {
			expect(
				validateDelegatedResult({
					...result,
					output: { nested: { [key]: "blocked" } },
				}),
			).toBe(false);
		}
		const delegatedRequestSchema = delegated.DelegatedActionRequestV1;
		if (!delegatedRequestSchema)
			throw new Error("Delegated request schema missing");
		const validateDelegatedRequest = ajv.compile(delegatedRequestSchema);
		const request = {
			schemaVersion: 1,
			requestId: "request-1",
			idempotencyKey: "idempotency-1",
			grant: {
				schemaVersion: 1,
				format: "compact-jws",
				token: "header.payload.signature",
			},
			action: {
				actionId: "github.issues.read",
				actionVersion: "v3",
				arguments: { userId: "provider-domain-user" },
			},
			traceId: "trace-1",
		};
		expect(validateDelegatedRequest(request)).toBe(true);
		for (const key of ["connectionId", "connectionIds", "attachmentIds"]) {
			expect(
				validateDelegatedRequest({
					...request,
					action: {
						...request.action,
						arguments: { nested: { [key]: "caller-controlled" } },
					},
				}),
			).toBe(false);
		}
	});

	it("generates the delegated internal HTTP contract as OpenAPI 3.1", () => {
		const document = createDocument({
			openapi: "3.1.0",
			info: {
				title: "Agent Infra Pilot Delegated Action API",
				version: "1.0.0",
			},
			paths: pilotDelegatedOpenApiPathsV1,
			components: { schemas: pilotDelegatedSchemasV1 },
		});

		expect(document.openapi).toBe("3.1.0");
		expect(document.paths).toHaveProperty(
			"/internal/v1/delegated-actions.post.operationId",
			"executeDelegatedAction",
		);
		expect(document.paths).toHaveProperty(
			"/internal/v1/delegated-actions.post.requestBody.content.application/json",
		);
		expect(document.paths).toHaveProperty(
			"/internal/v1/delegated-actions.post.responses.200",
		);
	});
});
