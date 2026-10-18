import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { AgentLifecycleWorkflow } from "../agent-administration/agent-lifecycle-workflow.js";
import { useBrowserSession } from "../use-browser-session.js";
import { AgentAuthorizationControls } from "./agent-authorization-controls.js";
import { isAgentConfigurationOwner } from "./agent-configuration.js";
import { AgentConfigurationScreen } from "./agent-configuration-screen.js";
import type { KeylessModelCandidate } from "./keyless-model-selection.js";
import { useAgentConfigurationSubmission } from "./use-agent-configuration-submission.js";
import { useAgentDefaultRelayKeyState } from "./use-agent-default-relay-key-state.js";
import { useAgentSavedRelayKeyCandidates } from "./use-agent-saved-relay-key-candidates.js";

type AgentConfigurationWorkflowProps = {
	agent: AgentProjectionV2;
	deploymentModelCandidates?: readonly KeylessModelCandidate[];
};

export function AgentConfigurationWorkflow({
	agent,
	deploymentModelCandidates,
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
	const defaultRelayKeyManaged = defaultRelayKey.data?.isSet === true;
	const savedRelayKeyCandidates = useAgentSavedRelayKeyCandidates(
		agent.agentId,
		isConfigurationOwner &&
			agent.source.kind === "standard" &&
			defaultRelayKeyManaged,
	);
	const ownerLifecycle = isConfigurationOwner ? (
		<AgentLifecycleWorkflow
			key={`${agent.agentId}:owner`}
			agent={agent}
			scope="owner"
		/>
	) : undefined;
	const administratorLifecycle = isSystemAdministrator ? (
		<AgentLifecycleWorkflow
			key={`${agent.agentId}:administrator`}
			agent={agent}
			description="停用将撤销运行资格。Owner 不能恢复，个人历史仍保留。"
			heading="管理员操作"
			scope="administrator"
		/>
	) : undefined;
	const authorization = (
		<AgentAuthorizationControls
			key={agent.agentId}
			agentId={agent.agentId}
			enabled={isConfigurationOwner || isSystemAdministrator}
		/>
	);

	return (
		<>
			<AgentConfigurationScreen
				lifecycle={ownerLifecycle}
				agent={agent}
				deploymentModelCandidates={deploymentModelCandidates}
				authorization={isConfigurationOwner ? authorization : undefined}
				commandError={commandError}
				commandResult={submission.data}
				defaultRelayKeyManaged={defaultRelayKeyManaged}
				savedRelayKeyCandidates={savedRelayKeyCandidates.data?.candidates}
				savedRelayKeyConfigurationRevision={
					savedRelayKeyCandidates.data?.configurationRevision
				}
				savedRelayKeyVersion={savedRelayKeyCandidates.data?.keyVersion}
				savedRelayKeyCandidatesLoading={
					defaultRelayKeyManaged && savedRelayKeyCandidates.isFetching
				}
				savedRelayKeyCandidatesError={
					savedRelayKeyCandidates.isError &&
					savedRelayKeyCandidates.error instanceof Error
						? savedRelayKeyCandidates.error
						: null
				}
				onRetrySavedRelayKeyCandidates={() =>
					void savedRelayKeyCandidates.refetch()
				}
				key={agent.agentId}
				onSave={submission.saveConfiguration}
				onSaveAndWait={submission.saveConfigurationAndWait}
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
			{isSystemAdministrator ? (
				isConfigurationOwner ? (
					<section
						aria-label="管理员操作"
						className="detail-section administrator-lifecycle-panel"
					>
						{administratorLifecycle}
					</section>
				) : (
					<div className="form-layout">
						<div className="min-w-0 space-y-6">{authorization}</div>
						<aside className="form-aside">{administratorLifecycle}</aside>
					</div>
				)
			) : null}
		</>
	);
}
