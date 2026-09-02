import {
	AgentConfigurationError,
	AgentManagementError,
	ApplicationFoundationError,
	ApplicationRevisionError,
} from "@agent-infra/platform-core";

import { HttpProtocolError } from "./common.js";

export function mapCoreError(
	error: unknown,
	traceId: string,
): HttpProtocolError {
	if (error instanceof HttpProtocolError) return error;
	if (error instanceof ApplicationFoundationError) {
		if (error.code === "invalid_command")
			return new HttpProtocolError("INVALID_REQUEST", traceId);
		if (error.code === "not_authorized")
			return new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
		if (
			error.code === "not_admitted" ||
			error.code === "conflict" ||
			error.code === "idempotency_conflict"
		) {
			return new HttpProtocolError("CONFLICT", traceId);
		}
		return new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (error instanceof ApplicationRevisionError) {
		if (error.code === "invalid_command")
			return new HttpProtocolError("INVALID_REQUEST", traceId);
		if (error.code === "not_authorized")
			return new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
		if (
			error.code === "not_admitted" ||
			error.code === "no_change" ||
			error.code === "stale_revision" ||
			error.code === "idempotency_conflict"
		) {
			return new HttpProtocolError("CONFLICT", traceId);
		}
		return new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (error instanceof AgentConfigurationError) {
		if (error.code === "invalid_command")
			return new HttpProtocolError("INVALID_REQUEST", traceId);
		if (error.code === "not_authorized")
			return new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
		if (
			error.code === "not_admitted" ||
			error.code === "no_change" ||
			error.code === "stale_revision" ||
			error.code === "idempotency_conflict"
		) {
			return new HttpProtocolError("CONFLICT", traceId);
		}
		return new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (error instanceof AgentManagementError) {
		return new HttpProtocolError(
			error.code === "invalid_input"
				? "INVALID_REQUEST"
				: "DEPENDENCY_UNAVAILABLE",
			traceId,
		);
	}
	return new HttpProtocolError("INTERNAL_ERROR", traceId);
}
