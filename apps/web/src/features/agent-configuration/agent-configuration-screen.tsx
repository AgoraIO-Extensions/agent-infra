import { Link } from "@tanstack/react-router";
import { CheckIcon, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useSubmitFocus } from "@/hooks/use-submit-focus";

import type {
	AgentApiLifecycleAcceptedResponseV1,
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import type { BrowserSessionState } from "../browser-session.js";
import { AccessDeniedCard } from "../page-state-card.js";
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
import {
	type ConfigurationPageBack,
	ConfigurationPageHeading,
} from "./configuration-page-heading.js";
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
	/**
	 * 页脚保存按钮之后的操作（重启 Agent、重试创建）。页脚不在整页 fieldset 内，保存进行中由
	 * 调用方自行禁用（ConfigurationFooterLifecycleActions 的 disabled）。
	 */
	footerActions?: ReactNode;
	/** 页脚操作的反馈（例如生命周期命令失败）。 */
	footerFeedback?: ReactNode;
	onSave: (body: ConfigurationSaveRequest) => void;
	/**
	 * 重新读取默认 Key 状态与已保存 Key 候选（保存冲突后，RK2-09）；两项都读到时返回 true，
	 * 页面据此收起冲突提示并给出完成反馈（#3268 N8-2-07）。
	 */
	onReloadSavedRelayKey?: () => Promise<boolean>;
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
	/** 镜像升级失败（只在「镜像升级」分区内说明，不写页脚的保存失败，#3268 N8-2-06）。 */
	imageError?: AgentConfigurationRequestError | null;
	session: ConfigurationSessionState;
	/** 整页配置保存进行中。 */
	submitting: boolean;
	/** 镜像升级进行中：不显示「保存中…」、不禁用整页字段，只暂停整页保存。 */
	upgradingImage?: boolean;
};

/**
 * 读到了 Agent 但不是 Owner（也不是系统管理员）：与读取失败的 403 / 404 一样用公共「无法访问」卡，
 * 页头同路由读取失败时的「Owner 配置」，只提供「返回 Agent 详情」（P-01、#3268 N8-2-09）。
 */
function unavailableScreen(agentId: string) {
	return (
		<section aria-labelledby={configurationHeadingId}>
			<header className="page-heading">
				<div>
					{/* tabIndex=-1：读取失败后「重新登录」「重新加载配置」恢复到此状态时焦点落在标题上。 */}
					<h1 id={configurationHeadingId} tabIndex={-1}>
						Owner 配置
					</h1>
				</div>
			</header>
			<AccessDeniedCard
				description="只有当前 Owner 可以修改这个 Agent 的配置。"
				back={
					// exact：/agents/$agentId 是当前地址的前缀，不让 Link 补 aria-current（N-21）。
					<Link
						activeOptions={{ exact: true }}
						className={buttonVariants({ variant: "outline" })}
						params={{ agentId }}
						to="/agents/$agentId"
					>
						返回 Agent 详情
					</Link>
				}
			/>
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
 * 纯系统管理员的配置页（N-02）：与 Owner 相同的页头与权限边界，下面只有服务端允许的
 * 管理员操作区；不显示 Owner 才能编辑的配置与授权控制（#3033 AC-2）。
 */
export function AgentAdministratorConfigurationScreen({
	agent,
	afterForm,
	back,
}: {
	agent: AgentProjectionV2;
	afterForm?: ReactNode;
	back?: ConfigurationPageBack;
}) {
	return (
		<section
			aria-labelledby={configurationHeadingId}
			className="agent-configuration"
		>
			<ConfigurationPageHeading agent={agent} back={back} />
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
	imageError = null,
	session,
	submitting,
	upgradingImage = false,
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
	// 保存冲突（saved-model 409）后「重新读取可用模型」：读取中按钮可聚焦地禁用；读到后收起这条冲突
	// 提示，改为「可用模型已更新，请确认后保存。」并把焦点交给模型选择器（没有时交给保存按钮）；
	// 读取失败时提示保留、焦点留在按钮上（#3268 N8-2-07）。
	const [reloadingSavedModels, setReloadingSavedModels] = useState(false);
	const [resolvedConflict, setResolvedConflict] =
		useState<AgentConfigurationRequestError | null>(null);
	const [savedModelsReloaded, setSavedModelsReloaded] = useState(false);
	const [focusAfterReload, setFocusAfterReload] = useState(false);
	const fieldsetRef = useRef<HTMLFieldSetElement>(null);
	const saveRef = useRef<HTMLButtonElement>(null);
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

	// 保存期间「保存配置」是可聚焦的禁用，焦点留在按钮上；在字段里按 Enter 提交时先交给按钮
	// （字段随 fieldset 禁用）。保存成功后按钮因没有变更而禁用，焦点落到「没有需要保存的变更。」
	// （D2-59、#3242 K7-02）；保存失败时按钮恢复可用，焦点仍在按钮上。
	useSubmitFocus(submitting, fieldsetRef, saveRef);
	useEffect(() => {
		if (!focusUnchangedHint || submitting) return;
		setFocusUnchangedHint(false);
		document.getElementById("agent-configuration-unchanged")?.focus();
	}, [focusUnchangedHint, submitting]);
	useEffect(() => {
		if (!focusAfterReload) return;
		setFocusAfterReload(false);
		const picker = document
			.getElementById(savedModelPickerId)
			?.querySelector<HTMLElement>('[role="checkbox"]');
		(picker ?? saveRef.current)?.focus();
	}, [focusAfterReload]);
	// 已保存 Key 的可用模型读取不可重试地失败、选择器随之收起时（#3418 N14-02），草稿里尚未保存的模型选择
	// 不再有可核对的候选：撤回它，不随其他字段提交；其他未保存的修改保留。
	const savedCandidatesWithdrawn =
		defaultRelayKeyManaged &&
		savedRelayKeyCandidatesError !== null &&
		savedRelayKeyCandidates === undefined;
	useEffect(() => {
		if (!savedCandidatesWithdrawn) return;
		// 撤回的是唯一的修改时「保存配置」随之变为原生禁用：焦点原在按钮上的交给紧挨按钮的
		// 「没有需要保存的变更。」（同保存完成，#3433 N15-05），不留给兜底送到视口外的 h1；
		// 还有其他修改时按钮保持可用，提示不出现，焦点不动。
		if (document.activeElement === saveRef.current) setFocusUnchangedHint(true);
		setSavedSelectionError(false);
		setDraft((current) =>
			current.replaceModels
				? {
						...current,
						replaceModels: false,
						models: [],
						defaultModelOptionId: "",
						defaultReasoningLevel: "",
					}
				: current,
		);
	}, [savedCandidatesWithdrawn]);

	if (!isOwner) return unavailableScreen(agent.agentId);

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
		// 镜像升级在途时整页保存暂停（同一个 mutation 一次只受理一个命令）。
		if (isDisabled || !hasChanges || upgradingImage) return;
		setSavedModelsReloaded(false);
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
	const failure =
		commandError && commandError !== resolvedConflict
			? saveFailure(commandError, savePath)
			: null;
	const reloadSavedModels = async () => {
		if (!onReloadSavedRelayKey || reloadingSavedModels) return;
		const conflict = commandError;
		setReloadingSavedModels(true);
		let reloaded = false;
		try {
			reloaded = (await onReloadSavedRelayKey()) === true;
		} catch {
			reloaded = false;
		}
		setReloadingSavedModels(false);
		if (!reloaded) return;
		setResolvedConflict(conflict);
		setSavedModelsReloaded(true);
		setFocusAfterReload(true);
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
				<form
					onSubmit={(event) => {
						event.preventDefault();
						submitConfiguration();
					}}
				>
					{/* 「镜像升级」与页脚在 fieldset 之外：保存进行中其余字段由 fieldset 禁用，触发按钮仍可
					    聚焦（aria-disabled），焦点不落到 body（#3242 K7-02）；镜像升级进行中只禁用本分区，
					    不禁用整页字段（#3268 N8-2-06）。两者各自接收 isDisabled，已停用的 Agent 仍整页禁用。 */}
					<fieldset
						ref={fieldsetRef}
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
								disabled={isDisabled}
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
					</fieldset>
					{agent.source.kind === "custom" ? (
						<ConfigurationImageSection
							agent={agent}
							disabled={isDisabled}
							error={imageError}
							onUpgradeImage={onUpgradeImage}
							upgrading={upgradingImage}
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
											// 页脚在 fieldset 之外：保存进行中或 Agent 已停用时同样禁用；读取中是可聚焦的
											// 禁用，焦点留在按钮上。
											disabled={isDisabled || reloadingSavedModels}
											focusableWhenDisabled={reloadingSavedModels}
											onClick={() => void reloadSavedModels()}
										>
											<RefreshCw aria-hidden="true" data-icon="inline-start" />
											{reloadingSavedModels
												? "正在重新读取…"
												: "重新读取可用模型"}
										</Button>
									</AlertAction>
								) : null}
							</Alert>
						) : savedModelsReloaded ? (
							<Alert tone="info" role="status">
								<AlertDescription>
									可用模型已更新，请确认后保存。
								</AlertDescription>
							</Alert>
						) : null}
						{hasChanges || isDisabled ? null : (
							// 设计 .form-footer 左侧状态为 .field-help：11px、--muted-ink（W-23）。
							<p
								className="text-(--muted-ink) text-[11px] outline-none"
								id="agent-configuration-unchanged"
								tabIndex={-1}
							>
								没有需要保存的变更。
							</p>
						)}
						<div className="configuration-footer-actions">
							<Button
								ref={saveRef}
								aria-describedby={
									hasChanges ? undefined : "agent-configuration-unchanged"
								}
								// 镜像升级在途时暂停保存，但不显示「保存中…」（#3268 N8-2-06）。
								disabled={isDisabled || !hasChanges || upgradingImage}
								// 只有保存进行中是可聚焦的禁用；没有变更或 Agent 已停用时仍为原生禁用。
								focusableWhenDisabled={submitting}
								type="submit"
							>
								<CheckIcon aria-hidden="true" data-icon="inline-start" />
								{submitting ? "保存中…" : "保存配置"}
							</Button>
							{footerActions}
						</div>
						{footerFeedback}
					</div>
				</form>
			</div>
			{afterForm}
		</section>
	);
}
