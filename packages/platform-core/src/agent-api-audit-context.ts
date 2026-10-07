import type { ApiPrincipalV1 } from "./audit-query.js";
import type { PersonalApiCredentialErrorV1 } from "./personal-api-credentials.js";

export interface AgentApiAuditContextV1 {
	readonly principal?: ApiPrincipalV1;
	readonly agentId?: string;
	readonly command?:
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

export function withAgentApiAuditContextV1(
	error: PersonalApiCredentialErrorV1,
	context: AgentApiAuditContextV1,
) {
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
