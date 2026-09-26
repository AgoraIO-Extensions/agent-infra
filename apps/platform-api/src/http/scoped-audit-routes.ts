import {
	ScopedPlatformAuditPageV1Schema,
	ScopedPlatformAuditProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type ApiPrincipalV1,
	type PlatformAuditQueryDenialReasonV1,
	type PlatformAuditQueryScopeV1,
	PlatformAuditScopeErrorV1,
	parsePlatformAuditQueryScopeV1,
	platformAuditQueryDenialReasonsV1,
} from "@agent-infra/platform-core";
import type { PostgresScopedPlatformAuditQueryV1 } from "@agent-infra/platform-store";
import type { Hono } from "hono";
import {
	HttpProtocolError,
	type RequestMetadata,
	requestMetadata,
} from "./common.js";
import {
	type IdentityAdapter,
	resolveApiIdentity,
	resolveCurrentTaskUser,
	resolveIdentity,
} from "./identity.js";

export interface ScopedAuditRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly audit: Pick<
		PostgresScopedPlatformAuditQueryV1,
		"listAudit" | "getAudit" | "recordDeniedQuery"
	>;
}

async function queryScope(
	identity: IdentityAdapter,
	request: Request,
	administrator: boolean,
	traceId: string,
	capturePrincipal: (principal: ApiPrincipalV1) => void,
): Promise<PlatformAuditQueryScopeV1> {
	if (administrator) {
		const user = await resolveIdentity(identity, request, traceId);
		capturePrincipal({ kind: "user", id: user.userId });
		if (!user.roles.includes("system_admin"))
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
		return parsePlatformAuditQueryScopeV1({
			kind: "administrator",
			administratorId: user.userId,
		});
	}
	if (request.headers.has("authorization")) {
		const subject = await resolveApiIdentity(identity, request, traceId);
		capturePrincipal({ ...subject.principal });
		const user =
			subject.principal.kind === "user"
				? await resolveCurrentTaskUser(identity, subject.principal.id, traceId)
				: undefined;
		return parsePlatformAuditQueryScopeV1({
			kind: "execution",
			principal: subject.principal,
			credential: subject.credential,
			...(user !== undefined ? { user } : {}),
		});
	}
	const browser = await resolveIdentity(identity, request, traceId);
	capturePrincipal({ kind: "user", id: browser.userId });
	const user = await resolveCurrentTaskUser(identity, browser.userId, traceId);
	return parsePlatformAuditQueryScopeV1({
		kind: "execution",
		principal: { kind: "user", id: browser.userId },
		user,
	});
}

async function auditedQueryScope(
	dependencies: ScopedAuditRoutesDependencies,
	request: Request,
	administrator: boolean,
	operation: "list" | "detail",
	metadata: RequestMetadata,
) {
	let principal: ApiPrincipalV1 | null = null;
	try {
		return await queryScope(
			dependencies.identity,
			request,
			administrator,
			metadata.traceId,
			(resolved) => {
				principal = resolved;
			},
		);
	} catch (error) {
		const reason: PlatformAuditQueryDenialReasonV1 =
			error instanceof PlatformAuditScopeErrorV1
				? error.code
				: error instanceof HttpProtocolError
					? (platformAuditQueryDenialReasonsV1.find(
							(reason) => reason === error.body.code,
						) ?? "DEPENDENCY_UNAVAILABLE")
					: "DEPENDENCY_UNAVAILABLE";
		const rejected =
			(error instanceof HttpProtocolError && error.status < 500) ||
			(error instanceof PlatformAuditScopeErrorV1 &&
				error.code !== "unavailable");
		try {
			await dependencies.audit.recordDeniedQuery(
				{
					principal,
					requestedScope: administrator ? "administrator" : "execution",
					operation,
					result: rejected ? "rejected" : "failed",
					reason,
				},
				metadata,
			);
		} catch {
			throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
		}
		throw error;
	}
}

/** Preserve invalid fields for the domain rejection and its bounded query audit. */
function queryInput(request: Request, defaultLimit = 50) {
	const search = new URL(request.url).searchParams;
	const value = Object.fromEntries(search);
	const { limit, cursor, principalKind, principalId, ...filters } = value;
	return {
		limit: limit === undefined ? defaultLimit : Number(limit),
		...(cursor !== undefined ? { cursor } : {}),
		filters: {
			...filters,
			...(principalKind !== undefined || principalId !== undefined
				? { principal: { kind: principalKind, id: principalId } }
				: {}),
		},
		...(new Set(search.keys()).size !== [...search.keys()].length
			? { duplicateParameters: true }
			: {}),
	};
}

function protocolError(error: unknown, traceId: string): never {
	if (error instanceof HttpProtocolError) throw error;
	if (error instanceof PlatformAuditScopeErrorV1) {
		if (error.code === "invalid_request")
			throw new HttpProtocolError("INVALID_REQUEST", traceId);
		if (error.code === "access_denied")
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
	}
	throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
}

type StoredAudit = Awaited<
	ReturnType<PostgresScopedPlatformAuditQueryV1["getAudit"]>
>;

function publicRecord(record: StoredAudit) {
	return ScopedPlatformAuditProjectionV1Schema.parse({
		...record,
		occurredAt: record.occurredAt.toISOString(),
	});
}

export function registerScopedAuditRoutes(
	app: Hono,
	dependencies: ScopedAuditRoutesDependencies,
) {
	for (const [path, administrator] of [
		["/api/v1/audit", false],
		["/api/v3/admin/audit", true],
	] as const) {
		app.get(path, async (context) => {
			const request = context.req.raw;
			const metadata = requestMetadata(request);
			try {
				const scope = await auditedQueryScope(
					dependencies,
					request,
					administrator,
					"list",
					metadata,
				);
				const page = await dependencies.audit.listAudit(
					scope,
					queryInput(request),
					metadata,
				);
				return context.json(
					ScopedPlatformAuditPageV1Schema.parse({
						items: page.items.map(publicRecord),
						nextCursor: page.nextCursor,
					}),
				);
			} catch (error) {
				protocolError(error, metadata.traceId);
			}
		});
		app.get(`${path}/:auditId`, async (context) => {
			const request = context.req.raw;
			const metadata = requestMetadata(request);
			try {
				const scope = await auditedQueryScope(
					dependencies,
					request,
					administrator,
					"detail",
					metadata,
				);
				const item = await dependencies.audit.getAudit(
					scope,
					context.req.param("auditId"),
					queryInput(request, 1),
					metadata,
				);
				return context.json(publicRecord(item));
			} catch (error) {
				protocolError(error, metadata.traceId);
			}
		});
	}
}
