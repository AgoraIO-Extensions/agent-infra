import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { AgentLifecycleWorkflow } from "../agent-administration/agent-lifecycle-workflow.js";
import { useBrowserSession } from "../use-browser-session.js";
import { isAgentConfigurationOwner } from "./agent-configuration.js";
import { AgentConfigurationScreen } from "./agent-configuration-screen.js";
import { useAgentConfigurationSubmission } from "./use-agent-configuration-submission.js";
import { useAgentDefaultRelayKeyState } from "./use-agent-default-relay-key-state.js";

type AgentConfigurationWorkflowProps = {
	agent: AgentProjectionV2;
};

export function AgentConfigurationWorkflow({
	agent,
}: AgentConfigurationWorkflowProps) {
	const session = useBrowserSession();
	const submission = useAgentConfigurationSubmission(agent.agentId);
	const commandError =
		submission.isError && submission.error instanceof Error
			? submission.error
			: null;
	const isConfigurationOwner =
		session.state.kind === "ready" &&
		isAgentConfigurationOwner(agent, session.state.session);
	const isSystemAdministrator =
		session.state.kind === "ready" &&
		session.state.session.user.roles.includes("system_admin");
	// 只有 Owner 能读取默认 Key 状态；`isSet` 表示模型由默认 Key 管理（#2421）。
	const defaultRelayKey = useAgentDefaultRelayKeyState(
		agent.agentId,
		isConfigurationOwner && agent.source.kind === "standard",
	);
	const lifecycle = (
		<AgentLifecycleWorkflow key={agent.agentId} agent={agent} />
	);

	return (
		<>
			<AgentConfigurationScreen
				lifecycle={isConfigurationOwner ? lifecycle : undefined}
				agent={agent}
				commandError={commandError}
				commandResult={submission.data}
				defaultRelayKeyManaged={defaultRelayKey.data?.isSet === true}
				key={agent.agentId}
				onSave={submission.saveConfiguration}
				onPreviewDefaultRelayKeyCandidates={
					submission.previewDefaultRelayKeyCandidates
				}
				onReplaceDefaultRelayKey={submission.replaceDefaultRelayKey}
				relayKeyError={submission.relayKeyError}
				relayKeyResult={submission.relayKeyResult}
				relayKeySubmitting={submission.relayKeySubmitting}
				onUpgradeImage={submission.upgradeImage}
				session={session.state}
				submitting={submission.isPending}
			/>
			{isSystemAdministrator && !isConfigurationOwner ? (
				<div className="form-layout">
					<aside className="form-aside">{lifecycle}</aside>
				</div>
			) : null}
		</>
	);
}
