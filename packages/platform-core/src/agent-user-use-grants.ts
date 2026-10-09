import type { AgentManagementStateV1 } from "./agent-management.js";
import {
	isAgentManagementText,
	parseAgentManagementPortState,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import { PersonalApiCredentialErrorV1 } from "./personal-api-credentials.js";
import { parseCurrentTaskUserV1 } from "./task-authorization.js";

export interface AgentUserUseRevokeCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly userId: string;
	readonly actorId: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface AgentUserUseRevokeResultV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly userId: string;
	readonly granted: false;
	readonly authorizationRevision: string | null;
	readonly replayed: boolean;
}

export function parseAgentUserUseRevokeCommandV1(
	input: unknown,
): AgentUserUseRevokeCommandV1 {
	try {
		const values = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(values, [
			"schemaVersion",
			"agentId",
			"userId",
			"actorId",
			"idempotencyKey",
			"requestId",
			"traceId",
		]);
		if (
			values.schemaVersion !== 1 ||
			![
				values.agentId,
				values.userId,
				values.actorId,
				values.requestId,
				values.traceId,
			].every((value) => isAgentManagementText(value)) ||
			!isAgentManagementText(values.idempotencyKey, 128) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(values.idempotencyKey)
		)
			throw new Error();
		return Object.freeze(values) as unknown as AgentUserUseRevokeCommandV1;
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

export function requireAgentUserUseRevokeAuthorityV1(input: {
	readonly command: AgentUserUseRevokeCommandV1;
	readonly state: AgentManagementStateV1;
	readonly actor: unknown;
	readonly actorDisabled: boolean;
}): string {
	try {
		const command = parseAgentUserUseRevokeCommandV1(input.command);
		const actor = parseCurrentTaskUserV1(input.actor);
		const state = parseAgentManagementPortState(input.state);
		if (
			actor.userId !== command.actorId ||
			input.actorDisabled ||
			actor.accountStatus !== "active" ||
			!state.ownerIds.includes(actor.userId) ||
			state.agentId !== command.agentId ||
			![
				"creating",
				"available",
				"stopped",
				"creation_failed",
				"disabled",
			].includes(state.status)
		)
			throw new PersonalApiCredentialErrorV1("not_found");
		return actor.authorizationRevision;
	} catch (error) {
		if (error instanceof PersonalApiCredentialErrorV1) throw error;
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}

export function planAgentUserUseRevokeV1(input: {
	readonly command: AgentUserUseRevokeCommandV1;
	readonly current: {
		readonly granted: boolean;
		readonly authorizationRevision: string;
	} | null;
	readonly replayed: boolean;
	readonly nextRevision: string;
	readonly occurredAt: Date;
}) {
	const command = parseAgentUserUseRevokeCommandV1(input.command);
	if (
		!isAgentManagementText(input.nextRevision) ||
		!Number.isFinite(input.occurredAt.getTime()) ||
		(input.current &&
			(typeof input.current.granted !== "boolean" ||
				!isAgentManagementText(input.current.authorizationRevision)))
	)
		throw new PersonalApiCredentialErrorV1("unavailable");
	if (!input.current) throw new PersonalApiCredentialErrorV1("not_found");
	const mutation = input.replayed || !input.current.granted ? "none" : "revoke";
	const result: AgentUserUseRevokeResultV1 = {
		schemaVersion: 1,
		agentId: command.agentId,
		userId: command.userId,
		granted: false,
		authorizationRevision:
			mutation === "none"
				? input.current.authorizationRevision
				: input.nextRevision,
		replayed: input.replayed,
	};
	return {
		mutation,
		result,
		occurredAt: new Date(input.occurredAt),
		audit: {
			requestId: command.requestId,
			traceId: command.traceId,
			agentId: command.agentId,
			actorType: "user" as const,
			actorId: command.actorId,
			action: input.replayed
				? "api.agent.use.replayed"
				: "api.agent.use.revoked",
			targetType: "agent" as const,
			targetId: command.agentId,
			outcome: "succeeded" as const,
			occurredAt: new Date(input.occurredAt),
			details: {
				userId: command.userId,
				grantType: "use",
				granted: false,
				authorizationRevision: result.authorizationRevision,
			},
		},
	};
}
