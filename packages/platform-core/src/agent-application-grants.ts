import type { AgentManagementStateV1 } from "./agent-management.js";
import {
	isAgentManagementText,
	parseAgentManagementPortState,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import { PersonalApiCredentialErrorV1 } from "./personal-api-credentials.js";
import { parseCurrentTaskUserV1 } from "./task-authorization.js";

export interface AgentApplicationGrantCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly applicationId: string;
	readonly actorId: string;
	readonly granted: boolean;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}
export interface AgentApplicationGrantResultV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly applicationId: string;
	readonly granted: boolean;
	readonly authorizationRevision: string | null;
	readonly replayed: boolean;
}

export function parseAgentApplicationGrantCommandV1(
	input: unknown,
): AgentApplicationGrantCommandV1 {
	try {
		const values = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(values, [
			"schemaVersion",
			"agentId",
			"applicationId",
			"actorId",
			"granted",
			"idempotencyKey",
			"requestId",
			"traceId",
		]);
		if (
			values.schemaVersion !== 1 ||
			typeof values.granted !== "boolean" ||
			![
				values.agentId,
				values.applicationId,
				values.actorId,
				values.requestId,
				values.traceId,
			].every((value) => isAgentManagementText(value)) ||
			!isAgentManagementText(values.idempotencyKey, 128) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(values.idempotencyKey)
		)
			throw new Error();
		return Object.freeze(values) as unknown as AgentApplicationGrantCommandV1;
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

/** Current Owner governance independently controls application manage/use; no credential material authority. */
export function requireAgentApplicationGrantAuthorityV1(input: {
	readonly command: AgentApplicationGrantCommandV1;
	readonly state: AgentManagementStateV1 | undefined;
	readonly actor: unknown;
	readonly actorDisabled: boolean;
	readonly application: unknown | null;
}): string {
	try {
		const command = parseAgentApplicationGrantCommandV1(input.command);
		const actor = parseCurrentTaskUserV1(input.actor);
		if (
			actor.userId !== command.actorId ||
			typeof input.actorDisabled !== "boolean"
		)
			throw new Error();
		if (input.actorDisabled || actor.accountStatus !== "active")
			throw new PersonalApiCredentialErrorV1("forbidden");
		const state = input.state && parseAgentManagementPortState(input.state);
		if (
			!state ||
			state.agentId !== command.agentId ||
			!state.ownerIds.includes(actor.userId) ||
			![
				"creating",
				"available",
				"stopped",
				"creation_failed",
				"disabled",
			].includes(state.status)
		)
			throw new PersonalApiCredentialErrorV1("not_found");
		if (input.application === null)
			throw new PersonalApiCredentialErrorV1("not_found");
		const application = snapshotAgentManagementDataObject(input.application);
		requireAgentManagementExactKeys(application, [
			"id",
			"status",
			"authorizationRevision",
		]);
		if (
			application.id !== command.applicationId ||
			!isAgentManagementText(application.authorizationRevision) ||
			(application.status !== "active" && application.status !== "disabled")
		)
			throw new Error();
		if (command.granted && application.status !== "active")
			throw new PersonalApiCredentialErrorV1("forbidden");
		return actor.authorizationRevision;
	} catch (error) {
		if (error instanceof PersonalApiCredentialErrorV1) throw error;
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}

/** Pure transition and necessary audit plan; the Store only persists its locked result. */
export function planAgentApplicationGrantV1(input: {
	readonly command: AgentApplicationGrantCommandV1;
	readonly grantType: "manage" | "use";
	readonly current: {
		readonly granted: boolean;
		readonly authorizationRevision: string;
	} | null;
	readonly replayed: boolean;
	readonly nextRevision: string;
	readonly occurredAt: Date;
}) {
	const command = parseAgentApplicationGrantCommandV1(input.command);
	const grantType = input.grantType;
	const auditScope = grantType === "manage" ? "manager" : "use";
	if (
		!["manage", "use"].includes(grantType) ||
		typeof input.replayed !== "boolean" ||
		!isAgentManagementText(input.nextRevision) ||
		!Number.isFinite(Date.prototype.getTime.call(input.occurredAt)) ||
		(input.current &&
			(typeof input.current.granted !== "boolean" ||
				!isAgentManagementText(input.current.authorizationRevision)))
	)
		throw new PersonalApiCredentialErrorV1("unavailable");
	const mutation =
		input.replayed || (input.current?.granted ?? false) === command.granted
			? "none"
			: command.granted
				? "grant"
				: "revoke";
	const granted =
		mutation === "none" ? (input.current?.granted ?? false) : command.granted;
	const authorizationRevision =
		mutation === "none"
			? (input.current?.authorizationRevision ?? null)
			: input.nextRevision;
	const result: AgentApplicationGrantResultV1 = {
		schemaVersion: 1,
		agentId: command.agentId,
		applicationId: command.applicationId,
		granted,
		authorizationRevision,
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
				? `api.agent.${auditScope}.replayed`
				: command.granted
					? `api.agent.${auditScope}.granted`
					: `api.agent.${auditScope}.revoked`,
			targetType: "agent" as const,
			targetId: command.agentId,
			outcome: "succeeded" as const,
			occurredAt: new Date(input.occurredAt),
			details: {
				applicationId: command.applicationId,
				grantType,
				granted,
				authorizationRevision,
			},
		},
	};
}
