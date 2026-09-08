import { z } from "zod";

import {
	OpaqueCursorV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
	TraceIdV1Schema,
} from "../index.ts";

const nonEmptyString = () => z.string().min(1);
const numericId = () => z.string().regex(/^\d+$/);
const providerTerminalRejectionStatus = () =>
	z.union([
		z.number().int().min(400).max(428),
		z.number().int().min(430).max(499),
	]);
const jsonSchema = () => z.record(z.string(), z.json());
const pageQuery = z.strictObject({
	cursor: OpaqueCursorV1Schema.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});
const jsonContent = (schema: z.ZodType) => ({
	content: { "application/json": { schema } },
});
const jsonResponse = (description: string, schema: z.ZodType) => ({
	description,
	...jsonContent(schema),
});
const requiredJsonBody = (schema: z.ZodType) => ({
	required: true,
	...jsonContent(schema),
});
const fixedError = (code: string, message: string, retryable: boolean) =>
	z.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		code: z.literal(code),
		message: z.literal(message),
		retryable: z.literal(retryable),
		traceId: TraceIdV1Schema,
	});
const AuthenticationRequiredErrorV1Schema = fixedError(
	"AUTHENTICATION_REQUIRED",
	"Authentication is required",
	false,
);
const browserErrors = {
	"400": jsonResponse(
		"Invalid request",
		fixedError("INVALID_REQUEST", "Invalid request", false),
	),
	"401": jsonResponse(
		"Authentication required",
		AuthenticationRequiredErrorV1Schema,
	),
	"403": jsonResponse(
		"Request is not authorized",
		fixedError("AUTHORIZATION_REVOKED", "Authorization was revoked", false),
	),
	"404": jsonResponse(
		"Resource is unavailable",
		fixedError("RESOURCE_UNAVAILABLE", "Resource is unavailable", false),
	),
	"409": jsonResponse(
		"Request conflicts with current state",
		fixedError(
			"INVALID_REQUEST",
			"Request conflicts with current state",
			false,
		),
	),
	"500": jsonResponse(
		"Internal error",
		fixedError("INTERNAL_ERROR", "Connection request failed", true),
	),
	"503": jsonResponse(
		"Dependency is unavailable",
		fixedError("DEPENDENCY_UNAVAILABLE", "Dependency is unavailable", true),
	),
};

export const GitHubGetCurrentUserInputV1Schema = z.strictObject({});
export const GitHubGetCurrentUserOutputV1Schema = z.strictObject({
	accountId: numericId(),
	login: nonEmptyString(),
});
export const GitHubListMyRepositoriesInputV1Schema = z.strictObject({});
export const GitHubRepositoryV1Schema = z.strictObject({
	repositoryId: numericId(),
	owner: nonEmptyString(),
	name: nonEmptyString(),
	private: z.literal(true).meta({
		description:
			"The repository was revalidated against the Pilot private-repository policy before projection.",
	}),
});
export const GitHubListMyRepositoriesOutputV1Schema = z.strictObject({
	repositories: z.array(GitHubRepositoryV1Schema),
});
export const GitHubCreatePullRequestInputV1Schema = z.strictObject({
	repositoryId: numericId(),
	head: nonEmptyString(),
	base: nonEmptyString(),
	title: nonEmptyString(),
	body: z.string(),
});
export const GitHubCreatePullRequestOutputV1Schema = z.strictObject({
	pullRequestId: numericId(),
	number: z.number().int().positive(),
	url: z
		.string()
		.url()
		.regex(/^https:\/\/github\.com\//),
});

const catalogActionShape = {
	status: z.enum(["published", "disabled"]),
	inputSchema: jsonSchema(),
	outputSchema: jsonSchema(),
};
export const GitHubGetCurrentUserCatalogActionV1Schema = z.strictObject({
	...catalogActionShape,
	actionId: z.literal("github.get_current_user"),
	actionVersionId: z.literal("github.get_current_user@v1"),
	effect: z.literal("read"),
	requiredScopes: z.array(z.literal("read:user")).length(1),
});
export const GitHubListMyRepositoriesCatalogActionV1Schema = z.strictObject({
	...catalogActionShape,
	actionId: z.literal("github.list_my_repositories"),
	actionVersionId: z.literal("github.list_my_repositories@v1"),
	effect: z.literal("read"),
	requiredScopes: z.array(z.literal("repo")).length(1),
});
export const GitHubCreatePullRequestCatalogActionV1Schema = z.strictObject({
	...catalogActionShape,
	actionId: z.literal("github.create_pull_request"),
	actionVersionId: z.literal("github.create_pull_request@v1"),
	effect: z.literal("write"),
	requiredScopes: z.array(z.literal("repo")).length(1),
});
export const ConnectionCatalogV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	catalogVersion: nonEmptyString(),
	providers: z
		.tuple([
			z.strictObject({
				providerId: z.literal("github"),
				providerReleaseId: nonEmptyString(),
				displayName: z.literal("GitHub"),
				status: z.enum(["published", "disabled"]),
				actions: z
					.tuple([
						GitHubGetCurrentUserCatalogActionV1Schema,
						GitHubListMyRepositoriesCatalogActionV1Schema,
						GitHubCreatePullRequestCatalogActionV1Schema,
					])
					.and(z.array(z.unknown()).length(3)),
			}),
		])
		.and(z.array(z.unknown()).length(1)),
});

export const ConnectionLoginRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	username: nonEmptyString(),
	password: nonEmptyString().meta({ writeOnly: true }),
});
export const ConnectionPrincipalV1Schema = z.strictObject({
	principalId: OpaqueIdV1Schema,
	uid: nonEmptyString(),
	displayName: nonEmptyString(),
});
export const ConnectionBrowserSessionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	principal: ConnectionPrincipalV1Schema,
});
export const ConnectionExternalAccountV1Schema = z.strictObject({
	accountId: numericId(),
	login: nonEmptyString(),
});
export const ConnectionProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	connectionId: OpaqueIdV1Schema,
	providerId: z.literal("github"),
	status: z.enum(["active", "disconnecting", "disconnected"]),
	externalAccount: ConnectionExternalAccountV1Schema,
	createdAt: Rfc3339TimestampV1Schema,
});
export const ConnectionListV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	connections: z.array(ConnectionProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
export const ConnectionOAuthStartV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	authorizationUrl: z
		.string()
		.url()
		.regex(/^https:\/\/github\.com\//),
});
export const PilotActionVersionIdV1Schema = z.enum([
	"github.get_current_user@v1",
	"github.list_my_repositories@v1",
	"github.create_pull_request@v1",
]);
export const PilotActionVersionIdsV1Schema = z
	.array(PilotActionVersionIdV1Schema)
	.min(1)
	.max(3)
	.refine((ids) => new Set(ids).size === ids.length, {
		message: "Action version IDs must be unique",
	})
	.meta({ uniqueItems: true });
export const ConnectionGrantCreateRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	consumerId: OpaqueIdV1Schema,
	actorId: OpaqueIdV1Schema,
	connectionId: OpaqueIdV1Schema,
	actionVersionIds: PilotActionVersionIdsV1Schema,
});
export const ConnectionGrantProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	grantId: OpaqueIdV1Schema,
	consumerId: OpaqueIdV1Schema,
	actorId: OpaqueIdV1Schema,
	connectionId: OpaqueIdV1Schema,
	actionVersionIds: PilotActionVersionIdsV1Schema,
	status: z.enum(["active", "revoked"]),
	createdAt: Rfc3339TimestampV1Schema,
	updatedAt: Rfc3339TimestampV1Schema,
});
export const ConnectionGrantListV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	grants: z.array(ConnectionGrantProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});

const callShape = {
	schemaVersion: SchemaVersionV1Schema,
	callId: OpaqueIdV1Schema,
	actionVersionId: PilotActionVersionIdV1Schema,
	traceId: TraceIdV1Schema,
	createdAt: Rfc3339TimestampV1Schema,
	updatedAt: Rfc3339TimestampV1Schema,
};
export const ConnectionProviderFailedV1Schema = z.strictObject({
	...callShape,
	status: z.literal("provider_failed"),
	error: z.strictObject({
		code: z.literal("PROVIDER_FAILED"),
		message: z.literal("Provider rejected the Action"),
		retryable: z.literal(false),
		providerStatusCode: providerTerminalRejectionStatus(),
		providerRequestId: nonEmptyString().nullable(),
	}),
});
export const ConnectionResultPendingV1Schema = z.strictObject({
	...callShape,
	status: z.literal("result_pending"),
	uncertainty: z.strictObject({
		reason: z.enum([
			"provider_response_lost",
			"terminal_result_persistence_failed",
			"process_interrupted",
		]),
		reconcileUntil: Rfc3339TimestampV1Schema,
	}),
});
const succeededCall = (actionVersionId: string, result: z.ZodType) =>
	z.strictObject({
		...callShape,
		actionVersionId: z.literal(actionVersionId),
		status: z.literal("succeeded"),
		result,
	});
export const ConnectionActionCallProjectionV1Schema = z.union([
	z.strictObject({ ...callShape, status: z.literal("pending") }),
	z.strictObject({ ...callShape, status: z.literal("submission_started") }),
	succeededCall(
		"github.get_current_user@v1",
		GitHubGetCurrentUserOutputV1Schema,
	),
	succeededCall(
		"github.list_my_repositories@v1",
		GitHubListMyRepositoriesOutputV1Schema,
	),
	succeededCall(
		"github.create_pull_request@v1",
		GitHubCreatePullRequestOutputV1Schema,
	),
	ConnectionProviderFailedV1Schema,
	ConnectionResultPendingV1Schema,
	z.strictObject({
		...callShape,
		status: z.literal("needs_manual_review"),
		evidenceSummary: nonEmptyString(),
	}),
	z.strictObject({
		...callShape,
		status: z.literal("confirmed_succeeded"),
		resolvedAt: Rfc3339TimestampV1Schema,
		evidenceReference: nonEmptyString(),
	}),
	z.strictObject({
		...callShape,
		status: z.literal("confirmed_failed"),
		resolvedAt: Rfc3339TimestampV1Schema,
		evidenceReference: nonEmptyString(),
	}),
	z.strictObject({
		...callShape,
		status: z.literal("unresolved"),
		resolvedAt: Rfc3339TimestampV1Schema,
		evidenceReference: nonEmptyString(),
	}),
]);
export const ConnectionActionCallListV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	calls: z.array(ConnectionActionCallProjectionV1Schema),
	nextCursor: OpaqueCursorV1Schema.nullable(),
});
export const ConnectionManualResolutionRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	resolution: z.enum(["confirmed_succeeded", "confirmed_failed", "unresolved"]),
	evidenceReference: nonEmptyString(),
});
export const ConnectionProviderRevokeStatusV1Schema = z.enum([
	"not_requested",
	"pending",
	"succeeded",
	"retryable_failure",
	"terminal_failure",
]);
export const ConnectionProviderRevokeProjectionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	attemptId: OpaqueIdV1Schema,
	connectionId: OpaqueIdV1Schema,
	credentialVersionId: OpaqueIdV1Schema,
	status: ConnectionProviderRevokeStatusV1Schema,
	updatedAt: Rfc3339TimestampV1Schema,
});
export const ConnectionCommandAcceptedV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	status: z.literal("accepted"),
});

const ok = (description: string, schema: z.ZodType) =>
	jsonResponse(description, schema);
const browserSecurity = [{ ConnectionBrowserSession: [], ConnectionCsrf: [] }];
const adminSecurity = [{ ConnectionAdminSession: [], ConnectionCsrf: [] }];

export const connectionBrowserOpenApiPathsV1 = {
	"/connection/api/v1/session": {
		get: {
			operationId: "readConnectionSession",
			security: [{ ConnectionBrowserSession: [] }],
			responses: {
				"200": ok("Current session", ConnectionBrowserSessionV1Schema),
				...browserErrors,
			},
		},
		post: {
			operationId: "loginConnectionSession",
			security: [{ ConnectionCsrf: [] }],
			requestBody: requiredJsonBody(ConnectionLoginRequestV1Schema),
			responses: {
				"200": ok("Authenticated session", ConnectionBrowserSessionV1Schema),
				...browserErrors,
			},
		},
		delete: {
			operationId: "logoutConnectionSession",
			security: browserSecurity,
			responses: {
				"204": { description: "Session revoked" },
				...browserErrors,
			},
		},
	},
	"/connection/api/v1/connections": {
		get: {
			operationId: "listConnections",
			security: [{ ConnectionBrowserSession: [] }],
			requestParams: { query: pageQuery },
			responses: {
				"200": ok("Current Principal connections", ConnectionListV1Schema),
				...browserErrors,
			},
		},
	},
	"/connection/api/v1/connections/{connectionId}": {
		delete: {
			operationId: "disconnectConnection",
			security: browserSecurity,
			requestParams: {
				path: z.strictObject({ connectionId: OpaqueIdV1Schema }),
			},
			responses: {
				"202": ok(
					"Disconnect and Provider revoke accepted",
					ConnectionProviderRevokeProjectionV1Schema,
				),
				...browserErrors,
			},
		},
	},
	"/connection/api/v1/connections/github/oauth": {
		post: {
			operationId: "startGitHubConnectionOAuth",
			security: browserSecurity,
			responses: {
				"200": ok(
					"GitHub authorization redirect",
					ConnectionOAuthStartV1Schema,
				),
				...browserErrors,
			},
		},
	},
	"/connection/api/v1/grants": {
		get: {
			operationId: "listConnectionGrants",
			security: [{ ConnectionBrowserSession: [] }],
			requestParams: { query: pageQuery },
			responses: {
				"200": ok("Current Principal grants", ConnectionGrantListV1Schema),
				...browserErrors,
			},
		},
		post: {
			operationId: "createConnectionGrant",
			security: browserSecurity,
			requestBody: requiredJsonBody(ConnectionGrantCreateRequestV1Schema),
			responses: {
				"201": ok("Created grant", ConnectionGrantProjectionV1Schema),
				...browserErrors,
			},
		},
	},
	"/connection/api/v1/grants/{grantId}": {
		delete: {
			operationId: "revokeConnectionGrant",
			security: browserSecurity,
			requestParams: { path: z.strictObject({ grantId: OpaqueIdV1Schema }) },
			responses: {
				"200": ok("Revoked grant", ConnectionGrantProjectionV1Schema),
				...browserErrors,
			},
		},
	},
	"/connection/api/v1/action-calls": {
		get: {
			operationId: "listConnectionActionCalls",
			security: [{ ConnectionBrowserSession: [] }],
			requestParams: { query: pageQuery },
			responses: {
				"200": ok(
					"Current Principal Action calls",
					ConnectionActionCallListV1Schema,
				),
				...browserErrors,
			},
		},
	},
	"/connection/api/v1/admin/action-calls/{callId}/resolution": {
		post: {
			operationId: "resolveConnectionActionCall",
			security: adminSecurity,
			requestParams: { path: z.strictObject({ callId: OpaqueIdV1Schema }) },
			requestBody: requiredJsonBody(ConnectionManualResolutionRequestV1Schema),
			responses: {
				"200": ok(
					"Resolved Action call",
					ConnectionActionCallProjectionV1Schema,
				),
				...browserErrors,
			},
		},
	},
};

export const connectionCatalogOpenApiPathsV1 = {
	"/connection/internal/v1/catalog": {
		get: {
			operationId: "readConnectionCatalog",
			security: [{ ConnectionCatalogCredential: ["catalog:read"] }],
			responses: {
				"200": ok("Published Connection catalog", ConnectionCatalogV1Schema),
				...browserErrors,
				"401": jsonResponse(
					"Authentication required",
					AuthenticationRequiredErrorV1Schema,
				),
			},
		},
	},
};

export const connectionCatalogSchemasV1 = {
	ConnectionCatalogV1: ConnectionCatalogV1Schema,
};

export const connectionBrowserSchemasV1 = {
	ConnectionActionCallProjectionV1: ConnectionActionCallProjectionV1Schema,
	ConnectionBrowserSessionV1: ConnectionBrowserSessionV1Schema,
	ConnectionGrantCreateRequestV1: ConnectionGrantCreateRequestV1Schema,
	ConnectionGrantProjectionV1: ConnectionGrantProjectionV1Schema,
	ConnectionLoginRequestV1: ConnectionLoginRequestV1Schema,
	PilotActionVersionIdV1: PilotActionVersionIdV1Schema,
	ConnectionProviderRevokeStatusV1: ConnectionProviderRevokeStatusV1Schema,
	ConnectionProviderRevokeProjectionV1:
		ConnectionProviderRevokeProjectionV1Schema,
	GitHubCreatePullRequestOutputV1: GitHubCreatePullRequestOutputV1Schema,
	GitHubGetCurrentUserOutputV1: GitHubGetCurrentUserOutputV1Schema,
	GitHubListMyRepositoriesOutputV1: GitHubListMyRepositoriesOutputV1Schema,
};

export const connectionSchemasV1 = {
	...connectionBrowserSchemasV1,
	...connectionCatalogSchemasV1,
	GitHubCreatePullRequestInputV1: GitHubCreatePullRequestInputV1Schema,
	GitHubGetCurrentUserInputV1: GitHubGetCurrentUserInputV1Schema,
	GitHubListMyRepositoriesInputV1: GitHubListMyRepositoriesInputV1Schema,
};

export type ConnectionCatalogV1 = z.infer<typeof ConnectionCatalogV1Schema>;
export type ConnectionActionCallProjectionV1 = z.infer<
	typeof ConnectionActionCallProjectionV1Schema
>;
