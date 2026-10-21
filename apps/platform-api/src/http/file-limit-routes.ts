import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	FileLimitDeclarationResponseV1Schema,
	FileLimitDeclarationWriteRequestV1Schema,
} from "@agent-infra/contracts/files";
import type {
	FileLimitDeclarationRecordV1,
	FileLimitDeclarationSubjectV1,
} from "@agent-infra/platform-core";
import type { Context, Hono } from "hono";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./common.js";
import { mapCoreError } from "./core-errors.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./identity.js";

export interface FileLimitRoutesDependenciesV1 {
	readonly identity: IdentityAdapter;
	/** Authorization is part of the Core use case; the route only forwards the actor. */
	readonly read: (
		identity: IdentityContext,
		subject: FileLimitDeclarationSubjectV1,
	) => Promise<FileLimitDeclarationRecordV1 | null>;
	readonly write: (
		identity: IdentityContext,
		subject: FileLimitDeclarationSubjectV1,
		input: {
			readonly declaration: unknown;
			readonly expectedRevision: number | null;
			readonly idempotencyKey: string;
		},
	) => Promise<FileLimitDeclarationRecordV1>;
}

function response(record: FileLimitDeclarationRecordV1) {
	const parsed = FileLimitDeclarationResponseV1Schema.safeParse({
		schemaVersion: 1,
		declaration: {
			schemaVersion: 1,
			scope: record.scope,
			revision: record.revision,
			expiresAt: record.expiresAt,
			mediaTypes: record.mediaTypes,
			maxBytes: record.maxBytes,
			updatedAt: record.updatedAt,
			updatedBy: record.updatedBy,
		},
	});
	if (!parsed.success) throw new Error("Invalid file limit declaration");
	return parsed.data;
}

function pathId(context: Context, name: string, traceId: string): string {
	const parsed = OpaqueIdV1Schema.safeParse(context.req.param(name));
	if (!parsed.success) throw new HttpProtocolError("INVALID_REQUEST", traceId);
	return parsed.data;
}

/**
 * Management surface for the three authoritative FileLimits declarations.
 * The Actor is always resolved server-side; declarations never accept an owner
 * or organization from the request body.
 */
export function registerFileLimitRoutesV2(
	app: Hono,
	dependencies: FileLimitRoutesDependenciesV1,
): void {
	async function handle(
		context: Context,
		action: "read" | "write",
		subject: (traceId: string) => FileLimitDeclarationSubjectV1,
	) {
		const metadata = requestMetadata(context.req.raw);
		context.header("Cache-Control", "no-store");
		try {
			if (context.req.raw.headers.has("authorization"))
				throw new HttpProtocolError(
					"AUTHENTICATION_REQUIRED",
					metadata.traceId,
				);
			if (new URL(context.req.raw.url).search !== "")
				throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
			const identity = await resolveIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			const target = subject(metadata.traceId);
			if (action === "read") {
				if (context.req.raw.body !== null)
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				const declaration = await dependencies.read(identity, target);
				if (!declaration)
					throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
				return context.json(response(declaration));
			}
			const idempotencyKey = parseIdempotencyKey(
				context.req.raw,
				metadata.traceId,
			);
			const { value } = await parseJson(
				context.req.raw,
				FileLimitDeclarationWriteRequestV1Schema,
				metadata.traceId,
			);
			const declaration = await dependencies.write(identity, target, {
				declaration: value.declaration,
				expectedRevision: value.expectedRevision,
				idempotencyKey,
			});
			return context.json(response(declaration));
		} catch (error) {
			const protocol = mapCoreError(error, metadata.traceId);
			return context.json(protocol.body, protocol.status);
		}
	}

	app.get("/api/v2/agents/:agentId/file-limits", (context) =>
		handle(context, "read", (traceId) => ({
			scope: "agent",
			agentId: pathId(context, "agentId", traceId),
		})),
	);
	app.put("/api/v2/agents/:agentId/file-limits", (context) =>
		handle(context, "write", (traceId) => ({
			scope: "agent",
			agentId: pathId(context, "agentId", traceId),
		})),
	);
	app.get(
		"/api/v2/agents/:agentId/channels/:channelId/file-limits",
		(context) =>
			handle(context, "read", (traceId) => ({
				scope: "channel",
				agentId: pathId(context, "agentId", traceId),
				channelId: pathId(context, "channelId", traceId),
			})),
	);
	app.put(
		"/api/v2/agents/:agentId/channels/:channelId/file-limits",
		(context) =>
			handle(context, "write", (traceId) => ({
				scope: "channel",
				agentId: pathId(context, "agentId", traceId),
				channelId: pathId(context, "channelId", traceId),
			})),
	);
	app.get("/api/v2/admin/deployment/file-limits", (context) =>
		handle(context, "read", () => ({ scope: "deployment" })),
	);
	app.put("/api/v2/admin/deployment/file-limits", (context) =>
		handle(context, "write", () => ({ scope: "deployment" })),
	);
}
