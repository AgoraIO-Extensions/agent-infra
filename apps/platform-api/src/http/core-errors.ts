import {
	AgentConfigurationError,
	AgentDefaultRelayKeyErrorV1,
	AgentManagementError,
	ApiIdentityError,
	ApplicationFoundationError,
	ApplicationRevisionError,
	PersonalRelayKeyErrorV1,
} from "@agent-infra/platform-core";

import { HttpProtocolError } from "./common.js";

export function mapCoreError(
	error: unknown,
	traceId: string,
): HttpProtocolError {
	if (error instanceof HttpProtocolError) return error;
	if (error instanceof AgentDefaultRelayKeyErrorV1)
		return new HttpProtocolError(
			error.code === "not_authorized"
				? "RESOURCE_UNAVAILABLE"
				: error.code === "invalid_model"
					? "INVALID_REQUEST"
					: error.code === "conflict"
						? "CONFLICT"
						: "DEPENDENCY_UNAVAILABLE",
			traceId,
		);
	if (error instanceof PersonalRelayKeyErrorV1) {
		if (error.code === "invalid_key")
			return new HttpProtocolError(
				"INVALID_REQUEST",
				traceId,
				"Relay Key was rejected. Check it and try again.",
			);
		return new HttpProtocolError(
			error.code === "not_authorized"
				? "FORBIDDEN"
				: error.code === "conflict"
					? "CONFLICT"
					: "DEPENDENCY_UNAVAILABLE",
			traceId,
		);
	}
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
	if (error instanceof ApiIdentityError) {
		return new HttpProtocolError(
			error.code === "not_authorized"
				? "FORBIDDEN"
				: error.code === "idempotency_conflict"
					? "CONFLICT"
					: error.code === "resource_unavailable"
						? "RESOURCE_UNAVAILABLE"
						: "DEPENDENCY_UNAVAILABLE",
			traceId,
		);
	}
	return new HttpProtocolError("INTERNAL_ERROR", traceId);
}
