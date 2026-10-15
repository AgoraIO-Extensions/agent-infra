import type { AgentConfigurationError } from "./agent-configuration-types.js";
import type { ApiPrincipalV1 } from "./audit-query.js";
import type { PersonalApiCredentialErrorV1 } from "./personal-api-credentials.js";

export interface AgentApiAuditContextV1 {
	readonly principal?: ApiPrincipalV1;
	readonly agentId?: string;
	readonly command?:
		| "create"
		| "start"
		| "stop"
		| "restart"
		| "read_state"
		| "grant_manager"
		| "revoke_manager"
		| "grant_use"
		| "revoke_use";
}

// Refusal attribution never becomes an error payload, log field, or caller authority.
const contexts = new WeakMap<Error, AgentApiAuditContextV1>();

/**
 * 为 API 管理拒绝附加审计归属。除 API 凭证错误外，只接受需要保留专用 HTTP 错误码的
 * 配置终态拒绝（如多服务总量超限，#2396）。
 */
export function withAgentApiAuditContextV1<
	E extends PersonalApiCredentialErrorV1 | AgentConfigurationError,
>(error: E, context: AgentApiAuditContextV1): E {
	contexts.set(
		error,
		Object.freeze({
			...context,
			...(context.principal
				? { principal: Object.freeze({ ...context.principal }) }
				: {}),
		}),
	);
	return error;
}

export function readAgentApiAuditContextV1(
	error: unknown,
): AgentApiAuditContextV1 | undefined {
	return error instanceof Error ? contexts.get(error) : undefined;
}
