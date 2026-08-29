import { describe, expect, it } from "vitest";

import {
	DelegatedActionRequestV1Schema,
	DelegatedActionResultV1Schema,
	ExecutionGrantClaimsV1Schema,
	ExecutionGrantV1Schema,
	validateDelegatedActionRequestV1,
	validateExecutionGrantClaimsV1,
} from "../../src/pilot/delegated.js";

const validClaims = {
	schemaVersion: 1,
	issuer: "agent-platform",
	audience: ["platform_tool_gateway", "connection_api"],
	issuedAt: "2026-08-28T10:00:00Z",
	expiresAt: "2026-08-28T10:05:00Z",
	grantId: "grant-1",
	agentId: "agent-1",
	actorId: "user-1",
	channelId: "web",
	conversationId: "conversation-1",
	turnId: "turn-1",
	executionId: "execution-1",
	allowedCommands: ["tool.invoke"],
	attachments: [{ attachmentId: "attachment-1", operations: ["read"] }],
	actionSetVersion: "actions-v7",
	actionIds: ["github.issues.read"],
	traceId: "trace-1",
} as const;

const validRequest = {
	schemaVersion: 1,
	requestId: "request-1",
	idempotencyKey: "tool.call_1",
	grant: {
		schemaVersion: 1,
		format: "compact-jws",
		token: "header.payload.signature",
	},
	action: {
		actionId: "github.issues.read",
		actionVersion: "v3",
		arguments: { issueNumber: 180 },
	},
	traceId: "trace-1",
} as const;

const forbiddenCredentialKeys = [
	"token",
	"Authorization",
	"cookie",
	"access_token_value",
	"oauthToken",
	"session_token",
	"AuthorizationHeader",
	"bearerToken",
	"authToken",
	"id_token",
	"jwt",
	"clientKey",
	"set-cookie",
	"setCookie",
	"secretAccessKey",
	"accessKeyId",
	"privateKeyPem",
	"clientSecretValue",
	"personalAccessToken",
	"apiToken",
	"privateKey",
	"apiKey",
	"secret",
	"credential",
	"password",
] as const;

describe("Pilot delegated contracts", () => {
	it("binds every approved Execution Grant authorization dimension", () => {
		expect(ExecutionGrantClaimsV1Schema.parse(validClaims)).toEqual(
			validClaims,
		);
		for (const requiredField of [
			"issuer",
			"audience",
			"expiresAt",
			"grantId",
			"agentId",
			"actorId",
			"conversationId",
			"executionId",
			"actionSetVersion",
			"traceId",
		] as const) {
			const incomplete = { ...validClaims } as Record<string, unknown>;
			delete incomplete[requiredField];
			expect(ExecutionGrantClaimsV1Schema.safeParse(incomplete).success).toBe(
				false,
			);
		}
		expect(
			validateExecutionGrantClaimsV1(validClaims, {
				expectedIssuer: "agent-platform",
				requiredAudience: "connection_api",
				now: "2026-08-28T10:01:00Z",
			}),
		).toEqual(validClaims);
		expect(() =>
			validateExecutionGrantClaimsV1(
				{ ...validClaims, expiresAt: validClaims.issuedAt },
				{
					expectedIssuer: "agent-platform",
					requiredAudience: "connection_api",
					now: "2026-08-28T10:01:00Z",
				},
			),
		).toThrow("Execution Grant claims are inconsistent");
		expect(() =>
			validateExecutionGrantClaimsV1(validClaims, {
				expectedIssuer: "agent-platform",
				requiredAudience: "runtime_host",
				now: "2026-08-28T10:01:00Z",
			}),
		).toThrow("Execution Grant audience mismatch");
		expect(() =>
			validateExecutionGrantClaimsV1(
				{ ...validClaims, actionIds: [] },
				{
					expectedIssuer: "agent-platform",
					requiredAudience: "connection_api",
					now: "2026-08-28T10:01:00Z",
				},
			),
		).toThrow("Execution Grant claims are inconsistent");
		for (const context of [
			{
				expectedIssuer: "other-issuer",
				requiredAudience: "connection_api" as const,
				now: "2026-08-28T10:01:00Z",
			},
			{
				expectedIssuer: "agent-platform",
				requiredAudience: "connection_api" as const,
				now: "2026-08-28T10:06:00Z",
			},
			{
				expectedIssuer: "agent-platform",
				requiredAudience: "connection_api" as const,
				now: "2026-08-28T09:59:00Z",
			},
		]) {
			expect(() =>
				validateExecutionGrantClaimsV1(validClaims, context),
			).toThrow();
		}
		expect(
			validateExecutionGrantClaimsV1(
				{
					...validClaims,
					issuedAt: "2026-12-31T23:59:60Z",
					expiresAt: "2027-01-01T00:00:02Z",
				},
				{
					expectedIssuer: "agent-platform",
					requiredAudience: "connection_api",
					now: "2027-01-01T00:00:01Z",
				},
			).issuedAt,
		).toBe("2026-12-31T23:59:60Z");
	});

	it("binds delegated Action requests to verified Grant claims", () => {
		const context = {
			expectedIssuer: "agent-platform",
			requiredAudience: "connection_api" as const,
			now: "2026-08-28T10:01:00Z",
			expectedActionSetVersion: validClaims.actionSetVersion,
		};
		expect(
			validateDelegatedActionRequestV1(validClaims, validRequest, context),
		).toEqual(validRequest);
		for (const [claims, request, override] of [
			[validClaims, { ...validRequest, traceId: "trace-other" }, {}],
			[
				validClaims,
				{
					...validRequest,
					action: { ...validRequest.action, actionId: "github.issues.write" },
				},
				{},
			],
			[{ ...validClaims, allowedCommands: ["turn.submit"] }, validRequest, {}],
			[validClaims, validRequest, { expectedActionSetVersion: "actions-v8" }],
		] as const) {
			expect(() =>
				validateDelegatedActionRequestV1(claims, request, {
					...context,
					...override,
				}),
			).toThrow();
		}
	});

	it("requires a three-segment compact JWS envelope", () => {
		expect(ExecutionGrantV1Schema.parse(validRequest.grant)).toEqual(
			validRequest.grant,
		);
		expect(
			ExecutionGrantV1Schema.safeParse({
				...validRequest.grant,
				token: "not-a-compact-jws",
			}).success,
		).toBe(false);
	});

	it("accepts only versioned delegated requests without caller-selected identity or Connection", () => {
		expect(DelegatedActionRequestV1Schema.parse(validRequest)).toEqual(
			validRequest,
		);
		for (const injected of [
			{ actorId: "caller-controlled" },
			{ connectionId: "another-users-connection" },
			{ externalAccountId: "another-users-account" },
		]) {
			expect(
				DelegatedActionRequestV1Schema.safeParse({
					...validRequest,
					...injected,
				}).success,
			).toBe(false);
		}
		expect(
			DelegatedActionRequestV1Schema.safeParse({
				...validRequest,
				schemaVersion: 2,
			}).success,
		).toBe(false);
	});

	it("accepts safe results and rejects secret-bearing responses at any depth", () => {
		const safeResult = {
			schemaVersion: 1,
			requestId: "request-1",
			idempotencyKey: validRequest.idempotencyKey,
			callId: "call-1",
			status: "succeeded",
			actionId: "github.issues.read",
			actionVersion: "v3",
			traceId: "trace-1",
			completedAt: "2026-08-28T10:00:01Z",
			output: { issue: { number: 180, title: "Pilot contracts" } },
		};
		expect(DelegatedActionResultV1Schema.parse(safeResult)).toEqual(safeResult);
		for (const key of forbiddenCredentialKeys) {
			expect(
				DelegatedActionResultV1Schema.safeParse({
					...safeResult,
					output: {
						levelOne: { levelTwo: { [key]: "must-not-leave-connection" } },
					},
				}).success,
			).toBe(false);
		}
	});
});
