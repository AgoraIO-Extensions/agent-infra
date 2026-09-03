import {
	BrowserSessionProjectionV1Schema,
	PlatformAuditProjectionV1Schema,
	PlatformAuditProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import {
	type PlatformAuditPageV1,
	PlatformAuditQueryError,
} from "@agent-infra/platform-store";
import type { Hono } from "hono";

import {
	HttpProtocolError,
	parsePageQuery,
	type RequestMetadata,
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
	if (
		error instanceof PlatformAuditQueryError &&
		error.code === "invalid_request"
	) {
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	}
	if (
		error instanceof PlatformAuditQueryError &&
		error.code === "access_denied"
	) {
		throw new HttpProtocolError("FORBIDDEN", traceId);
	}
	throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
}

async function readAuditPage(
	dependencies: SessionAuditRoutesDependencies,
	request: Request,
	metadata: RequestMetadata,
): Promise<PlatformAuditPageV1> {
	const identity = await resolveIdentity(
		dependencies.identity,
		request,
		metadata.traceId,
	);
	if (!identity.roles.includes("system_admin")) {
		throw new HttpProtocolError("FORBIDDEN", metadata.traceId);
	}
	const page = parsePageQuery(request, metadata.traceId);
	try {
		return await dependencies.audit.listAudit(
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
}

function publicAuditFields(item: PlatformAuditPageV1["items"][number]) {
	return {
		auditId: item.auditId,
		action: item.action,
		subjectType: item.subject.kind,
		subjectId: item.subject.subjectId,
		result: item.result,
		summary: item.summary,
		occurredAt: item.occurredAt.toISOString(),
		traceId: item.traceId,
	};
}

async function hydrateAuditUsers(
	dependencies: SessionAuditRoutesDependencies,
	items: PlatformAuditPageV1["items"],
	traceId: string,
) {
	const actorIds = [
		...new Set(
			items
				.filter(({ actor }) => actor.kind === "user")
				.map(({ actor }) => actor.actorId),
		),
	];
	if (actorIds.length === 0) return new Map();
	const actors = await hydrateBrowserUsers(
		dependencies.identity,
		actorIds,
		traceId,
	);
	return new Map(actors.map((actor) => [actor.userId, actor]));
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
		const auditPage = await readAuditPage(
			dependencies,
			context.req.raw,
			metadata,
		);

		try {
			if (auditPage.items.some(({ actor }) => actor.kind !== "user")) {
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			}
			const actorById = await hydrateAuditUsers(
				dependencies,
				auditPage.items,
				metadata.traceId,
			);
			const items = auditPage.items.map((item) =>
				PlatformAuditProjectionV1Schema.parse({
					schemaVersion: 1,
					...publicAuditFields(item),
					actor: actorById.get(item.actor.actorId),
				}),
			);
			return context.json({ items, nextCursor: auditPage.nextCursor });
		} catch (error) {
			if (error instanceof HttpProtocolError) throw error;
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
	});

	app.get("/api/v2/admin/audit", async (context) => {
		const metadata = requestMetadata(context.req.raw);
		const auditPage = await readAuditPage(
			dependencies,
			context.req.raw,
			metadata,
		);

		try {
			const actorById = await hydrateAuditUsers(
				dependencies,
				auditPage.items,
				metadata.traceId,
			);
			const items = auditPage.items.map((item) =>
				PlatformAuditProjectionV2Schema.parse({
					schemaVersion: 2,
					...publicAuditFields(item),
					actor:
						item.actor.kind === "system"
							? { kind: "system", actorId: item.actor.actorId }
							: actorById.get(item.actor.actorId),
				}),
			);
			return context.json({ items, nextCursor: auditPage.nextCursor });
		} catch {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
	});
}
