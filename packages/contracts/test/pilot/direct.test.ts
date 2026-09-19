import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
	DirectActionRequestV1Schema,
	DirectActionResultV1Schema,
	DirectCatalogResponseV1Schema,
	DirectGrantListResponseV1Schema,
	DirectGrantProjectionV1Schema,
	DirectPayloadMaximumByteLengthV1,
	DirectPayloadMaximumCollectionSizeV1,
	DirectPayloadMaximumDepthV1,
	DirectPayloadMaximumNodeCountV1,
	DirectPayloadMaximumStringLengthV1,
	DirectPayloadMaximumTraversalDepthV1,
	pilotDirectOpenApiPathsV1,
	validateDirectActionResultV1,
	validateDirectActionResultWithPublishedSchemaV1,
	validateDirectCatalogWithPublishedSchemaV1,
	validateDirectGrantListWithPublishedSchemaV1,
	validateDirectPayloadBudgetV1,
} from "../../src/pilot/direct.js";

const request = {
	schemaVersion: 1,
	requestId: "request-direct-1",
	idempotencyKey: "direct.call_1",
	action: {
		actionId: "github.create_pull_request",
		actionVersion: "v1",
		arguments: {
			repositoryId: 123,
			head: "feature",
			base: "main",
		},
	},
	traceId: "trace-direct-1",
} as const;

const resultBase = {
	schemaVersion: 1,
	requestId: request.requestId,
	idempotencyKey: request.idempotencyKey,
	traceId: request.traceId,
	actionId: request.action.actionId,
	actionVersion: request.action.actionVersion,
	callId: "call-direct-1",
} as const;

function nestedArray(depth: number) {
	let value: unknown = "leaf";
	for (let index = 0; index < depth; index += 1) value = [value];
	return value;
}

describe("Pilot Direct MCP/API contracts", () => {
	it("accepts a catalog without authorization or credential state", () => {
		const catalog = {
			schemaVersion: 1,
			catalogVersion: "github-pilot-2026-09-19",
			actions: [
				{
					providerId: "github",
					actionId: "github.get_current_user",
					actionVersion: "v1",
					inputSchema: { type: "object", properties: {} },
					outputSchema: {
						type: "object",
						properties: { id: { type: "string" } },
					},
					effect: "READ",
					requiredScopes: ["read:user"],
					status: "published",
				},
			],
		};

		expect(DirectCatalogResponseV1Schema.parse(catalog)).toEqual(catalog);
		for (const field of [
			"principalId",
			"connectionId",
			"grantId",
			"credential",
		]) {
			expect(
				DirectCatalogResponseV1Schema.safeParse({
					...catalog,
					actions: [{ ...catalog.actions[0], [field]: "caller-selected" }],
				}).success,
			).toBe(false);
		}
		for (const invalidValue of [
			undefined,
			() => "not-json",
			Symbol("not-json"),
			1n,
		]) {
			expect(
				DirectCatalogResponseV1Schema.safeParse({
					...catalog,
					actions: [
						{
							...catalog.actions[0],
							inputSchema: { invalidValue },
						},
					],
				}).success,
			).toBe(false);
		}
		expect(
			DirectCatalogResponseV1Schema.safeParse({
				...catalog,
				actions: [
					{
						...catalog.actions[0],
						inputSchema: {
							nested: nestedArray(DirectPayloadMaximumTraversalDepthV1 + 1),
						},
					},
				],
			}).success,
		).toBe(false);
		expect(
			DirectCatalogResponseV1Schema.safeParse({
				...catalog,
				actions: [
					{
						...catalog.actions[0],
						inputSchema: { type: "not-a-json-schema-type" },
					},
				],
			}).success,
		).toBe(false);
		expect(
			DirectCatalogResponseV1Schema.safeParse({
				...catalog,
				actions: [
					{
						...catalog.actions[0],
						inputSchema: { $schema: "https://example.invalid/schema" },
					},
				],
			}).success,
		).toBe(false);
		expect(
			DirectCatalogResponseV1Schema.safeParse({
				...catalog,
				actions: Array.from(
					{ length: DirectPayloadMaximumCollectionSizeV1 + 1 },
					() => catalog.actions[0],
				),
			}).success,
		).toBe(false);
		expect(
			DirectCatalogResponseV1Schema.safeParse({
				...catalog,
				actions: [
					{
						...catalog.actions[0],
						requiredScopes: Array.from(
							{ length: DirectPayloadMaximumCollectionSizeV1 + 1 },
							(_, index) => `scope-${index}`,
						),
					},
				],
			}).success,
		).toBe(false);
		expect(validateDirectPayloadBudgetV1(catalog)).toBe(true);
		for (const invalidJson of [
			undefined,
			() => "invalid",
			Symbol("invalid"),
			1n,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(validateDirectPayloadBudgetV1(invalidJson)).toBe(false);
		}
		expect(
			validateDirectPayloadBudgetV1(
				nestedArray(DirectPayloadMaximumTraversalDepthV1 + 1),
			),
		).toBe(false);
		expect(
			validateDirectCatalogWithPublishedSchemaV1(catalog, () => true),
		).toBe(true);
		expect(
			validateDirectPayloadBudgetV1({
				...catalog,
				actions: Array.from(
					{ length: DirectPayloadMaximumCollectionSizeV1 + 1 },
					() => catalog.actions[0],
				),
			}),
		).toBe(false);
	});

	it("rejects caller-selected authority and credential selectors", () => {
		for (const field of [
			"principalId",
			"consumerId",
			"consumerInstanceId",
			"actorId",
			"connectionId",
			"grantId",
			"credentialSelector",
			"accessToken",
			"userId",
			"user_id",
			"tenantId",
			"principal",
			"identityId",
			"accountId",
			"caller",
			"context",
			"organization",
			"agent",
			"conversation",
			"targetConnectionId",
			"targetConnection",
			"connectionRef",
			"principalKey",
			"selectedPrincipalId",
			"credentialValue",
			"connection.id",
			"principal/id",
			"grant id",
			"usernameConnectionId",
		]) {
			expect(
				DirectActionRequestV1Schema.safeParse({
					...request,
					action: {
						...request.action,
						arguments: { ...request.action.arguments, [field]: "forged" },
					},
				}).success,
			).toBe(false);
		}
		for (const argumentsInput of [
			{ bearer: "credential" },
			{ oauthCode: "credential" },
			{ target: "caller-selected-connection" },
			{ note: "token=embedded-secret" },
			{ value: "sk-abcdefghijklmnopqrstuvwxyz" },
			{ auth: "mF_9B5f4JqM.abc123def456.ghi789jkl012" },
			{ value: "mF_9B5f4JqM.abc123def456.ghi789jkl012" },
			{ key: "AKIAIOSFODNN7EXAMPLE" },
			{ value: "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II" },
			{ value: "glpat-0123456789012345678901234567890123456789" },
			{ authHeader: "Bearer credential" },
			{ auth_header: "opaque-api-credential" },
			{ authValue: "credential" },
			{ authCode: "authorization-code" },
			{ basicAuth: "credential" },
		]) {
			expect(
				DirectActionRequestV1Schema.safeParse({
					...request,
					action: { ...request.action, arguments: argumentsInput },
				}).success,
			).toBe(false);
		}
		expect(
			DirectActionRequestV1Schema.safeParse({
				...request,
				action: {
					...request.action,
					arguments: { nested: nestedArray(DirectPayloadMaximumDepthV1) },
				},
			}).success,
		).toBe(true);
		expect(
			DirectActionRequestV1Schema.safeParse({
				...request,
				action: {
					...request.action,
					arguments: {
						nested: nestedArray(DirectPayloadMaximumDepthV1 + 1),
					},
				},
			}).success,
		).toBe(false);
		expect(
			DirectActionRequestV1Schema.safeParse({
				...request,
				action: {
					...request.action,
					arguments: {
						target: "main",
						description: "ordinary provider input",
						username: "provider-user",
						organizationName: "provider-org",
						resourcePath: "src/main.ts",
						assigneeUserId: "provider-user-id",
						repositoryOwner: "provider-owner",
						resourceType: "repository",
						accountValue: "provider-account",
						connectionName: "provider-connection",
						principalName: "provider-principal",
					},
				},
			}).success,
		).toBe(true);
		expect(
			DirectActionRequestV1Schema.safeParse({
				...request,
				action: {
					...request.action,
					arguments: {
						long: "x".repeat(DirectPayloadMaximumStringLengthV1 + 1),
					},
				},
			}).success,
		).toBe(false);
		expect(
			DirectActionRequestV1Schema.safeParse({
				...request,
				action: {
					...request.action,
					arguments: {
						items: Array.from(
							{ length: DirectPayloadMaximumCollectionSizeV1 + 1 },
							() => "item",
						),
					},
				},
			}).success,
		).toBe(false);
		const tooManyProperties = Object.fromEntries(
			Array.from(
				{ length: DirectPayloadMaximumCollectionSizeV1 + 1 },
				(_, index) => [`key${index}`, index],
			),
		);
		expect(
			DirectActionRequestV1Schema.safeParse({
				...request,
				action: { ...request.action, arguments: tooManyProperties },
			}).success,
		).toBe(false);
		expect(
			DirectActionRequestV1Schema.safeParse({
				...request,
				action: {
					...request.action,
					arguments: Object.fromEntries(
						Array.from({ length: 11 }, (_, group) => [
							`group${group}`,
							Object.fromEntries(
								Array.from({ length: 1_000 }, (_, index) => [
									`key${index}`,
									true,
								]),
							),
						]),
					),
				},
			}).success,
		).toBe(false);
		expect(
			DirectActionRequestV1Schema.safeParse({
				...request,
				action: {
					...request.action,
					arguments: Object.fromEntries(
						Array.from({ length: 20 }, (_, index) => [
							`value${index}`,
							"x".repeat(DirectPayloadMaximumByteLengthV1 / 20),
						]),
					),
				},
			}).success,
		).toBe(false);
		expect(
			DirectActionRequestV1Schema.safeParse({
				...request,
				traceId: "x".repeat(DirectPayloadMaximumByteLengthV1),
			}).success,
		).toBe(false);
		expect(DirectPayloadMaximumNodeCountV1).toBeGreaterThan(
			DirectPayloadMaximumCollectionSizeV1,
		);
	});

	it("rejects non-JSON object instances at the payload boundary", () => {
		class CustomPayload {
			value = "custom";
		}
		const invalidObjects: unknown[] = [
			new Date("2026-09-19T00:00:00Z"),
			new Map([["value", "map"]]),
			new Set(["set"]),
			new CustomPayload(),
		];

		for (const invalidObject of invalidObjects) {
			expect(validateDirectPayloadBudgetV1(invalidObject)).toBe(false);
			expect(
				DirectActionRequestV1Schema.safeParse({
					...request,
					action: {
						...request.action,
						arguments: { payload: invalidObject },
					},
				}).success,
			).toBe(false);
		}
	});

	it("correlates successful and unresolved results without exposing secrets", () => {
		const success = {
			...resultBase,
			status: "succeeded",
			completedAt: "2026-09-19T10:00:01Z",
			output: {
				pullRequestId: 123,
				url: "https://github.com/example/repo/pull/1",
			},
		};
		const validated = validateDirectActionResultV1(request, success, {
			validateOutput: (input: unknown) =>
				z
					.strictObject({
						pullRequestId: z.number().int(),
						url: z.string().url(),
					})
					.safeParse(input).success,
		});
		expect(validated).toEqual(success);
		expect(
			DirectActionResultV1Schema.safeParse({
				...success,
				output: { connectionId: "must-not-cross" },
			}).success,
		).toBe(false);
		for (const field of [
			"userId",
			"user_id",
			"tenantId",
			"accountId",
			"ownerId",
			"subjectId",
			"userRef",
			"accountSelector",
		]) {
			expect(
				DirectActionResultV1Schema.safeParse({
					...success,
					output: { [field]: "caller-selected" },
				}).success,
			).toBe(false);
		}
		expect(
			DirectActionResultV1Schema.safeParse({
				...success,
				output: { description: "line one\nline two" },
			}).success,
		).toBe(true);
		expect(
			DirectActionResultV1Schema.safeParse({
				...success,
				output: {
					user: "provider-user",
					account: "provider-account",
					owner: "provider-owner",
					resource: "provider-resource",
				},
			}).success,
		).toBe(true);
		expect(
			validateDirectActionResultWithPublishedSchemaV1(
				success,
				() => true,
				() => true,
			),
		).toBe(true);
		expect(
			validateDirectActionResultWithPublishedSchemaV1(
				success,
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			validateDirectActionResultWithPublishedSchemaV1(
				{
					...resultBase,
					status: "failed",
					updatedAt: "2026-09-19T10:00:02Z",
					error: {
						schemaVersion: 1,
						traceId: "trace-other",
						code: "PROVIDER_FAILED",
						message: "Provider rejected the action",
						retryable: false,
					},
				},
				() => true,
				() => true,
			),
		).toBe(false);
		expect(
			DirectActionResultV1Schema.safeParse({
				...success,
				traceId: "x".repeat(DirectPayloadMaximumByteLengthV1),
			}).success,
		).toBe(false);
		expect(() =>
			validateDirectActionResultV1(
				request,
				{
					...success,
					traceId: "x".repeat(DirectPayloadMaximumByteLengthV1),
				},
				{ validateOutput: () => true },
			),
		).toThrow("payload budget");
		expect(
			DirectActionResultV1Schema.safeParse({
				...success,
				output: { secretAccessKey: "must-not-cross" },
			}).success,
		).toBe(false);
		expect(
			DirectActionResultV1Schema.safeParse({
				...success,
				output: { value: "ghp_abcdefghijklmnopqrstuvwxyz" },
			}).success,
		).toBe(false);

		const unresolved = {
			...resultBase,
			status: "pending",
			updatedAt: "2026-09-19T10:00:02Z",
			error: {
				schemaVersion: 1,
				code: "RESULT_PENDING",
				message: "Provider result requires reconciliation",
				retryable: false,
				traceId: request.traceId,
			},
		};
		expect(
			validateDirectActionResultV1(request, unresolved, {
				validateOutput: () => true,
			}),
		).toEqual(unresolved);
		expect(() =>
			validateDirectActionResultV1(
				request,
				{
					...unresolved,
					error: {
						...unresolved.error,
						code: "PROVIDER_FAILED",
						message: "Provider rejected the action",
					},
				},
				{ validateOutput: () => true },
			),
		).toThrow();
		expect(
			DirectActionResultV1Schema.safeParse({
				...unresolved,
				error: {
					...unresolved.error,
					code: "PROVIDER_FAILED",
					message: "Provider rejected the action",
				},
			}).success,
		).toBe(false);
	});

	it("keeps grant action authorization unambiguous", () => {
		const grant = {
			grantId: "grant-1",
			consumerId: "consumer-1",
			consumerInstanceId: "instance-1",
			actorId: null,
			connectionId: "connection-1",
			actions: [{ actionId: "github.issue.read", actionVersion: "v1" }],
			status: "active",
		};
		expect(DirectGrantProjectionV1Schema.safeParse(grant).success).toBe(true);
		expect(
			DirectGrantProjectionV1Schema.safeParse({
				...grant,
				actionVersions: ["v1"],
			}).success,
		).toBe(false);
		expect(
			DirectGrantProjectionV1Schema.safeParse({
				...grant,
				actions: Array.from(
					{ length: DirectPayloadMaximumCollectionSizeV1 + 1 },
					() => grant.actions[0],
				),
			}).success,
		).toBe(false);
		expect(
			DirectGrantProjectionV1Schema.safeParse({
				...grant,
				grantId: "g".repeat(DirectPayloadMaximumStringLengthV1 + 1),
			}).success,
		).toBe(false);
		const grantList = { schemaVersion: 1, grants: [grant] };
		expect(DirectGrantListResponseV1Schema.safeParse(grantList).success).toBe(
			true,
		);
		expect(
			validateDirectGrantListWithPublishedSchemaV1(grantList, () => true),
		).toBe(true);
		expect(
			DirectGrantListResponseV1Schema.safeParse({
				schemaVersion: 1,
				grants: Array.from(
					{ length: DirectPayloadMaximumCollectionSizeV1 + 1 },
					() => grant,
				),
			}).success,
		).toBe(false);
	});

	it("publishes the catalog, browser grant and Direct Action API paths", () => {
		expect(Object.keys(pilotDirectOpenApiPathsV1).sort()).toEqual([
			"/api/v1/actions",
			"/api/v1/catalog",
			"/api/v1/grants",
			"/api/v1/grants/{grantId}/revoke",
		]);
		expect(pilotDirectOpenApiPathsV1["/api/v1/actions"].post?.operationId).toBe(
			"executeConnectionAction",
		);
		const revokeResponses =
			pilotDirectOpenApiPathsV1["/api/v1/grants/{grantId}/revoke"].post
				?.responses;
		expect(revokeResponses).not.toHaveProperty("403");
		expect(revokeResponses?.["404"]).toMatchObject({
			description: expect.stringContaining("authenticated Principal"),
		});
	});
});
