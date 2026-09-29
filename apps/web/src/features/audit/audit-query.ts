import { OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	ScopedPlatformAuditPageV1Schema,
	type ScopedPlatformAuditProjectionV1,
	ScopedPlatformAuditProjectionV1Schema,
	ScopedPlatformAuditQueryV1Schema,
} from "@agent-infra/contracts/pilot";

export type AuditScope = "own" | "administrator";
export type AuditFilters = {
	from?: string;
	until?: string;
	principalKind?: "user" | "application";
	principalId?: string;
	agentId?: string;
	action?: AuditRecord["action"];
	result?: AuditRecord["result"];
	executionId?: string;
};
export type AuditRecord = ScopedPlatformAuditProjectionV1;
export type AuditReadFailure = {
	kind: "authorization" | "network" | "service" | "http" | "invalid";
};

export class AuditReadError extends Error {
	constructor(readonly failure: AuditReadFailure) {
		super("Audit data is unavailable");
		this.name = "AuditReadError";
	}
}

type AuditReadInput = {
	scope: AuditScope;
	filters?: AuditFilters;
	signal: AbortSignal;
	transport?: typeof globalThis.fetch;
	baseUrl?: string;
};

function throwIfAborted(signal: AbortSignal) {
	if (signal.aborted)
		throw signal.reason instanceof Error
			? signal.reason
			: new DOMException("The operation was aborted", "AbortError");
}

function queryInput(
	filters: AuditFilters = {},
	pagination?: { limit: number; cursor?: string },
) {
	if (Boolean(filters.principalKind) !== Boolean(filters.principalId))
		throw new AuditReadError({ kind: "invalid" });
	const parsed = ScopedPlatformAuditQueryV1Schema.safeParse({
		...filters,
		...pagination,
	});
	if (!parsed.success) throw new AuditReadError({ kind: "invalid" });
	return parsed.data;
}

function requestUrl(
	scope: AuditScope,
	filters: ReturnType<typeof queryInput>,
	baseUrl?: string,
	auditId?: string,
) {
	const origin =
		baseUrl ??
		(typeof globalThis.location?.origin === "string"
			? globalThis.location.origin
			: "http://localhost");
	const path =
		scope === "administrator" ? "/api/v3/admin/audit" : "/api/v1/audit";
	const url = new URL(
		`${path}${auditId ? `/${encodeURIComponent(auditId)}` : ""}`,
		origin,
	);
	for (const [key, value] of Object.entries(filters)) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	return url;
}

function failureForStatus(status: number): AuditReadFailure {
	return {
		kind: [401, 403, 404].includes(status)
			? "authorization"
			: status >= 500
				? "service"
				: status >= 400
					? "http"
					: "invalid",
	};
}

async function readJson(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	throwIfAborted(signal);
	if (response.status !== 200)
		throw new AuditReadError(failureForStatus(response.status));
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new AuditReadError({ kind: "invalid" });
	}
	throwIfAborted(signal);
	return body;
}

async function request(
	input: AuditReadInput,
	filters: ReturnType<typeof queryInput>,
	auditId?: string,
) {
	throwIfAborted(input.signal);
	const transport = input.transport ?? globalThis.fetch;
	try {
		const response = await transport(
			requestUrl(input.scope, filters, input.baseUrl, auditId),
			{
				method: "GET",
				credentials: "same-origin",
				signal: input.signal,
				headers: { accept: "application/json" },
			},
		);
		return await readJson(response, input.signal);
	} catch (error) {
		throwIfAborted(input.signal);
		if (error instanceof AuditReadError) throw error;
		throw new AuditReadError({ kind: "network" });
	}
}

/** The server resolves the browser identity and current access for each read. */
export async function loadAuditPage({
	scope,
	filters,
	cursor = null,
	signal,
	transport,
	baseUrl,
}: AuditReadInput & { cursor?: string | null }) {
	const query = queryInput(filters, {
		limit: 25,
		...(cursor == null ? {} : { cursor }),
	});
	const parsed = ScopedPlatformAuditPageV1Schema.safeParse(
		await request({ scope, filters, signal, transport, baseUrl }, query),
	);
	if (
		!parsed.success ||
		parsed.data.items.length > 25 ||
		(parsed.data.nextCursor !== null && parsed.data.nextCursor === cursor)
	)
		throw new AuditReadError({ kind: "invalid" });
	return parsed.data;
}

export async function loadAuditDetail({
	scope,
	filters,
	auditId,
	signal,
	transport,
	baseUrl,
}: AuditReadInput & { auditId: string }) {
	throwIfAborted(signal);
	if (!OpaqueIdV1Schema.safeParse(auditId).success)
		throw new AuditReadError({ kind: "invalid" });
	const query = queryInput(filters);
	const parsed = ScopedPlatformAuditProjectionV1Schema.safeParse(
		await request(
			{ scope, filters, signal, transport, baseUrl },
			query,
			auditId,
		),
	);
	if (!parsed.success || parsed.data.auditId !== auditId)
		throw new AuditReadError({ kind: "invalid" });
	return parsed.data;
}
