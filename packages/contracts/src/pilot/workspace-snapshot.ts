import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
} from "../index.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).min(1).max(63);
const sizeBytes = z.number().int().nonnegative().safe();

export const WorkspaceSnapshotBindingV1Schema = z.strictObject({ snapshotId: OpaqueIdV1Schema, name });
export type WorkspaceSnapshotBindingV1 = z.infer<typeof WorkspaceSnapshotBindingV1Schema>;
export const WorkspaceSnapshotSourceV1Schema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("direct-upload") }),
	z.strictObject({ kind: z.literal("builder-connection"), repository: z.string().min(1).max(512), commitSha: z.string().regex(/^[0-9a-f]{40}$/), connectionCallReference: OpaqueIdV1Schema }),
]);
export const WorkspaceSnapshotMetadataV1Schema = z.strictObject({
	snapshotId: OpaqueIdV1Schema, digest, sizeBytes, unpackedSizeBytes: sizeBytes,
	fileCount: z.number().int().positive().safe(), mediaType: z.literal("application/x-tar+gzip"),
	source: WorkspaceSnapshotSourceV1Schema, createdAt: Rfc3339TimestampV1Schema,
	status: z.enum(["ready", "deleting", "deleted"]), bindings: z.array(WorkspaceSnapshotBindingV1Schema),
});
export const WorkspaceSnapshotUploadRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1), source: WorkspaceSnapshotSourceV1Schema.default({ kind: "direct-upload" }),
});
const response = (description: string, schema: z.ZodType) => ({ description, content: { "application/json": { schema } } });
const errorResponses = {
	"400": response("Invalid request", PilotProtocolErrorV1Schema), "401": response("Authentication required", PilotProtocolErrorV1Schema),
	"403": response("Authorization is no longer valid", PilotProtocolErrorV1Schema), "404": response("Resource is unavailable", PilotProtocolErrorV1Schema),
	"409": response("Resource conflicts with an existing binding", PilotProtocolErrorV1Schema), "413": response("Snapshot exceeds a configured limit", PilotProtocolErrorV1Schema),
	"422": response("Snapshot archive or digest is invalid", PilotProtocolErrorV1Schema), "429": response("Upload rate limit exceeded", PilotProtocolErrorV1Schema),
	"503": response("Dependency is temporarily unavailable", PilotProtocolErrorV1Schema),
};
export const workspaceSnapshotOpenApiPathsV1 = {
	"/api/v2/workspace-snapshots": {
		post: { operationId: "uploadWorkspaceSnapshotV1", summary: "Upload an immutable workspace snapshot archive", description: "Bearer credential only. The server calculates the SHA-256 while streaming the gzip tar archive; content is never returned or exposed for download.", security: [{ platformApiCredential: ["agent:create"] }], requestParams: { header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema, "X-Content-SHA256": z.string().regex(/^[a-f0-9]{64}$/) }) }, requestBody: { required: true, content: { "application/x-tar+gzip": { schema: z.any() } } }, responses: { "201": response("Snapshot accepted", WorkspaceSnapshotMetadataV1Schema), "200": response("Idempotent replay", WorkspaceSnapshotMetadataV1Schema), ...errorResponses } },
		get: { operationId: "listWorkspaceSnapshotsV1", summary: "List workspace snapshot metadata owned by the current subject", security: [{ platformApiCredential: ["agent:read"] }], responses: { "200": response("Snapshot metadata", z.array(WorkspaceSnapshotMetadataV1Schema)), ...errorResponses } },
	},
	"/api/v2/workspace-snapshots/{snapshotId}": {
		get: { operationId: "getWorkspaceSnapshotV1", security: [{ platformApiCredential: ["agent:read"] }], requestParams: { path: z.strictObject({ snapshotId: OpaqueIdV1Schema }) }, responses: { "200": response("Snapshot metadata", WorkspaceSnapshotMetadataV1Schema), ...errorResponses } },
		delete: { operationId: "deleteWorkspaceSnapshotV1", security: [{ platformApiCredential: ["agent:manage"] }], requestParams: { path: z.strictObject({ snapshotId: OpaqueIdV1Schema }), header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }) }, responses: { "200": response("Snapshot deletion accepted", WorkspaceSnapshotMetadataV1Schema), ...errorResponses } },
	},
};
export const workspaceSnapshotSchemasV1 = { WorkspaceSnapshotBindingV1: WorkspaceSnapshotBindingV1Schema, WorkspaceSnapshotSourceV1: WorkspaceSnapshotSourceV1Schema, WorkspaceSnapshotMetadataV1: WorkspaceSnapshotMetadataV1Schema, WorkspaceSnapshotUploadRequestV1: WorkspaceSnapshotUploadRequestV1Schema };
