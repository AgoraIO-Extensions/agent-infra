import { CheckIcon, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

import type {
	AgentApiLifecycleAcceptedResponseV1,
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import type { BrowserSessionState } from "../browser-session.js";
import {
	type AgentConfigurationRequestError,
	type AgentDefaultRelayKeyState,
	type AgentSavedModelConfigurationUpdate,
	isAgentConfigurationOwner,
	isRetryableConfigurationError,
} from "./agent-configuration.js";
import {
	agentConfigurationDraftChanged,
	agentConfigurationEnvironmentChanged,
	buildAgentConfigurationRequest,
	configurationDraftFromAgent,
	configurationKeyError,
} from "./agent-configuration-draft.js";
import {
	ConfigurationDefaultRelayKeySection,
	type DefaultRelayKeyActions,
} from "./configuration-default-relay-key-section.js";
import { ConfigurationImageSection } from "./configuration-image-section.js";
import { configurationHeadingId } from "./configuration-lifecycle.js";
import { focusConfigurationModelPicker } from "./configuration-model-picker.js";
import {
	ConfigurationModelSection,
	catalogModelPickerId,
	savedModelPickerId,
} from "./configuration-model-section.js";
import { ConfigurationPageHeading } from "./configuration-page-heading.js";
import {
	ConfigurationAvailabilitySection,
	ConfigurationCoOwnerSection,
} from "./configuration-scope-sections.js";
import { ConfigurationSecretsSection } from "./configuration-secrets-section.js";
import { ConfigurationSkillSection } from "./configuration-skill-section.js";
import {
	ConfigurationWecomSection,
	type WecomChannelKind,
} from "./configuration-wecom-section.js";
import type {
	KeylessEndpointNames,
	KeylessModelCandidate,
} from "./keyless-model-selection.js";

type ConfigurationSessionState = BrowserSessionState | { kind: "loading" };

type ConfigurationSaveRequest =
	| AgentConfigurationUpdateRequestV2Writable
	| AgentSavedModelConfigurationUpdate;

type AgentConfigurationScreenProps = {
	agent: AgentProjectionV2;
	/** 表单卡内的首个分区（Agent 授权控制）。 */
	authorization?: ReactNode;
	/** 表单卡之后的独立区域：Owner 危险区与管理员操作区。 */
	afterForm?: ReactNode;
	/** 标准模板开放的环境变量键；自定义 Agent 或模板未读取时为 undefined。 */
	allowedEnvironmentKeys?: readonly string[];
	/** 标准模板开放的 Secret 键；自定义 Agent 或模板未读取时为 undefined。 */
	allowedSecretKeys?: readonly string[];
	commandError?: AgentConfigurationRequestError | null;
	commandResult?: AgentProjectionV2 | AgentApiLifecycleAcceptedResponseV1;
	/** 默认 Relay Key 的读写操作；提供时显示「Agent 默认 Relay Key」分区（标准模板）。 */
	defaultRelayKeyActions?: DefaultRelayKeyActions;
	/** Agent 由默认 Relay Key 管理模型（配置 V3）：用候选模型选择代替自由文本字段。 */
	defaultRelayKeyManaged?: boolean;
	/** 默认 Relay Key 状态（只显示是否已设置与版本，不含 Key 值）。 */
	defaultRelayKeyState?: AgentDefaultRelayKeyState;
	/** Deployment catalog candidates for non-Key-managed Agents. */
	deploymentModelCandidates?: readonly KeylessModelCandidate[];
	/** 端点 ID → 部署目录显示名（RK2-01）。 */
	endpointNames?: KeylessEndpointNames;
	/** 页脚保存按钮之后的操作（重启 Agent、重试创建）。 */
	footerActions?: ReactNode;
	/** 页脚操作的反馈（例如生命周期命令失败）。 */
	footerFeedback?: ReactNode;
	onSave: (body: ConfigurationSaveRequest) => void;
	/** 重新读取默认 Key 状态与已保存 Key 候选（保存冲突后，RK2-09）。 */
	onReloadSavedRelayKey?: () => void;
	/** 替换或添加单个 Secret 的独立请求（O-10）。 */
	onReplaceSecret?: (name: string, value: string) => Promise<AgentProjectionV2>;
	/** 企微渠道独立解绑请求；不经过整页保存（O-01）。 */
	onUnbindChannel?: (kind: WecomChannelKind) => Promise<void>;
	/** Read-only candidates from the already persisted default Relay Key. */
	savedRelayKeyCandidates?: readonly KeylessModelCandidate[];
	savedRelayKeyConfigurationRevision?: number;
	savedRelayKeyVersion?: number;
	savedRelayKeyCandidatesError?: AgentConfigurationRequestError | null;
	/** 只在首次读取时为真；后台刷新不显示加载态（RK2-05）。 */
	savedRelayKeyCandidatesLoading?: boolean;
	onRetrySavedRelayKeyCandidates?: () => void;
	/** 返回 true 表示镜像升级已被受理。 */
	onUpgradeImage: (imageReference: string) => Promise<boolean> | undefined;
	session: ConfigurationSessionState;
	submitting: boolean;
};

function unavailableScreen() {
	return (
		<section aria-labelledby={configurationHeadingId} className="space-y-4">
			{/* tabIndex=-1：读取失败后「重新登录」「重新加载配置」恢复到此状态时焦点落在标题上。 */}
			<h1
				id={configurationHeadingId}
				tabIndex={-1}
				className="font-semibold text-[28px]"
			>
				配置不可用
			</h1>
			<Alert tone="warn">
				<AlertDescription>当前无法访问此配置。</AlertDescription>
			</Alert>
		</section>
	);
}

/** 整页保存失败的文案按保存路径区分（RK2-09）；页面不出现「模型凭证」。 */
function saveFailure(
	error: AgentConfigurationRequestError,
	path: "configuration" | "saved-model",
) {
	if (path === "saved-model" && error.status === 409)
		return {
			text: "默认 Key 或配置已更新，请重新读取可用模型后再保存。",
			reload: true,
		};
	if (isRetryableConfigurationError(error))
		return {
			text:
				path === "saved-model"
					? "模型配置未能保存，请重试。"
					: "配置未能保存，请重试。",
			reload: false,
		};
	return { text: "权限或 Agent 状态已变化，请刷新页面。", reload: false };
}

/** 环境变量逐行校验：名称规则、模板开放的键、不能重复。 */
function environmentErrors(
	rows: readonly { name: string }[],
	allowedNames: readonly string[] | undefined,
) {
	const errors: Record<number, string> = {};
	const seen = new Set<string>();
	rows.forEach((row, index) => {
		const name = row.name.trim();
		const error =
			configurationKeyError(name, { kind: "environment", allowedNames }) ??
			(seen.has(name) ? "环境变量名不能重复。" : undefined);
		if (error) errors[index] = error;
		seen.add(name);
	});
	return errors;
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
	allowedEnvironmentKeys,
	allowedSecretKeys,
	authorization,
	commandError = null,
	commandResult,
	defaultRelayKeyActions,
	defaultRelayKeyManaged = false,
	defaultRelayKeyState,
	deploymentModelCandidates,
	endpointNames,
	footerActions,
	footerFeedback,
	savedRelayKeyCandidates,
	savedRelayKeyConfigurationRevision,
	savedRelayKeyVersion,
	savedRelayKeyCandidatesError = null,
	savedRelayKeyCandidatesLoading = false,
	onSave,
	onReloadSavedRelayKey,
	onReplaceSecret,
	onRetrySavedRelayKeyCandidates,
	onUnbindChannel,
	onUpgradeImage,
	session,
	submitting,
}: AgentConfigurationScreenProps) {
	const toast = useToast();
	const [draft, setDraft] = useState(() => configurationDraftFromAgent(agent));
	const [ownerError, setOwnerError] = useState<string>();
	const [catalogSelectionError, setCatalogSelectionError] = useState(false);
	const [savedSelectionError, setSavedSelectionError] = useState(false);
	const [showSelectionErrors, setShowSelectionErrors] = useState(false);
	const [envErrors, setEnvErrors] = useState<Record<number, string>>({});
	const [keyBusy, setKeyBusy] = useState(false);
	const [savePath, setSavePath] = useState<"configuration" | "saved-model">(
		"configuration",
	);
	// 保存成功后按新投影重建选择器。
	const [resetCount, setResetCount] = useState(0);
	const [focusUnchangedHint, setFocusUnchangedHint] = useState(false);
	const submittedResult =
		commandResult?.agentId === agent.agentId ? commandResult : undefined;
	const handledResult = useRef(submittedResult);

	// 保存成功：页面保留，以新投影重置草稿并给 Toast；不再用「配置已提交」替换表单（RK2-09）。
	useEffect(() => {
		if (!submittedResult || submittedResult === handledResult.current) return;
		handledResult.current = submittedResult;
		if ("configuration" in submittedResult)
			setDraft(configurationDraftFromAgent(submittedResult));
		setEnvErrors({});
		setShowSelectionErrors(false);
		setSavedSelectionError(false);
		setCatalogSelectionError(false);
		setResetCount((count) => count + 1);
		setFocusUnchangedHint(true);
		toast("配置已保存，Secret 值不会回显");
	}, [submittedResult, toast]);

	const isOwner =
		session.kind === "ready" &&
		isAgentConfigurationOwner(agent, session.session);
	const isDisabled = submitting || agent.managementStatus === "disabled";
	const hasChanges = isOwner && agentConfigurationDraftChanged(agent, draft);

	// 保存期间按钮被禁用、焦点会离开；完成后落到「没有需要保存的变更」，不落在 body。
	useEffect(() => {
		if (!focusUnchangedHint || submitting) return;
		setFocusUnchangedHint(false);
		document.getElementById("agent-configuration-unchanged")?.focus();
	}, [focusUnchangedHint, submitting]);

	if (!isOwner) return unavailableScreen();

	// 目录缺少 Owner 记录或读取失败时，chip 仍显示 Agent 投影中的 Owner 显示名。
	const ownerLabels = Object.fromEntries(
		agent.configuration.owners.map((owner) => [
			owner.userId,
			owner.displayName,
		]),
	);
	const savedPickerShown =
		defaultRelayKeyManaged &&
		savedRelayKeyCandidates !== undefined &&
		savedRelayKeyCandidates.length > 0;
	const submitConfiguration = () => {
		if (isDisabled || !hasChanges) return;
		const request = buildAgentConfigurationRequest(draft, agent);
		if (!request.coOwnerIds?.length) {
			setOwnerError("请选择至少一名有效 Owner。");
			document.getElementById("configuration-owner-ids")?.focus();
			return;
		}
		setOwnerError(undefined);
		// 部署目录模式：勾选了「替换模型配置」就必须给出有效选择。
		if (
			!defaultRelayKeyManaged &&
			draft.replaceModels &&
			(deploymentModelCandidates === undefined ||
				deploymentModelCandidates.length === 0 ||
				catalogSelectionError)
		) {
			setShowSelectionErrors(true);
			focusConfigurationModelPicker(catalogModelPickerId);
			return;
		}
		// 已保存 Key 模式：只有用户改过选择才校验并提交模型；未改动时不拦截其他字段（RK2-03）。
		if (savedPickerShown && draft.replaceModels && savedSelectionError) {
			setShowSelectionErrors(true);
			focusConfigurationModelPicker(savedModelPickerId);
			return;
		}
		if (agentConfigurationEnvironmentChanged(agent, draft)) {
			const errors = environmentErrors(
				draft.environment,
				allowedEnvironmentKeys,
			);
			setEnvErrors(errors);
			const first = Object.keys(errors)[0];
			if (first !== undefined) {
				document
					.getElementById(`configuration-environment-name-${first}`)
					?.focus();
				return;
			}
		} else {
			setEnvErrors({});
		}
		const modelConfiguration =
			savedPickerShown && !draft.replaceModels
				? undefined
				: request.modelConfiguration;
		const { modelConfiguration: _omitted, ...withoutModels } = request;
		if (
			savedPickerShown &&
			modelConfiguration &&
			savedRelayKeyConfigurationRevision !== undefined &&
			savedRelayKeyVersion !== undefined
		) {
			setSavePath("saved-model");
			onSave({
				...withoutModels,
				modelConfiguration,
				schemaVersion: 4,
				expectedConfigurationRevision: savedRelayKeyConfigurationRevision,
				expectedKeyVersion: savedRelayKeyVersion,
			});
			return;
		}
		setSavePath("configuration");
		onSave(
			modelConfiguration
				? { ...withoutModels, modelConfiguration }
				: withoutModels,
		);
	};
	const failure = commandError ? saveFailure(commandError, savePath) : null;

	return (
		<section
			aria-labelledby={configurationHeadingId}
			className="agent-configuration"
		>
			<ConfigurationPageHeading agent={agent} />
			{/* 设计 .surface 表单卡：分区之间只有一条分隔线，没有额外外边距（O-03）。 */}
			<div className="configuration-form-card">
				{authorization}
				<form
					onSubmit={(event) => {
						event.preventDefault();
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
						{agent.source.kind === "standard" ? (
							<ConfigurationModelSection
								key={resetCount}
								agent={agent}
								defaultRelayKeyManaged={defaultRelayKeyManaged}
								deploymentModelCandidates={deploymentModelCandidates}
								draft={draft}
								endpointNames={endpointNames}
								isDisabled={isDisabled}
								keyBusy={keyBusy}
								onCatalogSelectionErrorChange={setCatalogSelectionError}
								onRetrySavedRelayKeyCandidates={onRetrySavedRelayKeyCandidates}
								onSavedSelectionErrorChange={setSavedSelectionError}
								savedRelayKeyCandidates={savedRelayKeyCandidates}
								savedRelayKeyCandidatesError={savedRelayKeyCandidatesError}
								savedRelayKeyCandidatesLoading={savedRelayKeyCandidatesLoading}
								showSelectionErrors={showSelectionErrors}
								setDraft={setDraft}
							/>
						) : null}
						{agent.source.kind === "standard" && defaultRelayKeyActions ? (
							<ConfigurationDefaultRelayKeySection
								actions={defaultRelayKeyActions}
								agent={agent}
								disabled={isDisabled}
								endpointNames={endpointNames}
								keyState={defaultRelayKeyState}
								onBusyChange={setKeyBusy}
								savedCandidates={savedRelayKeyCandidates}
								savedCandidatesLoading={savedRelayKeyCandidatesLoading}
							/>
						) : null}
						{/* 设计 #owner-config 分区顺序：模型与凭证、Agent 默认 Relay Key 之后才是渠道。 */}
						{!(
							agent.source.kind === "custom" &&
							agent.source.interactionMode === "self-managed"
						) ? (
							<ConfigurationWecomSection
								agentId={agent.agentId}
								onUnbindChannel={onUnbindChannel}
							/>
						) : null}
						{/* 自有交互入口的自定义 Agent 是否开放 Skill 待产品确认，确认前不显示（O-02 待确认 7）。 */}
						{!(
							agent.source.kind === "custom" &&
							agent.source.interactionMode === "self-managed"
						) ? (
							<ConfigurationSkillSection agentId={agent.agentId} />
						) : null}
						<ConfigurationSecretsSection
							agent={agent}
							allowedEnvironmentKeys={allowedEnvironmentKeys}
							allowedSecretKeys={allowedSecretKeys}
							disabled={isDisabled}
							environment={draft.environment}
							environmentErrors={envErrors}
							onEnvironmentChange={(update) => {
								setEnvErrors({});
								setDraft((current) => ({
									...current,
									environment: update(current.environment),
								}));
							}}
							onReplaceSecret={onReplaceSecret}
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
							{failure ? (
								<Alert tone="danger" role="alert">
									<AlertDescription>{failure.text}</AlertDescription>
									{failure.reload && onReloadSavedRelayKey ? (
										<AlertAction>
											<Button
												type="button"
												variant="outline"
												onClick={onReloadSavedRelayKey}
											>
												<RefreshCw
													aria-hidden="true"
													data-icon="inline-start"
												/>
												重新读取可用模型
											</Button>
										</AlertAction>
									) : null}
								</Alert>
							) : null}
							{hasChanges || isDisabled ? null : (
								<p
									className="text-muted-foreground text-sm outline-none"
									id="agent-configuration-unchanged"
									tabIndex={-1}
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
									<CheckIcon aria-hidden="true" data-icon="inline-start" />
									{submitting ? "保存中…" : "保存配置"}
								</Button>
								{footerActions}
							</div>
							{footerFeedback}
						</div>
					</fieldset>
				</form>
			</div>
			{afterForm}
		</section>
	);
}
