import {
	type AgentManagementDecisionV1,
	type AgentManagementStateV1,
	planAgentLifecycleCommandV1,
} from "./agent-management.js";
import {
	isAgentManagementText,
	parseAgentManagementPortState,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import type { ApiPrincipalV1 } from "./audit-query.js";
import { platformIdempotencyV1 } from "./idempotency.js";
import { PersonalApiCredentialErrorV1 } from "./personal-api-credentials.js";

export interface AgentApiLifecycleCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly command: "start" | "stop" | "restart";
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

/** Supplied by the Store's current credential and explicit manage-grant read. */
export interface AgentApiLifecycleAuthorityV1 {
	readonly principal: ApiPrincipalV1;
	readonly agentId: string;
	readonly manageGrantRevision: string;
}

export interface AgentApiLifecycleTransactionV1 {
	executeAgentApiLifecycleTransaction(
		request: {
			readonly command: AgentApiLifecycleCommandV1;
			readonly material: string;
			readonly requestDigest: string;
		},
		decide: (
			state: AgentManagementStateV1,
			authority: AgentApiLifecycleAuthorityV1,
		) => AgentManagementDecisionV1,
	): Promise<AgentManagementDecisionV1>;
}

export function parseAgentApiLifecycleCommandV1(
	input: unknown,
): AgentApiLifecycleCommandV1 {
	try {
		const value = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(value, [
			"schemaVersion",
			"agentId",
			"command",
			"idempotencyKey",
			"requestId",
			"traceId",
		]);
		if (
			value.schemaVersion !== 1 ||
			!isAgentManagementText(value.agentId) ||
			!isAgentManagementText(value.requestId) ||
			!isAgentManagementText(value.traceId) ||
			!isAgentManagementText(value.idempotencyKey, 128) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(value.idempotencyKey) ||
			!["start", "stop", "restart"].includes(value.command as string)
		)
			throw new Error();
		return Object.freeze(value) as unknown as AgentApiLifecycleCommandV1;
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

export function createAgentApiLifecycleV1(
	transaction: AgentApiLifecycleTransactionV1,
) {
	return {
		async execute(
			input: unknown,
			material: string,
		): Promise<AgentManagementDecisionV1> {
			const command = parseAgentApiLifecycleCommandV1(input);
			// Request correlation and credentials do not change a business request's identity.
			const requestDigest = platformIdempotencyV1.canonicalRequestDigest({
				schemaVersion: 1,
				agentId: command.agentId,
				command: command.command,
			});
			return transaction.executeAgentApiLifecycleTransaction(
				{ command, material, requestDigest },
				(stateInput, authorityInput) => {
					let state: AgentManagementStateV1;
					let authority: Record<string, unknown>;
					let principal: Record<string, unknown>;
					try {
						state = parseAgentManagementPortState(stateInput);
						authority = snapshotAgentManagementDataObject(authorityInput);
						requireAgentManagementExactKeys(authority, [
							"principal",
							"agentId",
							"manageGrantRevision",
						]);
						principal = snapshotAgentManagementDataObject(authority.principal);
						requireAgentManagementExactKeys(principal, ["kind", "id"]);
						if (
							authority.agentId !== command.agentId ||
							state.agentId !== command.agentId ||
							!isAgentManagementText(authority.manageGrantRevision) ||
							!isAgentManagementText(principal.id) ||
							(principal.kind !== "user" && principal.kind !== "application")
						)
							throw new Error();
					} catch {
						throw new PersonalApiCredentialErrorV1("unavailable");
					}
					if (command.command === "start" && state.status !== "stopped")
						return {
							outcome: "conflict",
							reason: "invalid_transition",
							writePlan: null,
						};
					const decision = planAgentLifecycleCommandV1(
						state,
						{
							...command,
							command:
								command.command === "stop" ? "stop_agent" : "restart_agent",
							expectedRevision: state.revision,
						},
						principal.id as string,
						requestDigest,
					);
					if (decision.outcome === "accepted")
						return {
							...decision,
							writePlan: {
								...decision.writePlan,
								auditEvent: {
									...decision.writePlan.auditEvent,
									actorType: principal.kind as "user" | "application",
								},
							},
						};
					return decision;
				},
			);
		},
	};
}

export type AgentApiLifecycleV1 = ReturnType<typeof createAgentApiLifecycleV1>;
