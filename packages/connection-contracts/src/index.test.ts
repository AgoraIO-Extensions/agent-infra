import { describe, expect, it } from "vitest";

import {
	connectionBrowserOpenApi,
	oauthTransactionRequestSchema,
	providerCredentialRequestSchema,
} from "./index";

describe("Connection Browser OpenAPI", () => {
	it("declares mutually exclusive OAuth targets while allowing either target or neither", () => {
		expect(
			connectionBrowserOpenApi.components.schemas.OAuthTransactionRequest.not,
		).toEqual({ required: ["accessRequestId", "sharedScopeId"] });
		for (const input of [
			{},
			{ accessRequestId: "request-1" },
			{ providerId: "manhattan", accessRequestId: "request-1" },
			{ providerId: "manhattan", reconnectConnectionId: "connection-1" },
			{ sharedScopeId: "shared-1" },
		]) {
			expect(oauthTransactionRequestSchema.safeParse(input).success).toBe(true);
		}
		for (const input of [
			{ accessRequestId: "request-1", sharedScopeId: "shared-1" },
			{ accessRequestId: "request-1", reconnectConnectionId: "connection-1" },
			{ sharedScopeId: "shared-1", reconnectConnectionId: "connection-1" },
		]) {
			expect(oauthTransactionRequestSchema.safeParse(input).success).toBe(
				false,
			);
		}
	});
	it("keeps the versioned browser surface free of caller identity selectors", () => {
		expect(connectionBrowserOpenApi.openapi).toBe("3.1.0");
		const serialized = JSON.stringify(connectionBrowserOpenApi);
		for (const forbidden of ['"actorPrincipalId"', '"credential"']) {
			expect(serialized).not.toContain(forbidden);
		}
		expect(
			providerCredentialRequestSchema.safeParse({
				providerId: "manhattan",
				username: "employee",
				password: "company-password",
			}).success,
		).toBe(false);
		// One schema property plus the same field in that schema's required list.
		expect(serialized.match(/"accessToken"/g)).toHaveLength(2);
		expect(
			connectionBrowserOpenApi.components.schemas.ProviderCredentialRequest,
		).toEqual({
			oneOf: [
				{
					additionalProperties: false,
					properties: {
						accessRequestId: { type: "string" },
						providerId: { const: "datalego", type: "string" },
					},
					required: ["providerId"],
					type: "object",
				},
				{
					additionalProperties: false,
					properties: {
						accessRequestId: { type: "string" },
						accessToken: { maxLength: 8192, minLength: 1, type: "string" },
						providerId: {
							enum: ["bitbucket", "rehoboam", "static-spaces"],
							type: "string",
						},
					},
					required: ["providerId", "accessToken"],
					type: "object",
				},
				{
					additionalProperties: false,
					properties: {
						accessRequestId: { type: "string" },
						password: { maxLength: 1024, minLength: 1, type: "string" },
						providerId: {
							enum: ["confluence", "jira"],
							type: "string",
						},
						username: { maxLength: 256, minLength: 1, type: "string" },
					},
					required: ["providerId", "username", "password"],
					type: "object",
				},
				{
					additionalProperties: false,
					properties: {
						accessRequestId: { type: "string" },
						apiToken: { maxLength: 8192, minLength: 1, type: "string" },
						providerId: {
							enum: ["jenkins-ci", "jenkins-release"],
							type: "string",
						},
						username: { maxLength: 256, minLength: 1, type: "string" },
					},
					required: ["providerId", "username", "apiToken"],
					type: "object",
				},
			],
		});
	});
});
