import { describe, expect, it } from "vitest";

import {
	DelegatedActionRequestV1Schema,
	DelegatedActionResultV1Schema,
	ExecutionGrantClaimsV1Schema,
	ExecutionGrantCommandV1Schema,
	ExecutionGrantV1Schema,
	VerifiedExecutionGrantV1Schema,
	validateDelegatedActionRequestV1,
	validateDelegatedActionResultV1,
	validateExecutionGrantClaimsV1,
	validateVerifiedExecutionGrantClaimsV1,
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
	sessionGeneration: 1,
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

const validVerification = {
	token: validRequest.grant.token,
	claims: validClaims,
} as const;

const validBaseValidationContext = {
	expectedIssuer: "agent-platform",
	requiredAudience: "connection_api" as const,
	now: "2026-08-28T10:01:00Z",
};

const validValidationContext = {
	...validBaseValidationContext,
	expectedBindings: {
		agentId: validClaims.agentId,
		actorId: validClaims.actorId,
		channelId: validClaims.channelId,
		conversationId: validClaims.conversationId,
		turnId: validClaims.turnId,
		executionId: validClaims.executionId,
		sessionGeneration: validClaims.sessionGeneration,
		traceId: validClaims.traceId,
	},
};

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
	"aws_secret_access_key",
	"aws_access_key_id",
	"x-api-key",
	"x-auth-token",
	"secretKey",
	"awsSecretAccessKey",
	"sshPrivateKey",
	"xApiKey",
	"privateKey",
	"apiKey",
	"secret",
	"credential",
	"password",
	"tokens",
	"tokenData",
	"tokenResponse",
] as const;

describe("Pilot delegated contracts", () => {
	it("validates already-verified RuntimeHost claims without caller-only binding context", () => {
		for (const command of [
			"session.status",
			"events.replay",
			"capabilities.read",
			"generation.cancel",
		] as const) {
			expect(ExecutionGrantCommandV1Schema.parse(command)).toBe(command);
			const runtimeClaims = {
				...validClaims,
				audience: ["runtime_host"],
				allowedCommands: [command],
				actionIds: [],
			} as const;
			expect(
				validateVerifiedExecutionGrantClaimsV1(runtimeClaims, {
					...validBaseValidationContext,
					requiredAudience: "runtime_host",
				}),
			).toEqual(runtimeClaims);
		}

		expect(
			validateVerifiedExecutionGrantClaimsV1(
				validClaims,
				validBaseValidationContext,
			),
		).toEqual(validClaims);
		for (const invalidClaims of [
			{ ...validClaims, actionIds: [] },
			{ ...validClaims, audience: ["connection_api"] },
			{ ...validClaims, expiresAt: validClaims.issuedAt },
		]) {
			expect(() =>
				validateVerifiedExecutionGrantClaimsV1(
					invalidClaims,
					validBaseValidationContext,
				),
			).toThrow("Execution Grant claims are inconsistent");
		}
		expect(() =>
			validateVerifiedExecutionGrantClaimsV1(
				{
					...validClaims,
					audience: ["runtime_host"],
					allowedCommands: ["turn.submit"],
				},
				{
					...validBaseValidationContext,
					requiredAudience: "runtime_host",
				},
			),
		).toThrow("Execution Grant claims are inconsistent");
	});

	it("binds every approved Execution Grant authorization dimension", () => {
		expect(ExecutionGrantClaimsV1Schema.parse(validClaims)).toEqual(
			validClaims,
		);
		for (const requiredField of [
			"schemaVersion",
			"issuer",
			"audience",
			"issuedAt",
			"expiresAt",
			"grantId",
			"agentId",
			"actorId",
			"channelId",
			"conversationId",
			"turnId",
			"executionId",
			"sessionGeneration",
			"allowedCommands",
			"attachments",
			"actionSetVersion",
			"actionIds",
			"traceId",
		] as const) {
			const incomplete = { ...validClaims } as Record<string, unknown>;
			delete incomplete[requiredField];
			expect(ExecutionGrantClaimsV1Schema.safeParse(incomplete).success).toBe(
				false,
			);
		}
		expect(
			validateExecutionGrantClaimsV1(validClaims, validValidationContext),
		).toEqual(validClaims);
		for (const binding of [
			"agentId",
			"actorId",
			"channelId",
			"conversationId",
			"turnId",
			"executionId",
			"traceId",
		] as const) {
			expect(() =>
				validateExecutionGrantClaimsV1(
					{ ...validClaims, [binding]: "another-binding" },
					validValidationContext,
				),
			).toThrow("Execution Grant binding mismatch");
		}
		expect(() =>
			validateExecutionGrantClaimsV1(
				{ ...validClaims, sessionGeneration: 2 },
				validValidationContext,
			),
		).toThrow("Execution Grant binding mismatch");
		expect(() =>
			validateExecutionGrantClaimsV1(
				{ ...validClaims, expiresAt: validClaims.issuedAt },
				validValidationContext,
			),
		).toThrow("Execution Grant claims are inconsistent");
		expect(() =>
			validateExecutionGrantClaimsV1(validClaims, {
				...validValidationContext,
				requiredAudience: "runtime_host",
			}),
		).toThrow("Execution Grant audience mismatch");
		expect(() =>
			validateExecutionGrantClaimsV1(
				{ ...validClaims, actionIds: [] },
				validValidationContext,
			),
		).toThrow("Execution Grant claims are inconsistent");
		for (const override of [
			{ expectedIssuer: "other-issuer" },
			{ now: "2026-08-28T10:06:00Z" },
			{ now: "2026-08-28T09:59:00Z" },
		]) {
			expect(() =>
				validateExecutionGrantClaimsV1(validClaims, {
					...validValidationContext,
					...override,
				}),
			).toThrow();
		}
		expect(
			validateExecutionGrantClaimsV1(
				{
					...validClaims,
					issuedAt: "2026-12-31T23:59:60Z",
					expiresAt: "2027-01-01T00:00:02Z",
				},
				{ ...validValidationContext, now: "2027-01-01T00:00:01Z" },
			).issuedAt,
		).toBe("2026-12-31T23:59:60Z");
		expect(() =>
			validateExecutionGrantClaimsV1(
				{
					...validClaims,
					issuedAt: "2026-08-28T10:00:00.0009Z",
					expiresAt: "2026-08-28T10:00:00.0011Z",
				},
				{ ...validValidationContext, now: "2026-08-28T10:00:00.0001Z" },
			),
		).toThrow("Execution Grant claims are inconsistent");
	});

	it("binds delegated Action requests to verified Grant claims", () => {
		const context = {
			...validValidationContext,
			expectedActionSetVersion: validClaims.actionSetVersion,
			expectedActionVersion: validRequest.action.actionVersion,
		};
		expect(
			validateDelegatedActionRequestV1(
				validVerification,
				validRequest,
				context,
			),
		).toEqual(validRequest);
		expect(() =>
			validateDelegatedActionRequestV1(
				validVerification,
				{
					...validRequest,
					grant: { ...validRequest.grant, token: "other.payload.signature" },
				},
				context,
			),
		).toThrow("Execution Grant verification mismatch");
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
			[validClaims, validRequest, { expectedActionVersion: "v4" }],
		] as const) {
			expect(() =>
				validateDelegatedActionRequestV1(
					{ token: request.grant.token, claims },
					request,
					{
						...context,
						...override,
					},
				),
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
		expect(
			ExecutionGrantV1Schema.safeParse({
				...validRequest.grant,
				schemaVersion: 2,
			}).success,
		).toBe(false);
		expect(VerifiedExecutionGrantV1Schema.parse(validVerification)).toEqual(
			validVerification,
		);
	});

	it("accepts only versioned delegated requests without caller-selected identity or Connection", () => {
		expect(DelegatedActionRequestV1Schema.parse(validRequest)).toEqual(
			validRequest,
		);
		for (const injected of [
			{ actorId: "caller-controlled" },
			{ userId: "caller-controlled" },
			{ organizationId: "caller-controlled" },
			{ authorization: "caller-controlled" },
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
		for (const key of [
			"connectionId",
			"connectionIds",
			"connectionIdList",
			"externalAccountIds",
			"platformUserId",
			"platformUserIds",
			"platformSessionId",
			"actorId",
			"nativeSessionId",
			"attachmentId",
			"attachmentIds",
			"token",
			"tokenResponse",
		]) {
			expect(
				DelegatedActionRequestV1Schema.safeParse({
					...validRequest,
					action: {
						...validRequest.action,
						arguments: { nested: { [key]: "caller-controlled" } },
					},
				}).success,
			).toBe(false);
		}
		expect(
			DelegatedActionRequestV1Schema.parse({
				...validRequest,
				action: {
					...validRequest.action,
					arguments: {
						issueNumber: 180,
						pageCursor: "opaque-pagination-cursor",
						userId: "provider-domain-user",
					},
				},
			}),
		).toMatchObject({
			action: {
				arguments: {
					pageCursor: "opaque-pagination-cursor",
					userId: "provider-domain-user",
				},
			},
		});
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
		expect(
			DelegatedActionResultV1Schema.safeParse({
				...safeResult,
				schemaVersion: 2,
			}).success,
		).toBe(false);
		expect(
			DelegatedActionResultV1Schema.parse({
				...safeResult,
				output: { nextPageToken: "opaque-pagination-cursor" },
			}),
		).toMatchObject({
			status: "succeeded",
			output: { nextPageToken: "opaque-pagination-cursor" },
		});
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
		expect(
			DelegatedActionResultV1Schema.safeParse({
				schemaVersion: 1,
				requestId: safeResult.requestId,
				idempotencyKey: safeResult.idempotencyKey,
				status: "failed",
				callId: null,
				actionId: safeResult.actionId,
				actionVersion: safeResult.actionVersion,
				traceId: safeResult.traceId,
				completedAt: safeResult.completedAt,
				error: {
					schemaVersion: 1,
					code: "CONNECTION_UNAVAILABLE",
					message: "Provider returned bearer token secret-value",
					retryable: true,
					traceId: safeResult.traceId,
				},
			}).success,
		).toBe(false);
		expect(() =>
			validateDelegatedActionResultV1(validRequest, {
				schemaVersion: 1,
				requestId: safeResult.requestId,
				idempotencyKey: safeResult.idempotencyKey,
				status: "failed",
				callId: null,
				actionId: safeResult.actionId,
				actionVersion: safeResult.actionVersion,
				traceId: safeResult.traceId,
				completedAt: safeResult.completedAt,
				error: {
					schemaVersion: 1,
					code: "CONNECTION_UNAVAILABLE",
					message: "Connection is unavailable",
					retryable: true,
					traceId: "trace-other",
				},
			}),
		).toThrow("Delegated Action result correlation mismatch");
	});
});
