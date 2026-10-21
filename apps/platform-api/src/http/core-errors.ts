import {
	AgentConfigurationError,
	AgentManagementError,
	ApplicationFoundationError,
	ApplicationMaterialGrantErrorV1,
	ApplicationRegistrationErrorV1,
	ApplicationRevisionError,
	FileLimitDeclarationErrorV1,
	PersonalApiCredentialErrorV1,
	PersonalRelayKeyErrorV1,
	SkillHubAgentBindingErrorV1,
	SkillHubOperationErrorV1,
} from "@agent-infra/platform-core";

import { HttpProtocolError } from "./common.js";

export function mapCoreError(
	error: unknown,
	traceId: string,
): HttpProtocolError {
	if (error instanceof HttpProtocolError) return error;
	if (error instanceof FileLimitDeclarationErrorV1) {
		const codes = {
			invalid_input: "INVALID_REQUEST",
			forbidden: "AUTHORIZATION_REVOKED",
			conflict: "CONFLICT",
			unavailable: "DEPENDENCY_UNAVAILABLE",
		} as const;
		return new HttpProtocolError(codes[error.code], traceId);
	}
	if (error instanceof SkillHubOperationErrorV1) {
		const codes = {
			invalid_input: "INVALID_REQUEST",
			forbidden: "AUTHORIZATION_REVOKED",
			not_found: "RESOURCE_UNAVAILABLE",
			idempotency_conflict: "CONFLICT",
			version_conflict: "CONFLICT",
			invalid_transition: "CONFLICT",
			owner_cannot_review: "AUTHORIZATION_REVOKED",
			version_unavailable: "RESOURCE_UNAVAILABLE",
			unavailable: "DEPENDENCY_UNAVAILABLE",
		} as const;
		return new HttpProtocolError(codes[error.code], traceId);
	}
	if (error instanceof SkillHubAgentBindingErrorV1) {
		const codes = {
			invalid_input: "INVALID_REQUEST",
			not_authorized: "RESOURCE_UNAVAILABLE",
			not_admitted: "RESOURCE_UNAVAILABLE",
			stale_revision: "CONFLICT",
			idempotency_conflict: "CONFLICT",
			// 部署未配置 Agent Version 与非 Owner 同样不可用；版本不符只在 Owner 授权后出现。
			agent_version_unavailable: "RESOURCE_UNAVAILABLE",
			agent_version_mismatch: "CONFLICT",
			dependency_unavailable: "DEPENDENCY_UNAVAILABLE",
			persistence_failed: "DEPENDENCY_UNAVAILABLE",
		} as const;
		return new HttpProtocolError(codes[error.code], traceId);
	}
	if (error instanceof PersonalRelayKeyErrorV1) {
		const codes = {
			invalid_input: "INVALID_REQUEST",
			authentication_required: "AUTHENTICATION_REQUIRED",
			not_authorized: "AUTHORIZATION_REVOKED",
			conflict: "CONFLICT",
			unavailable: "DEPENDENCY_UNAVAILABLE",
		} as const;
		return new HttpProtocolError(codes[error.code], traceId);
	}
	if (
		error instanceof ApplicationMaterialGrantErrorV1 ||
		error instanceof PersonalApiCredentialErrorV1 ||
		error instanceof ApplicationRegistrationErrorV1
	) {
		const codes = {
			invalid_input: "INVALID_REQUEST",
			authentication_required: "AUTHENTICATION_REQUIRED",
			forbidden: "AUTHORIZATION_REVOKED",
			not_found: "RESOURCE_UNAVAILABLE",
			idempotency_conflict: "CONFLICT",
			unavailable: "DEPENDENCY_UNAVAILABLE",
		} as const;
		return new HttpProtocolError(codes[error.code], traceId);
	}
	if (error instanceof ApplicationFoundationError) {
		if (error.code === "model_profile_unsupported")
			return new HttpProtocolError("CODEX_MODEL_PROFILE_UNSUPPORTED", traceId);
		if (error.code === "resource_cap_exceeded")
			return new HttpProtocolError(
				"MULTI_SERVICE_RESOURCE_CAP_EXCEEDED",
				traceId,
			);
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
		if (error.code === "resource_cap_exceeded")
			return new HttpProtocolError(
				"MULTI_SERVICE_RESOURCE_CAP_EXCEEDED",
				traceId,
			);
		if (error.code === "invalid_command")
			return new HttpProtocolError("INVALID_REQUEST", traceId);
		if (error.code === "not_authorized")
			return new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
		if (
			error.code === "not_admitted" ||
			error.code === "no_change" ||
			error.code === "stale_revision" ||
			// Key 版本冲突与配置修订冲突在 Core/Store/审计里可区分；线上同为 409，处理方式相同：
			// 刷新后重新检查再提交（#2421）。
			error.code === "key_version_conflict" ||
			error.code === "idempotency_conflict"
		) {
			return new HttpProtocolError("CONFLICT", traceId);
		}
		return new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (error instanceof AgentConfigurationError) {
		if (error.code === "model_profile_unsupported")
			return new HttpProtocolError("CODEX_MODEL_PROFILE_UNSUPPORTED", traceId);
		if (error.code === "resource_cap_exceeded")
			return new HttpProtocolError(
				"MULTI_SERVICE_RESOURCE_CAP_EXCEEDED",
				traceId,
			);
		if (error.code === "invalid_command")
			return new HttpProtocolError("INVALID_REQUEST", traceId);
		if (error.code === "not_authorized")
			return new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
		if (
			error.code === "not_admitted" ||
			error.code === "no_change" ||
			error.code === "stale_revision" ||
			// Key 版本冲突与配置修订冲突在 Core/Store/审计里可区分；线上同为 409，处理方式相同：
			// 刷新后重新检查再提交（#2421）。
			error.code === "key_version_conflict" ||
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
