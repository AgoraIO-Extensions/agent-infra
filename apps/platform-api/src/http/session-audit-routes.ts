import {
	BrowserSessionProjectionV1Schema,
	PlatformAuditProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type PlatformAuditPageV1,
	PlatformAuditQueryError,
} from "@agent-infra/platform-store";
import type { Hono } from "hono";

import {
	HttpProtocolError,
	parsePageQuery,
	requestMetadata,
} from "./common.js";
import {
	hydrateBrowserUsers,
	type IdentityAdapter,
	resolveIdentity,
} from "./identity.js";

interface PlatformAuditQuery {
	listAudit(
		scope: {
			readonly schemaVersion: 1;
			readonly kind: "administrator";
			readonly administratorId: string;
		},
		page: {
			readonly schemaVersion: 1;
			readonly limit: number;
			readonly cursor?: string;
		},
	): Promise<PlatformAuditPageV1>;
}

export interface SessionAuditRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly audit: PlatformAuditQuery;
}

function mapAuditError(error: unknown, traceId: string): never {
	if (!(error instanceof PlatformAuditQueryError)) throw error;
	if (error.code === "invalid_request") {
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	}
	if (error.code === "access_denied") {
		throw new HttpProtocolError("FORBIDDEN", traceId);
	}
	throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
}

export function registerSessionAuditRoutes(
	app: Hono,
	dependencies: SessionAuditRoutesDependencies,
): void {
	app.get("/api/v1/session", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			metadata.traceId,
		);
		const projection = BrowserSessionProjectionV1Schema.safeParse({
			schemaVersion: 1,
			user: {
				userId: identity.userId,
				displayName: identity.displayName,
				roles: identity.roles,
			},
		});
		if (!projection.success) {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
		return context.json(projection.data);
	});

	app.get("/api/v1/admin/audit", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		const identity = await resolveIdentity(
			dependencies.identity,
			context.req.raw,
			metadata.traceId,
		);
		if (!identity.roles.includes("system_admin")) {
			throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
		}
		const page = parsePageQuery(context.req.raw, metadata.traceId);
		let auditPage: PlatformAuditPageV1;
		try {
			auditPage = await dependencies.audit.listAudit(
				{
					schemaVersion: 1,
					kind: "administrator",
					administratorId: identity.userId,
				},
				{
					schemaVersion: 1,
					limit: page.limit ?? 50,
					...(page.cursor === undefined ? {} : { cursor: page.cursor }),
				},
			);
		} catch (error) {
			mapAuditError(error, metadata.traceId);
		}

		try {
			if (auditPage.items.some(({ actor }) => actor.kind !== "user")) {
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
			const actorIds = [
				...new Set(auditPage.items.map(({ actor }) => actor.actorId)),
			];
			const actors = await hydrateBrowserUsers(
				dependencies.identity,
				actorIds,
				metadata.traceId,
			);
			const actorById = new Map(actors.map((actor) => [actor.userId, actor]));
			const items = auditPage.items.map((item) =>
				PlatformAuditProjectionV1Schema.parse({
					schemaVersion: 1,
					auditId: item.auditId,
					action: item.action,
					actor: actorById.get(item.actor.actorId),
					subjectType: item.subject.kind,
					subjectId: item.subject.subjectId,
					result: item.result,
					summary: item.summary,
					occurredAt: item.occurredAt.toISOString(),
					traceId: item.traceId,
				}),
			);
			return context.json({ items, nextCursor: auditPage.nextCursor });
		} catch (error) {
			if (error instanceof HttpProtocolError) throw error;
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
	});
}
