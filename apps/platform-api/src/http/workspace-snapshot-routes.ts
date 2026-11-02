import {
	WorkspaceSnapshotMetadataV1Schema,
	WorkspaceSnapshotUploadRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import type { WorkspaceSnapshotRecordV1 } from "@agent-infra/platform-core";
import type { Hono } from "hono";
import { requireApiCredentialMaterial } from "./agent-api-management-support.js";
import { HttpProtocolError, parseIdempotencyKey, requestMetadata } from "./common.js";

export interface WorkspaceSnapshotRouteDependenciesV1 {
	upload(input: { material: string; idempotencyKey: string; digest: string; source: unknown; body: ReadableStream<Uint8Array> }): Promise<{ record: WorkspaceSnapshotRecordV1; replayed: boolean }>;
	list(material: string): Promise<readonly WorkspaceSnapshotRecordV1[]>;
	get(material: string, snapshotId: string): Promise<WorkspaceSnapshotRecordV1 | null>;
	remove(material: string, snapshotId: string): Promise<WorkspaceSnapshotRecordV1>;
}

function projection(record: WorkspaceSnapshotRecordV1) {
	return WorkspaceSnapshotMetadataV1Schema.parse({
		snapshotId: record.snapshotId,
		digest: record.digest,
		sizeBytes: record.sizeBytes,
		unpackedSizeBytes: record.unpackedSizeBytes,
		fileCount: record.fileCount,
		mediaType: record.mediaType,
		source: record.source,
		createdAt: record.createdAt,
		status: record.status,
		bindings: [],
	});
}

export function registerWorkspaceSnapshotRoutesV1(app: Hono, dependencies: WorkspaceSnapshotRouteDependenciesV1) {
	app.post("/api/v2/workspace-snapshots", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		try {
			const material = requireApiCredentialMaterial(context.req.raw, metadata.traceId);
			if (context.req.header("content-type")?.split(";", 1)[0] !== "application/x-tar+gzip") throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const digest = context.req.header("x-content-sha256");
			if (!digest || !/^[a-f0-9]{64}$/.test(digest) || !context.req.raw.body) throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const parsed = WorkspaceSnapshotUploadRequestV1Schema.parse({ schemaVersion: 1 });
			const result = await dependencies.upload({ material, idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId), digest: `sha256:${digest}`, source: parsed.source, body: context.req.raw.body });
			return context.json(projection(result.record), result.replayed ? 200 : 201);
		} catch (error) {
			if (error instanceof HttpProtocolError) return context.json(error.body, error.status);
			return context.json(new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId).body, 503);
		}
	});
	app.get("/api/v2/workspace-snapshots", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		try { const material = requireApiCredentialMaterial(context.req.raw, metadata.traceId); return context.json((await dependencies.list(material)).map(projection), 200); }
		catch (error) { const protocol = error instanceof HttpProtocolError ? error : new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId); return context.json(protocol.body, protocol.status); }
	});
	app.get("/api/v2/workspace-snapshots/:snapshotId", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		try { const material = requireApiCredentialMaterial(context.req.raw, metadata.traceId); const value = await dependencies.get(material, context.req.param("snapshotId")); if (!value) throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId); return context.json(projection(value), 200); }
		catch (error) { const protocol = error instanceof HttpProtocolError ? error : new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId); return context.json(protocol.body, protocol.status); }
	});
	app.delete("/api/v2/workspace-snapshots/:snapshotId", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		try { const material = requireApiCredentialMaterial(context.req.raw, metadata.traceId); const value = await dependencies.remove(material, context.req.param("snapshotId")); return context.json(projection(value), 200); }
		catch (error) { const protocol = error instanceof HttpProtocolError ? error : new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId); return context.json(protocol.body, protocol.status); }
	});
}
