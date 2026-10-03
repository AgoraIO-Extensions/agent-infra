import { z } from "zod";
import { OpaqueIdV1Schema, Rfc3339TimestampV1Schema } from "./index.ts";
import { ExecutionGrantV1Schema } from "./pilot/delegated.ts";

export const FileDescriptorV1Schema = z.strictObject({
	name: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[^\p{Cc}/\\]+$/u),
	mediaType: z
		.string()
		.max(127)
		.regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
	sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const FileExecutionBindingV1Schema = z.strictObject({
	executionId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	grantId: OpaqueIdV1Schema,
});
export const FileAccessClaimsV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	purpose: z.literal("file_access"),
	issuer: z.string().min(1).max(255),
	audience: z.literal("platform_files"),
	accessId: OpaqueIdV1Schema,
	fileId: OpaqueIdV1Schema,
	actorId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	channelId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	operation: z.enum(["read", "write"]),
	issuedAt: Rfc3339TimestampV1Schema,
	expiresAt: Rfc3339TimestampV1Schema,
	maxBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	execution: FileExecutionBindingV1Schema.nullable(),
});
export type FileDescriptorV1 = z.infer<typeof FileDescriptorV1Schema>;
export type FileAccessClaimsV1 = z.infer<typeof FileAccessClaimsV1Schema>;

export const FileLimitsV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	revision: z.string().min(1).max(255),
	expiresAt: Rfc3339TimestampV1Schema,
	mediaTypes: z.array(FileDescriptorV1Schema.shape.mediaType).min(1).max(128),
	maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const FileIntentRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	descriptor: FileDescriptorV1Schema,
});
export const FileProjectionV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	fileId: OpaqueIdV1Schema,
	kind: z.enum(["attachment", "result"]),
	descriptor: FileDescriptorV1Schema,
	status: z.enum([
		"pending",
		"available",
		"failed",
		"expired",
		"deleting",
		"deleted",
	]),
	createdAt: Rfc3339TimestampV1Schema,
	expiresAt: Rfc3339TimestampV1Schema,
});
export const FileAccessRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	operation: z.enum(["read", "write"]),
});
export const FileAccessGrantV1Schema = ExecutionGrantV1Schema;
export const FileAccessResponseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	accessId: OpaqueIdV1Schema,
	file: FileProjectionV1Schema,
	path: z
		.string()
		.regex(/^\/api\/v1\/conversations\/[^/?#]+\/files\/[^/?#]+\/content$/),
	grant: FileAccessGrantV1Schema,
	expiresAt: Rfc3339TimestampV1Schema,
});
export const FileCompleteRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	accessId: OpaqueIdV1Schema,
});
export const FileExchangeRequestV1Schema = z.discriminatedUnion("operation", [
	z.strictObject({
		schemaVersion: z.literal(1),
		operation: z.literal("read"),
		executionGrant: FileAccessGrantV1Schema,
		accessIdempotencyKey: z
			.string()
			.regex(/^[A-Za-z0-9._~-]{1,128}$/)
			.optional(),
		fileId: OpaqueIdV1Schema,
	}),
	z.strictObject({
		schemaVersion: z.literal(1),
		operation: z.literal("result"),
		executionGrant: FileAccessGrantV1Schema,
		accessIdempotencyKey: z
			.string()
			.regex(/^[A-Za-z0-9._~-]{1,128}$/)
			.optional(),
		descriptor: FileDescriptorV1Schema,
	}),
]);
export const fileSchemasV1 = {
	FileDescriptorV1: FileDescriptorV1Schema,
	FileLimitsV1: FileLimitsV1Schema,
	FileProjectionV1: FileProjectionV1Schema,
	FileIntentRequestV1: FileIntentRequestV1Schema,
	FileAccessRequestV1: FileAccessRequestV1Schema,
	FileAccessClaimsV1: FileAccessClaimsV1Schema,
	FileAccessGrantV1: FileAccessGrantV1Schema,
	FileAccessResponseV1: FileAccessResponseV1Schema,
	FileCompleteRequestV1: FileCompleteRequestV1Schema,
	FileExchangeRequestV1: FileExchangeRequestV1Schema,
};
export type FileAccessGrantV1 = z.infer<typeof FileAccessGrantV1Schema>;

const jsonBody = (schema: z.ZodType) => ({
	required: true,
	content: { "application/json": { schema } },
});
const jsonResponse = (schema: z.ZodType) => ({
	description: "Success",
	content: { "application/json": { schema } },
});
const conversationParameter = {
	name: "conversationId",
	in: "path" as const,
	required: true,
	schema: OpaqueIdV1Schema,
};
const fileParameter = {
	name: "fileId",
	in: "path" as const,
	required: true,
	schema: OpaqueIdV1Schema,
};
const idempotencyParameter = {
	name: "Idempotency-Key",
	in: "header" as const,
	required: true,
	schema: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
};
const grantParameter = {
	name: "X-Platform-File-Grant",
	in: "header" as const,
	required: true,
	schema: z.string().min(1).max(16384),
};
const fileRoot = "/api/v1/conversations/{conversationId}/files";
export const fileOpenApiPathsV1 = {
	[fileRoot]: {
		post: {
			operationId: "createFileUpload",
			parameters: [conversationParameter, idempotencyParameter],
			requestBody: jsonBody(FileIntentRequestV1Schema),
			responses: { "201": jsonResponse(FileProjectionV1Schema) },
		},
	},
	[`${fileRoot}/limits`]: {
		get: {
			operationId: "readFileLimits",
			parameters: [conversationParameter],
			responses: { "200": jsonResponse(FileLimitsV1Schema) },
		},
	},
	[`${fileRoot}/{fileId}/access`]: {
		post: {
			operationId: "issueFileAccess",
			parameters: [conversationParameter, fileParameter, idempotencyParameter],
			requestBody: jsonBody(FileAccessRequestV1Schema),
			responses: { "200": jsonResponse(FileAccessResponseV1Schema) },
		},
	},
	[`${fileRoot}/{fileId}/complete`]: {
		post: {
			operationId: "completeFileUpload",
			parameters: [conversationParameter, fileParameter, grantParameter],
			requestBody: jsonBody(FileCompleteRequestV1Schema),
			responses: { "200": jsonResponse(FileProjectionV1Schema) },
		},
	},
	[`${fileRoot}/{fileId}/content`]: {
		put: {
			operationId: "uploadFileContent",
			parameters: [
				conversationParameter,
				fileParameter,
				grantParameter,
				{
					name: "Content-Length",
					in: "header" as const,
					required: true,
					schema: z.number().int().nonnegative(),
				},
			],
			requestBody: {
				required: true,
				content: { "*/*": { schema: z.string().meta({ format: "binary" }) } },
			},
			responses: {
				"204": { description: "Bytes uploaded; completion is still required" },
			},
		},
		get: {
			operationId: "downloadFileContent",
			parameters: [conversationParameter, fileParameter, grantParameter],
			responses: {
				"200": {
					description: "Authenticated file bytes",
					content: { "*/*": { schema: z.string().meta({ format: "binary" }) } },
				},
			},
		},
	},
};
export const fileExchangeOpenApiPathsV1 = {
	"/internal/v1/files/exchange": {
		post: {
			operationId: "exchangeExecutionFileAccess",
			parameters: [
				idempotencyParameter,
				{
					name: "Authorization",
					in: "header" as const,
					required: true,
					schema: z.string(),
				},
			],
			requestBody: jsonBody(FileExchangeRequestV1Schema),
			responses: { "200": jsonResponse(FileAccessResponseV1Schema) },
		},
	},
};
