import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
	DirectActionRequestV1Schema,
	DirectActionResultV1Schema,
	DirectCatalogResponseV1Schema,
	DirectPayloadMaximumByteLengthV1,
	DirectPayloadMaximumCollectionSizeV1,
	DirectPayloadMaximumDepthV1,
	DirectPayloadMaximumNodeCountV1,
	DirectPayloadMaximumStringLengthV1,
	pilotDirectOpenApiPathsV1,
	validateDirectActionResultV1,
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
		expect(DirectPayloadMaximumNodeCountV1).toBeGreaterThan(
			DirectPayloadMaximumCollectionSizeV1,
		);
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
					.parse(input),
		});
		expect(validated).toEqual(success);
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
				validateOutput: (input) => input,
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
				{ validateOutput: (input) => input },
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
	});
});
