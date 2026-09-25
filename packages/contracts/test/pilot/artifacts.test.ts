import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDocument } from "zod-openapi";

import {
	DirectPayloadMaximumByteLengthV1,
	DirectPayloadMaximumTraversalDepthV1,
	pilotBrowserOpenApiPathsV1,
	pilotBrowserOpenApiPathsV2,
	pilotBrowserSchemasV1,
	pilotBrowserSchemasV2,
	pilotDelegatedOpenApiPathsV1,
	pilotDelegatedSchemasV1,
	pilotDirectOpenApiPathsV1,
	pilotDirectSchemasV1,
	pilotSseSchemasV1,
	validateDirectActionRequestWithPublishedSchemaV1,
	validateDirectCatalogWithPublishedSchemaV1,
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

	it("generates Action-free V2 lifecycle and audit while retaining V1 conversations", () => {
		const document = createDocument({
			openapi: "3.1.0",
			info: {
				title: "Agent Infra Pilot Browser Audit API",
				version: "2.0.0",
			},
			paths: pilotBrowserOpenApiPathsV2,
			components: { schemas: pilotBrowserSchemasV2 },
		});

		expect(document.paths?.["/api/v2/agent-applications"]?.post).toMatchObject({
			operationId: "createAgentApplicationV2",
		});
		expect(
			document.paths?.["/api/v2/agents/{agentId}/configuration"]?.put,
		).toMatchObject({
			operationId: "updateAgentConfigurationV2",
		});
		expect(
			Object.keys(document.paths ?? {}).every((path) =>
				path.startsWith("/api/v2/"),
			),
		).toBe(true);
		expect(
			Object.keys(document.paths ?? {}).some((path) =>
				/conversations|session/.test(path),
			),
		).toBe(false);
		expect(pilotBrowserOpenApiPathsV1).toHaveProperty(
			"/api/v1/conversations/{conversationId}/messages",
		);
		for (const name of [
			"AgentApplicationCreateRequestV2",
			"AgentConfigurationUpdateRequestV2",
		]) {
			const schema = document.components?.schemas?.[name];
			expect(schema).toHaveProperty(
				"properties.modelConfiguration.properties.options.items.properties.credentialValue.writeOnly",
				true,
			);
			expect(schema).toHaveProperty(
				"properties.secrets.items.properties.value.writeOnly",
				true,
			);
			expect(JSON.stringify(schema)).not.toMatch(
				/actionCatalog|actionSelection|allowedActions/,
			);
		}
		expect(document.paths?.["/api/v2/admin/audit"]?.get).toMatchObject({
			operationId: "listPlatformAuditV2",
		});
		expect(Object.keys(document.components?.schemas ?? {}).sort()).toEqual(
			Object.keys(pilotBrowserSchemasV2).sort(),
		);
	});

	it("generates JSON Schema 2020-12 for SSE and pilot contracts", () => {
		const schemas = generateJsonSchema(pilotSseSchemasV1);
		const delegated = generateJsonSchema(pilotDelegatedSchemasV1);
		const direct = generateJsonSchema(pilotDirectSchemasV1);

		expect(schemas.ConversationSseMessageV1).toHaveProperty(
			"$schema",
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(schemas.HeartbeatSignalV1).toHaveProperty(
			"properties.type.const",
			"heartbeat",
		);
		expect(schemas.ModelSelectionFallbackEventV1).toHaveProperty(
			"properties.type.const",
			"model.selection.fell_back",
		);
		expect(schemas.ModelSelectionFallbackEventV1).toHaveProperty(
			"properties.payload.properties.reason.const",
			"selection_unavailable",
		);
		expect(schemas.ModelSelectionFallbackEventV1).toHaveProperty(
			"properties.payload.additionalProperties",
			false,
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
		const { output: _output, ...failedResultBase } = result;
		const failedResult = {
			...failedResultBase,
			callId: null,
			status: "failed",
			error: {
				schemaVersion: 1,
				code: "CONNECTION_UNAVAILABLE",
				message: "Connection is unavailable",
				retryable: true,
				traceId: result.traceId,
			},
		};
		expect(validateDelegatedResult(failedResult)).toBe(true);
		expect(
			validateDelegatedResult({
				...failedResult,
				error: {
					...failedResult.error,
					message: "Provider returned bearer token secret-value",
				},
			}),
		).toBe(false);
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
		for (const key of [
			"connectionId",
			"connectionIds",
			"platformUserId",
			"attachmentIds",
			"hostSessionId",
			"nativeSessionRef",
			"attachmentRef",
		]) {
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

		const directActionSchema = direct.DirectActionRequestV1;
		if (!directActionSchema) throw new Error("Direct request schema missing");
		const validateDirectRequest = ajv.compile(directActionSchema);
		const directRequest = {
			schemaVersion: 1,
			requestId: "request-direct-1",
			idempotencyKey: "direct.call_1",
			action: {
				providerId: "github",
				actionId: "github.get_current_user",
				actionVersion: "v1",
				arguments: {},
			},
			traceId: "trace-direct-1",
		};
		expect(validateDirectRequest(directRequest)).toBe(true);
		expect(
			validateDirectRequest({
				...directRequest,
				action: {
					...directRequest.action,
					arguments: { connectionId: "caller-selected" },
				},
			}),
		).toBe(false);
		expect(
			validateDirectRequest({
				...directRequest,
				action: {
					...directRequest.action,
					arguments: { targetConnectionId: "caller-selected" },
				},
			}),
		).toBe(false);
		expect(
			validateDirectRequest({
				...directRequest,
				action: {
					...directRequest.action,
					arguments: { selectedPrincipalId: "caller-selected" },
				},
			}),
		).toBe(false);
		expect(
			validateDirectRequest({
				...directRequest,
				action: {
					...directRequest.action,
					arguments: {
						username: "provider-user",
						organizationName: "provider-org",
						resourcePath: "src/main.ts",
						note: "line one\nline two",
					},
				},
			}),
		).toBe(true);
		expect(
			validateDirectRequest({
				...directRequest,
				action: {
					...directRequest.action,
					arguments: { ConnectionID: "caller-selected" },
				},
			}),
		).toBe(false);
		expect(
			validateDirectRequest({
				...directRequest,
				action: {
					...directRequest.action,
					arguments: { auth: "mF_9B5f4JqM.abc123def456.ghi789jkl012" },
				},
			}),
		).toBe(false);
		expect(
			validateDirectRequest({
				...directRequest,
				action: {
					...directRequest.action,
					arguments: { value: "mF_9B5f4JqM.abc123def456.ghi789jkl012" },
				},
			}),
		).toBe(false);
		expect(
			validateDirectRequest({
				...directRequest,
				action: {
					...directRequest.action,
					arguments: { note: "token=embedded-secret" },
				},
			}),
		).toBe(false);
		expect(
			validateDirectRequest({
				...directRequest,
				action: {
					...directRequest.action,
					arguments: { note: "TOKEN=embedded-secret" },
				},
			}),
		).toBe(false);
		const nodeHeavyArguments = Object.fromEntries(
			Array.from({ length: 11 }, (_, group) => [
				`group${group}`,
				Object.fromEntries(
					Array.from({ length: 1_000 }, (_, index) => [`key${index}`, true]),
				),
			]),
		);
		const nodeHeavyRequest = {
			...directRequest,
			action: { ...directRequest.action, arguments: nodeHeavyArguments },
		};
		// AJV enforces the published structural schema; the composed helper adds
		// the aggregate budget that JSON Schema cannot express recursively.
		expect(validateDirectRequest(nodeHeavyRequest)).toBe(true);
		expect(
			validateDirectActionRequestWithPublishedSchemaV1(
				nodeHeavyRequest,
				(input) => validateDirectRequest(input),
				() => true,
				() => true,
			),
		).toBe(false);
		expect(
			validateDirectActionRequestWithPublishedSchemaV1(
				directRequest,
				() => true,
				() => true,
				() => false,
			),
		).toBe(false);
		const oversizedMetadataRequest = {
			...directRequest,
			traceId: "x".repeat(DirectPayloadMaximumByteLengthV1),
		};
		let publishedValidatorCalled = false;
		expect(
			validateDirectActionRequestWithPublishedSchemaV1(
				oversizedMetadataRequest,
				(input) => {
					publishedValidatorCalled = true;
					return validateDirectRequest(input);
				},
				() => true,
				() => true,
			),
		).toBe(false);
		expect(publishedValidatorCalled).toBe(false);
		let bigintValidatorCalled = false;
		expect(
			validateDirectActionRequestWithPublishedSchemaV1(
				1n,
				() => {
					bigintValidatorCalled = true;
					return true;
				},
				() => true,
				() => true,
			),
		).toBe(false);
		expect(bigintValidatorCalled).toBe(false);
		const directGrantSchema = direct.DirectGrantProjectionV1;
		if (!directGrantSchema) throw new Error("Direct grant schema missing");
		const validateDirectGrant = ajv.compile(directGrantSchema);
		expect(
			validateDirectGrant({
				grantId: "grant-1",
				consumerId: "consumer-1",
				consumerInstanceId: "instance-1",
				actorId: null,
				connectionId: "connection-1",
				actions: [{ actionId: "github.issue.read", actionVersion: "v1" }],
				status: "active",
			}),
		).toBe(true);
		expect(
			validateDirectGrant({
				grantId: "grant-1",
				consumerId: "consumer-1",
				consumerInstanceId: "instance-1",
				actorId: null,
				connectionId: "connection-1",
				actionVersions: ["v1"],
				status: "active",
			}),
		).toBe(false);
		const directCatalogSchema = direct.DirectCatalogResponseV1;
		if (!directCatalogSchema) throw new Error("Direct catalog schema missing");
		const validateDirectCatalog = ajv.compile(directCatalogSchema);
		const directCatalog = {
			schemaVersion: 1,
			catalogVersion: "catalog-1",
			actions: [
				{
					providerId: "github",
					actionId: "github.issue.read",
					actionVersion: "v1",
					inputSchema: { type: "object", properties: {} },
					outputSchema: { type: "object", properties: {} },
					effect: "READ",
					requiredScopes: ["read:issues"],
					status: "published",
				},
			],
		};
		let tooDeepSchema: unknown = "too-deep";
		for (
			let depth = 0;
			depth <= DirectPayloadMaximumTraversalDepthV1;
			depth += 1
		) {
			tooDeepSchema = [tooDeepSchema];
		}
		expect(validateDirectCatalog(directCatalog)).toBe(true);
		expect(
			validateDirectCatalog({
				...directCatalog,
				actions: [directCatalog.actions[0], directCatalog.actions[0]],
			}),
		).toBe(false);
		expect(
			validateDirectCatalogWithPublishedSchemaV1(
				{
					...directCatalog,
					actions: [
						directCatalog.actions[0],
						{ ...directCatalog.actions[0], effect: "WRITE" },
					],
				},
				(input) => validateDirectCatalog(input),
			),
		).toBe(false);
		expect(
			validateDirectCatalog({
				...directCatalog,
				actions: [
					{
						...directCatalog.actions[0],
						inputSchema: { type: "not-a-json-schema-type" },
					},
				],
			}),
		).toBe(false);
		expect(
			validateDirectCatalog({
				...directCatalog,
				actions: [
					{
						...directCatalog.actions[0],
						inputSchema: { nested: tooDeepSchema },
					},
				],
			}),
		).toBe(true);
		expect(
			validateDirectCatalogWithPublishedSchemaV1(
				{
					...directCatalog,
					actions: [
						{
							...directCatalog.actions[0],
							inputSchema: { nested: tooDeepSchema },
						},
					],
				},
				(input) => validateDirectCatalog(input),
			),
		).toBe(false);
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

	it("generates the independent Direct MCP/API contract as OpenAPI 3.1", () => {
		const document = createDocument({
			openapi: "3.1.0",
			info: {
				title: "Agent Infra Pilot Direct MCP/API",
				version: "1.0.0",
			},
			security: [{ DirectDpop: [] }],
			paths: pilotDirectOpenApiPathsV1,
			components: {
				securitySchemes: {
					DirectDpop: { type: "http", scheme: "DPoP" },
				},
				schemas: pilotDirectSchemasV1,
			},
		});

		expect(document.openapi).toBe("3.1.0");
		expect(document.security).toEqual([{ DirectDpop: [] }]);
		expect(document.paths).toHaveProperty(
			"/api/v1/actions.post.operationId",
			"reserveConnectionAction",
		);
		expect(document.paths).toHaveProperty("/api/v1/actions.post.responses.202");
		expect(document.paths).toHaveProperty(
			"/api/v1/actions/{callId}.get.operationId",
			"getDirectActionReference",
		);
		expect(document.paths).toHaveProperty(
			"/api/v1/catalog.get.operationId",
			"listConnectionCatalog",
		);
		expect(document.paths).toHaveProperty(
			"/api/v1/catalog.get.parameters.0.name",
			"DPoP",
		);
		expect(document.paths).toHaveProperty(
			"/api/v1/catalog.get.responses.304.description",
			"Catalog unchanged after current authentication",
		);
		expect(document.components?.schemas).toHaveProperty("DirectActionResultV1");
	});
});
