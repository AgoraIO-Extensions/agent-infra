import { type ReactNode, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useResultFocus } from "@/hooks/use-result-focus";

import type {
	AgentApiLifecycleAcceptedResponseV1,
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type { BrowserSessionState } from "../browser-session.js";
import type {
	AgentDefaultRelayKeyCheck,
	AgentDefaultRelayKeyState,
	AgentSavedModelConfigurationUpdate,
} from "./agent-configuration.js";
import { isAgentConfigurationOwner } from "./agent-configuration.js";
import {
	agentConfigurationDraftChanged,
	buildAgentConfigurationRequest,
	configurationDraftFromAgent,
} from "./agent-configuration-draft.js";
import { ConfigurationImageSection } from "./configuration-image-section.js";
import { configurationHeadingId } from "./configuration-lifecycle.js";
import { ConfigurationModelSection } from "./configuration-model-section.js";
import { ConfigurationPageHeading } from "./configuration-page-heading.js";
import {
	ConfigurationAvailabilitySection,
	ConfigurationCoOwnerSection,
} from "./configuration-scope-sections.js";
import { ConfigurationSecretsSection } from "./configuration-secrets-section.js";
import {
	ConfigurationWecomSection,
	type WecomChannelKind,
} from "./configuration-wecom-section.js";
import type { KeylessModelCandidate } from "./keyless-model-selection.js";
import { useKeylessKeyCheck } from "./use-keyless-key-check.js";

type ConfigurationSessionState = BrowserSessionState | { kind: "loading" };

type AgentConfigurationScreenProps = {
	agent: AgentProjectionV2;
	/** 表单卡内的首个分区（Agent 授权控制）。 */
	authorization?: ReactNode;
	/** 表单卡之后的独立区域：Owner 危险区与管理员操作区。 */
	afterForm?: ReactNode;
	commandError?: (Error & { readonly retryable?: boolean }) | null;
	commandResult?: AgentProjectionV2 | AgentApiLifecycleAcceptedResponseV1;
	/** 页脚保存按钮之后的操作（重启 Agent、重试创建）。 */
	footerActions?: ReactNode;
	/** 页脚操作的反馈（例如生命周期命令失败）。 */
	footerFeedback?: ReactNode;
	onSave: (
		body:
			| AgentConfigurationUpdateRequestV2Writable
			| AgentSavedModelConfigurationUpdate,
	) => void;
	/** 企微渠道独立解绑请求；不经过整页保存（O-01）。 */
	onUnbindChannel?: (kind: WecomChannelKind) => Promise<void>;
	/** Agent 由默认 Relay Key 管理模型（配置 V3）：用候选模型选择代替自由文本字段。 */
	defaultRelayKeyManaged?: boolean;
	/** Deployment catalog candidates for non-Key-managed Agents. */
	deploymentModelCandidates?: readonly KeylessModelCandidate[];
	/** Read-only candidates from the already persisted default Relay Key. */
	savedRelayKeyCandidates?: readonly KeylessModelCandidate[];
	savedRelayKeyConfigurationRevision?: number;
	savedRelayKeyVersion?: number;
	savedRelayKeyCandidatesError?: Error | null;
	savedRelayKeyCandidatesLoading?: boolean;
	onRetrySavedRelayKeyCandidates?: () => void;
	onPreviewDefaultRelayKeyCandidates?: (
		keyValue: string,
	) => Promise<AgentDefaultRelayKeyCheck>;
	onReplaceDefaultRelayKey?: (keyValue: string) => void;
	/** 返回 true 表示镜像升级已被受理。 */
	onUpgradeImage: (imageReference: string) => Promise<boolean> | undefined;
	relayKeyError?: Error | null;
	/** 仅替换 Key 成功后的状态。 */
	relayKeyResult?: AgentDefaultRelayKeyState;
	relayKeySubmitting?: boolean;
	session: ConfigurationSessionState;
	submitting: boolean;
};

function unavailableScreen() {
	return (
		<section aria-labelledby={configurationHeadingId} className="space-y-4">
			<h1 id={configurationHeadingId} className="font-semibold text-[28px]">
				配置不可用
			</h1>
			<Alert tone="warn">
				<AlertDescription>当前无法访问此配置。</AlertDescription>
			</Alert>
		</section>
	);
}

/**
 * 纯系统管理员的配置页（N-02）：与 Owner 相同的页头与权限边界，下面只有授权控制与
 * 管理员操作区；不显示 Owner 才能编辑的配置。
 */
export function AgentAdministratorConfigurationScreen({
	agent,
	afterForm,
	authorization,
}: {
	agent: AgentProjectionV2;
	afterForm?: ReactNode;
	authorization?: ReactNode;
}) {
	return (
		<section
			aria-labelledby={configurationHeadingId}
			className="agent-configuration"
		>
			<ConfigurationPageHeading agent={agent} />
			{authorization ? (
				<div className="configuration-form-card">{authorization}</div>
			) : null}
			{afterForm}
		</section>
	);
}

export function AgentConfigurationScreen({
	agent,
	afterForm,
	authorization,
	commandError = null,
	commandResult,
	defaultRelayKeyManaged = false,
	deploymentModelCandidates,
	footerActions,
	footerFeedback,
	savedRelayKeyCandidates,
	savedRelayKeyConfigurationRevision,
	savedRelayKeyVersion,
	savedRelayKeyCandidatesError = null,
	savedRelayKeyCandidatesLoading = false,
	onSave,
	onRetrySavedRelayKeyCandidates,
	onPreviewDefaultRelayKeyCandidates,
	onReplaceDefaultRelayKey,
	onUnbindChannel,
	onUpgradeImage,
	relayKeyError = null,
	relayKeyResult,
	relayKeySubmitting = false,
	session,
	submitting,
}: AgentConfigurationScreenProps) {
	const [draft, setDraft] = useState(() => configurationDraftFromAgent(agent));
	const [ownerError, setOwnerError] = useState<string>();
	const [catalogSelectionError, setCatalogSelectionError] = useState(false);
	const [savedSelectionError, setSavedSelectionError] = useState(false);
	const keyCheck = useKeylessKeyCheck(onPreviewDefaultRelayKeyCandidates);
	const submittedResult =
		commandResult?.agentId === agent.agentId ? commandResult : undefined;
	const resultRef = useResultFocus(submittedResult);
	if (
		session.kind !== "ready" ||
		!isAgentConfigurationOwner(agent, session.session)
	) {
		return unavailableScreen();
	}

	const isDisabled = submitting || agent.managementStatus === "disabled";
	// 目录缺少 Owner 记录或读取失败时，chip 仍显示 Agent 投影中的 Owner 显示名。
	const ownerLabels = Object.fromEntries(
		agent.configuration.owners.map((owner) => [
			owner.userId,
			owner.displayName,
		]),
	);
	// 正在替换默认 Key（已输入或已检查）也算改动：保存时要引导用户先完成检查（#2560）。
	const hasChanges =
		agentConfigurationDraftChanged(agent, draft) ||
		keyCheck.typed ||
		Boolean(keyCheck.replacement);
	const submitConfiguration = () => {
		if (
			!defaultRelayKeyManaged &&
			draft.replaceModels &&
			(deploymentModelCandidates === undefined ||
				deploymentModelCandidates.length === 0 ||
				catalogSelectionError)
		) {
			setCatalogSelectionError(true);
			return;
		}
		const request = buildAgentConfigurationRequest(draft);
		if (!request.coOwnerIds?.length) {
			setOwnerError("请选择至少一名有效 Owner。");
			document.getElementById("configuration-owner-ids")?.focus();
			return;
		}
		setOwnerError(undefined);
		// 已经开始替换默认 Key：必须完成检查并选好模型，不能退回普通保存而静默丢掉用户正在
		// 编辑的 Key 和模型集合。
		if (defaultRelayKeyManaged && keyCheck.typed && !keyCheck.replacement) {
			keyCheck.block();
			document.getElementById("configuration-default-relay-key")?.focus();
			return;
		}
		if (
			defaultRelayKeyManaged &&
			!keyCheck.typed &&
			savedRelayKeyCandidates !== undefined &&
			draft.replaceModels &&
			savedSelectionError
		) {
			return;
		}
		setDraft((current) => ({
			...current,
			secrets: [],
		}));
		const savedKeyExpectation =
			defaultRelayKeyManaged &&
			!keyCheck.typed &&
			savedRelayKeyCandidates !== undefined &&
			savedRelayKeyConfigurationRevision !== undefined &&
			savedRelayKeyVersion !== undefined &&
			draft.replaceModels
				? {
						expectedConfigurationRevision: savedRelayKeyConfigurationRevision,
						expectedKeyVersion: savedRelayKeyVersion,
						schemaVersion: 4 as const,
					}
				: undefined;
		// 填写了 Key 并选好模型：与页面其他修改一起，Key、模型集合和配置修订一次保存。
		if (defaultRelayKeyManaged && keyCheck.replacement) {
			onSave({
				...request,
				schemaVersion: 2,
				defaultRelayKey: keyCheck.replacement.defaultRelayKey,
				expectedConfigurationRevision:
					keyCheck.replacement.expectedConfigurationRevision,
				expectedKeyVersion: keyCheck.replacement.expectedKeyVersion,
				modelConfiguration: keyCheck.replacement.modelConfiguration,
			});
			keyCheck.reset();
			return;
		}
		if (savedKeyExpectation && request.modelConfiguration) {
			onSave({
				...request,
				schemaVersion: 4,
				expectedConfigurationRevision:
					savedKeyExpectation.expectedConfigurationRevision,
				expectedKeyVersion: savedKeyExpectation.expectedKeyVersion,
			});
			return;
		}
		onSave(request);
	};

	return (
		<section
			aria-labelledby={configurationHeadingId}
			className="agent-configuration"
		>
			<ConfigurationPageHeading agent={agent} />
			{/* 设计 .surface 表单卡：分区之间只有一条分隔线，没有额外外边距（O-03）。 */}
			<div className="configuration-form-card">
				{authorization}
				{submittedResult ? (
					<p
						ref={resultRef}
						tabIndex={-1}
						className="configuration-card-feedback font-medium text-foreground text-sm"
						role="status"
					>
						配置已提交：
						{
							agentManagementStatusLabels[
								"managementStatus" in submittedResult
									? submittedResult.managementStatus
									: (submittedResult.status ?? agent.managementStatus)
							]
						}
						。
					</p>
				) : null}
				{commandError ? (
					<Alert
						tone="danger"
						role="alert"
						className="configuration-card-feedback"
					>
						<AlertDescription>
							{commandError.retryable === false
								? "权限或 Agent 状态已变化，请刷新页面。"
								: "配置未能保存，请重新填写 Secret 或模型凭证后再试。"}
						</AlertDescription>
					</Alert>
				) : null}
				{submittedResult ? (
					// 保存结果替换表单期间，页脚的生命周期操作仍可达（O-11）。
					footerActions || footerFeedback ? (
						<div className="form-footer configuration-form-footer">
							<div className="configuration-footer-actions">
								{footerActions}
							</div>
							{footerFeedback}
						</div>
					) : null
				) : (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							if (isDisabled) return;
							submitConfiguration();
						}}
					>
						<fieldset
							disabled={isDisabled}
							className="min-w-0"
							aria-label="Agent 配置"
						>
							<ConfigurationCoOwnerSection
								disabled={isDisabled}
								error={ownerError}
								fallbackLabels={ownerLabels}
								value={draft.coOwnerIds}
								onChange={(value) => {
									setDraft((current) => ({
										...current,
										coOwnerIds: value,
									}));
									setOwnerError(undefined);
								}}
							/>
							<ConfigurationAvailabilitySection
								disabled={isDisabled}
								userIds={draft.userAvailabilityIds}
								organizationIds={draft.organizationAvailabilityIds}
								onUsersChange={(value) =>
									setDraft((current) => ({
										...current,
										userAvailabilityIds: value,
									}))
								}
								onOrganizationsChange={(value) =>
									setDraft((current) => ({
										...current,
										organizationAvailabilityIds: value,
									}))
								}
							/>
							{!(
								agent.source.kind === "custom" &&
								agent.source.interactionMode === "self-managed"
							) ? (
								<ConfigurationWecomSection
									agentId={agent.agentId}
									onUnbindChannel={onUnbindChannel}
								/>
							) : null}
							{agent.source.kind === "standard" ? (
								<ConfigurationModelSection
									agent={agent}
									defaultRelayKeyManaged={defaultRelayKeyManaged}
									deploymentModelCandidates={deploymentModelCandidates}
									draft={draft}
									isDisabled={isDisabled}
									keyCheck={keyCheck}
									onCatalogSelectionErrorChange={setCatalogSelectionError}
									onReplaceDefaultRelayKey={onReplaceDefaultRelayKey}
									onRetrySavedRelayKeyCandidates={
										onRetrySavedRelayKeyCandidates
									}
									onSavedSelectionErrorChange={setSavedSelectionError}
									relayKeyError={relayKeyError}
									relayKeyResult={relayKeyResult}
									relayKeySubmitting={relayKeySubmitting}
									savedRelayKeyCandidates={savedRelayKeyCandidates}
									savedRelayKeyCandidatesError={savedRelayKeyCandidatesError}
									savedRelayKeyCandidatesLoading={
										savedRelayKeyCandidatesLoading
									}
									savedSelectionError={savedSelectionError}
									setDraft={setDraft}
								/>
							) : null}
							<ConfigurationSecretsSection
								agent={agent}
								secrets={draft.secrets}
								onChange={(update) =>
									setDraft((current) => ({
										...current,
										secrets: update(current.secrets),
									}))
								}
							/>
							{agent.source.kind === "custom" ? (
								<ConfigurationImageSection
									agent={agent}
									disabled={isDisabled}
									onUpgradeImage={onUpgradeImage}
									submitting={submitting}
								/>
							) : null}
							<div className="form-footer configuration-form-footer">
								{hasChanges || isDisabled ? null : (
									<p
										className="text-muted-foreground text-sm"
										id="agent-configuration-unchanged"
									>
										没有需要保存的变更。
									</p>
								)}
								<div className="configuration-footer-actions">
									<Button
										aria-describedby={
											hasChanges ? undefined : "agent-configuration-unchanged"
										}
										disabled={isDisabled || !hasChanges}
										type="submit"
									>
										{submitting ? "校验并保存中…" : "校验并保存"}
									</Button>
									{footerActions}
								</div>
								{footerFeedback}
							</div>
						</fieldset>
					</form>
				)}
			</div>
			{afterForm}
		</section>
	);
}
