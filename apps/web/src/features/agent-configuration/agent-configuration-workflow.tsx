import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { AgentCreationFailureNotice } from "../my-agents/agent-creation-failure.js";
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
	/**
	 * Agent 读自服务端管理员投影（系统管理员不在使用范围内，#3033）：Agent 详情对其不可见，
	 * 返回链接改为 Agent 管理。
	 */
	administratorProjection?: boolean;
	allowedEnvironmentKeys?: readonly string[];
	allowedSecretKeys?: readonly string[];
	deploymentModelCandidates?: readonly KeylessModelCandidate[];
	endpointNames?: KeylessEndpointNames;
	/** 重新读取 Agent 详情；用户 API 授权变更后取最新管理修订号（#3070）。 */
	onAgentChanged?: () => void;
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
	administratorProjection = false,
	allowedEnvironmentKeys,
	allowedSecretKeys,
	deploymentModelCandidates,
	endpointNames,
	onAgentChanged,
}: AgentConfigurationWorkflowProps) {
	const session = useBrowserSession();
	const submission = useAgentConfigurationSubmission(agent.agentId);
	// 整页只有一个生命周期 mutation，页脚、危险区与管理员区共享进行中状态（NI-88）。
	const lifecycle = useConfigurationLifecycle(agent, session.state);
	// 整页保存与镜像升级共用一个 mutation（同一时刻只有一个在途），进行中与失败按命令种类分开：
	// 「保存中…」与 fieldset 禁用只属于配置保存，镜像升级的进行中与失败只在「镜像升级」分区内
	// （#3268 N8-2-06）。
	const pendingKind = submission.isPending
		? submission.variables?.kind
		: undefined;
	const failedKind = submission.isError
		? submission.variables?.kind
		: undefined;
	const commandError =
		failedKind === "configuration" ? requestFailure(submission.error) : null;
	const imageError =
		failedKind === "image" ? requestFailure(submission.error) : null;
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
	// API 与应用授权只由当前 Owner 治理（PRD §7.3、工程 Spec §9.2），服务端拒绝非 Owner 的管理员；
	// 纯管理员视图因此不显示授权控制，只显示服务端允许的管理员操作（#3033 AC-2）。
	const authorization = (
		<AgentAuthorizationControls
			agentId={agent.agentId}
			enabled={isConfigurationOwner}
			managementRevision={agent.managementRevision}
			onChanged={onAgentChanged}
		/>
	);
	const afterForm = (
		<>
			<ConfigurationStopDangerZone lifecycle={lifecycle} />
			<ConfigurationAdministratorActions lifecycle={lifecycle} />
		</>
	);
	// 创建失败时向 Owner 与系统管理员说明失败类别（#3034）；是否可读仍由服务端判定。
	const showCreationFailure =
		agent.managementStatus === "creation_failed" &&
		(isConfigurationOwner || isSystemAdministrator);

	if (!isConfigurationOwner && isSystemAdministrator) {
		return (
			<AgentAdministratorConfigurationScreen
				agent={agent}
				afterForm={
					<>
						{/* 纯管理员视图的提示紧跟权限边界说明，间距与说明之间一致（#3152）。 */}
						{showCreationFailure ? (
							<AgentCreationFailureNotice
								agentId={agent.agentId}
								className="configuration-creation-failure"
							/>
						) : null}
						{afterForm}
					</>
				}
				back={administratorProjection ? "admin" : "detail"}
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
				// 页脚在整页 fieldset 之外（#3242 K7-02）：配置保存进行中与 Agent 已停用时仍原生禁用，
				// 与原先随 fieldset 禁用一致。
				<ConfigurationFooterLifecycleActions
					disabled={
						submission.isPending || agent.managementStatus === "disabled"
					}
					lifecycle={lifecycle}
				/>
			}
			footerFeedback={
				<>
					{showCreationFailure ? (
						<AgentCreationFailureNotice agentId={agent.agentId} />
					) : null}
					<ConfigurationFooterLifecycleFailure lifecycle={lifecycle} />
				</>
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
			imageError={imageError}
			onUpgradeImage={submission.upgradeImage}
			session={session.state}
			submitting={pendingKind === "configuration"}
			upgradingImage={pendingKind === "image"}
		/>
	);
}
