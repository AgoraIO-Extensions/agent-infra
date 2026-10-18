import { isAgentManagementText } from "./agent-management-input.js";
import {
	type AgentUserUseRevokeCommandV1,
	parseAgentUserUseRevokeCommandV1,
} from "./agent-user-use-grants.js";
import { PersonalApiCredentialErrorV1 } from "./personal-api-credentials.js";

/**
 * 当前 Owner 经浏览器会话给用户授予或撤销某个 Agent 的 API 管理权（#2759）。命令形状与用户
 * API 使用授权相同：目标用户、期望的 Agent 管理修订与幂等键；授权类型由路由决定，不由调用方提交。
 */
export type AgentUserManageGrantCommandV1 = AgentUserUseRevokeCommandV1;

export interface AgentUserManageGrantResultV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly userId: string;
	readonly granted: boolean;
	readonly authorizationRevision: string | null;
	readonly replayed: boolean;
}

export function parseAgentUserManageGrantCommandV1(
	input: unknown,
): AgentUserManageGrantCommandV1 {
	return parseAgentUserUseRevokeCommandV1(input);
}

/**
 * 纯状态转换与审计计划；Store 只在锁定的事务里落库。撤销管理权只影响之后的生命周期命令，
 * 不像撤销使用权那样控制已受理任务（工程 Spec §9.2）。
 */
export function planAgentUserManageGrantV1(input: {
	readonly command: AgentUserManageGrantCommandV1;
	readonly granted: boolean;
	readonly current: {
		readonly granted: boolean;
		readonly authorizationRevision: string;
	} | null;
	readonly replayed: boolean;
	readonly nextRevision: string;
	readonly occurredAt: Date;
}) {
	const command = parseAgentUserManageGrantCommandV1(input.command);
	if (
		typeof input.granted !== "boolean" ||
		typeof input.replayed !== "boolean" ||
		!isAgentManagementText(input.nextRevision) ||
		!Number.isFinite(Date.prototype.getTime.call(input.occurredAt)) ||
		(input.current &&
			(typeof input.current.granted !== "boolean" ||
				!isAgentManagementText(input.current.authorizationRevision)))
	)
		throw new PersonalApiCredentialErrorV1("unavailable");
	// 与使用授权一致：撤销从未授予过的管理权是不存在的目标。
	if (!input.granted && !input.current)
		throw new PersonalApiCredentialErrorV1("not_found");
	const mutation =
		input.replayed || (input.current?.granted ?? false) === input.granted
			? "none"
			: input.granted
				? "grant"
				: "revoke";
	const authorizationRevision =
		mutation === "none"
			? (input.current?.authorizationRevision ?? null)
			: input.nextRevision;
	const result: AgentUserManageGrantResultV1 = {
		schemaVersion: 1,
		agentId: command.agentId,
		userId: command.userId,
		granted: input.granted,
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
				? "api.agent.manager.replayed"
				: input.granted
					? "api.agent.manager.granted"
					: "api.agent.manager.revoked",
			targetType: "agent" as const,
			targetId: command.agentId,
			outcome: "succeeded" as const,
			occurredAt: new Date(input.occurredAt),
			details: {
				userId: command.userId,
				grantType: "manage" as const,
				granted: input.granted,
				authorizationRevision,
			},
		},
	};
}
