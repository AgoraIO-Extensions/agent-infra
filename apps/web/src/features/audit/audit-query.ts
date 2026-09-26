import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	ScopedPlatformAuditPageV1Schema,
	ScopedPlatformAuditProjectionV1Schema,
	ScopedPlatformAuditQueryV1Schema,
} from "@agent-infra/contracts/pilot";
import type { Client } from "../../pilot/generated/client/index.js";
import {
	getOwnExecutionAudit,
	getScopedAdministratorAudit,
	listOwnExecutionAudit,
	listScopedAdministratorAudit,
} from "../../pilot/generated/sdk.gen.js";
import type {
	ListOwnExecutionAuditData,
	ScopedPlatformAuditProjectionV1,
} from "../../pilot/generated/types.gen.js";

export type AuditScope = "own" | "administrator";
export type AuditFilters = Omit<
	NonNullable<ListOwnExecutionAuditData["query"]>,
	"limit" | "cursor"
>;
export type AuditRecord = ScopedPlatformAuditProjectionV1;
export type AuditReadFailure = {
	kind: "authorization" | "network" | "service" | "http" | "invalid";
};
export class AuditReadError extends Error {
	constructor(readonly failure: AuditReadFailure) {
		super("Audit data is unavailable");
	}
}

type AuditReadInput = {
	scope: AuditScope;
	filters?: AuditFilters;
	signal: AbortSignal;
	client?: Client;
};

function queryInput(
	filters: AuditFilters = {},
	pagination?: { limit: number; cursor?: string },
) {
	const parsed = ScopedPlatformAuditQueryV1Schema.safeParse({
		...filters,
		...pagination,
	});
	if (!parsed.success) throw new AuditReadError({ kind: "invalid" });
	return parsed.data;
}

function requireSuccess(status?: number): never {
	throw new AuditReadError({
		kind:
			status === undefined
				? "network"
				: [401, 403, 404].includes(status)
					? "authorization"
					: status >= 500
						? "service"
						: status >= 400
							? "http"
							: "invalid",
	});
}

/** Scope selects an endpoint; the server resolves identity and current access.
 * Raw protocol errors and transport messages never enter the query cache. */
export async function loadAuditPage({
	scope,
	filters,
	cursor = null,
	signal,
	client,
}: AuditReadInput & { cursor?: string | null }) {
	signal.throwIfAborted();
	const query = queryInput(filters, {
		limit: 25,
		...(cursor == null ? {} : { cursor }),
	});
	try {
		const result = await (scope === "administrator"
			? listScopedAdministratorAudit
			: listOwnExecutionAudit)({
			client,
			query,
			signal,
			responseStyle: "fields",
			throwOnError: false,
		});
		signal.throwIfAborted();
		if (!result.data || result.response?.status !== 200)
			requireSuccess(result.response?.status);
		const parsed = ScopedPlatformAuditPageV1Schema.safeParse(result.data);
		if (
			!parsed.success ||
			parsed.data.items.length > 25 ||
			(parsed.data.nextCursor !== null && parsed.data.nextCursor === cursor)
		)
			throw new AuditReadError({ kind: "invalid" });
		return parsed.data;
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof AuditReadError) throw error;
		throw new AuditReadError({ kind: "network" });
	}
}

export async function loadAuditDetail({
	scope,
	filters,
	auditId,
	signal,
	client,
}: AuditReadInput & { auditId: string }) {
	signal.throwIfAborted();
	if (!OpaqueIdV1Schema.safeParse(auditId).success)
		throw new AuditReadError({ kind: "invalid" });
	const query = queryInput(filters);
	try {
		const result = await (scope === "administrator"
			? getScopedAdministratorAudit
			: getOwnExecutionAudit)({
			client,
			path: { auditId },
			query,
			signal,
			responseStyle: "fields",
			throwOnError: false,
		});
		signal.throwIfAborted();
		if (!result.data || result.response?.status !== 200)
			requireSuccess(result.response?.status);
		const parsed = ScopedPlatformAuditProjectionV1Schema.safeParse(result.data);
		if (!parsed.success || parsed.data.auditId !== auditId)
			throw new AuditReadError({ kind: "invalid" });
		return parsed.data;
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof AuditReadError) throw error;
		throw new AuditReadError({ kind: "network" });
	}
}
