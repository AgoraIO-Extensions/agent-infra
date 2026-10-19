import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { useBrowserSession } from "../use-browser-session.js";
import { AgentAuthorizationControls } from "./agent-authorization-controls.js";
import {
	type AgentConfigurationRequestError,
	isAgentConfigurationOwner,
} from "./agent-configuration.js";
import {
	AgentAdministratorConfigurationScreen,
	AgentConfigurationScreen,
} from "./agent-configuration-screen.js";
import {
	ConfigurationAdministratorActions,
	ConfigurationFooterLifecycleActions,
	ConfigurationFooterLifecycleFailure,
	ConfigurationStopDangerZone,
	useConfigurationLifecycle,
} from "./configuration-lifecycle.js";
import type {
	KeylessEndpointNames,
	KeylessModelCandidate,
} from "./keyless-model-selection.js";
import { useAgentConfigurationSubmission } from "./use-agent-configuration-submission.js";
import { useAgentDefaultRelayKeyState } from "./use-agent-default-relay-key-state.js";
import { useAgentSavedRelayKeyCandidates } from "./use-agent-saved-relay-key-candidates.js";

type AgentConfigurationWorkflowProps = {
	agent: AgentProjectionV2;
	allowedEnvironmentKeys?: readonly string[];
	allowedSecretKeys?: readonly string[];
	deploymentModelCandidates?: readonly KeylessModelCandidate[];
	endpointNames?: KeylessEndpointNames;
};

function requestFailure(error: unknown) {
	return error instanceof Error
		? (error as AgentConfigurationRequestError)
		: null;
}

// 切换 Agent 时整页按 Agent 重新挂载：草稿、生命周期进行中状态与结果都不会带到另一个 Agent。
export function AgentConfigurationWorkflow(
	props: AgentConfigurationWorkflowProps,
) {
	return (
		<AgentConfigurationWorkflowContent key={props.agent.agentId} {...props} />
	);
}

function AgentConfigurationWorkflowContent({
	agent,
	allowedEnvironmentKeys,
	allowedSecretKeys,
	deploymentModelCandidates,
	endpointNames,
}: AgentConfigurationWorkflowProps) {
	const session = useBrowserSession();
	const submission = useAgentConfigurationSubmission(agent.agentId);
	// 整页只有一个生命周期 mutation，页脚、危险区与管理员区共享进行中状态（NI-88）。
	const lifecycle = useConfigurationLifecycle(agent, session.state);
	const commandError = submission.isError
		? requestFailure(submission.error)
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
	const authorization = (
		<AgentAuthorizationControls
			agentId={agent.agentId}
			enabled={isConfigurationOwner || isSystemAdministrator}
		/>
	);
	const afterForm = (
		<>
			<ConfigurationStopDangerZone lifecycle={lifecycle} />
			<ConfigurationAdministratorActions lifecycle={lifecycle} />
		</>
	);

	if (!isConfigurationOwner && isSystemAdministrator) {
		return (
			<AgentAdministratorConfigurationScreen
				agent={agent}
				authorization={authorization}
				afterForm={afterForm}
			/>
		);
	}

	return (
		<AgentConfigurationScreen
			afterForm={isConfigurationOwner ? afterForm : undefined}
			agent={agent}
			allowedEnvironmentKeys={allowedEnvironmentKeys}
			allowedSecretKeys={allowedSecretKeys}
			deploymentModelCandidates={deploymentModelCandidates}
			authorization={isConfigurationOwner ? authorization : undefined}
			commandError={commandError}
			// 镜像升级的受理结果只给 Toast，不当作配置保存结果（NW-16）。
			commandResult={
				submission.variables?.kind === "configuration"
					? submission.data
					: undefined
			}
			defaultRelayKeyActions={{
				check: submission.checkDefaultRelayKey,
				replaceKey: submission.replaceDefaultRelayKey,
				replaceKeyWithModels: submission.replaceDefaultRelayKeyWithModels,
			}}
			defaultRelayKeyManaged={defaultRelayKeyManaged}
			defaultRelayKeyState={defaultRelayKey.data}
			endpointNames={endpointNames}
			footerActions={
				<ConfigurationFooterLifecycleActions lifecycle={lifecycle} />
			}
			footerFeedback={
				<ConfigurationFooterLifecycleFailure lifecycle={lifecycle} />
			}
			savedRelayKeyCandidates={savedRelayKeyCandidates.data?.candidates}
			savedRelayKeyConfigurationRevision={
				savedRelayKeyCandidates.data?.configurationRevision
			}
			savedRelayKeyVersion={savedRelayKeyCandidates.data?.keyVersion}
			// 只在首次读取时显示加载态；窗口重新聚焦等后台刷新不再出现（RK2-05）。
			savedRelayKeyCandidatesLoading={
				defaultRelayKeyManaged &&
				(savedRelayKeyCandidates.isLoading ||
					(savedRelayKeyCandidates.isError &&
						savedRelayKeyCandidates.isFetching))
			}
			savedRelayKeyCandidatesError={
				savedRelayKeyCandidates.isError
					? requestFailure(savedRelayKeyCandidates.error)
					: null
			}
			onRetrySavedRelayKeyCandidates={() =>
				void savedRelayKeyCandidates.refetch()
			}
			onReloadSavedRelayKey={() => {
				void defaultRelayKey.refetch();
				void savedRelayKeyCandidates.refetch();
			}}
			onReplaceSecret={submission.replaceSecret}
			onSave={submission.saveConfiguration}
			onUnbindChannel={submission.unbindWecomChannel}
			onUpgradeImage={submission.upgradeImage}
			session={session.state}
			submitting={submission.isPending}
		/>
	);
}
