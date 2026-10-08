import {
	type AgentApiAuditContextV1,
	readAgentApiAuditContextV1,
} from "@agent-infra/platform-core";
import type { Context } from "hono";
import { HttpProtocolError, type RequestMetadata } from "./common.js";
import { mapCoreError } from "./core-errors.js";

export type ApiManagementRefusalRecorderV1 = (
	input: RequestMetadata & {
		readonly operation: "create" | "lifecycle" | "manager" | "use" | "state";
		readonly reason: string;
		readonly failed: boolean;
		readonly context?: AgentApiAuditContextV1;
	},
) => Promise<void>;

export async function apiManagementFailure(
	context: Context,
	error: unknown,
	metadata: RequestMetadata,
	operation: "create" | "lifecycle" | "manager" | "use" | "state",
	record: ApiManagementRefusalRecorderV1,
) {
	const protocol = mapCoreError(error, metadata.traceId);
	try {
		await record({
			...metadata,
			operation,
			context: readAgentApiAuditContextV1(error),
			reason:
				protocol.status === 401
					? "authentication_required"
					: protocol.status === 403
						? "forbidden"
						: protocol.status === 404
							? "not_found"
							: protocol.status === 409
								? "conflict"
								: protocol.status >= 500
									? "unavailable"
									: "invalid_input",
			failed: protocol.status >= 500,
		});
	} catch {
		const unavailable = new HttpProtocolError(
			"DEPENDENCY_UNAVAILABLE",
			metadata.traceId,
		);
		return context.json(unavailable.body, unavailable.status);
	}
	return context.json(protocol.body, protocol.status);
}

/** One API credential channel; neither a Cookie nor a caller identity can supplement it. */
export function requireApiManagementMaterial(
	request: Request,
	traceId: string,
): string {
	const match = /^Bearer (papi_[A-Za-z0-9_-]{43})$/i.exec(
		request.headers.get("Authorization") ?? "",
	);
	if (!match?.[1] || request.headers.has("Cookie"))
		throw new HttpProtocolError("AUTHENTICATION_REQUIRED", traceId);
	if (
		new URL(request.url).search ||
		[
			"x-user-id",
			"x-application-id",
			"x-principal",
			"x-principal-id",
			"x-role",
			"x-roles",
			"x-scope",
			"x-agent-id",
			"x-identity-context",
		].some((name) => request.headers.has(name))
	)
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	return match[1];
}
