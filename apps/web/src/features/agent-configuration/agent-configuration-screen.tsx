import { ArrowLeft, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toast } from "@/components/ui/toast";
import { useResultFocus } from "@/hooks/use-result-focus";

import type {
	AgentApiLifecycleAcceptedResponseV1,
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import {
	agentManagementStatusLabels,
	agentServiceAvailabilityLabel,
	agentSourceReferenceLabel,
} from "../agent-management-status.js";
import type { BrowserSessionState } from "../browser-session.js";
import { DirectoryPicker } from "../directory-fields.js";
import type {
	AgentDefaultRelayKeyCheck,
	AgentDefaultRelayKeyState,
	AgentSavedModelConfigurationUpdate,
} from "./agent-configuration.js";
import { isAgentConfigurationOwner } from "./agent-configuration.js";
import {
	type AgentConfigurationSecretDraft,
	agentConfigurationDraftChanged,
	buildAgentConfigurationRequest,
	buildAgentSecretReplacementRequest,
	configurationDraftFromAgent,
} from "./agent-configuration-draft.js";
import { KeylessModelPicker } from "./keyless-model-picker.js";
import type {
	KeylessModelCandidate,
	KeylessModelSelection,
} from "./keyless-model-selection.js";
import { useKeylessKeyCheck } from "./use-keyless-key-check.js";
import { WecomAppSetup } from "./wecom-app-setup.js";
import { WecomBotSetup } from "./wecom-bot-setup.js";

type ConfigurationSessionState = BrowserSessionState | { kind: "loading" };

type AgentConfigurationScreenProps = {
	agent: AgentProjectionV2;
	authorization?: ReactNode;
	commandError?: (Error & { readonly retryable?: boolean }) | null;
	commandResult?: AgentProjectionV2 | AgentApiLifecycleAcceptedResponseV1;
	lifecycle?: ReactNode;
	onSave: (
		body:
			| AgentConfigurationUpdateRequestV2Writable
			| AgentSavedModelConfigurationUpdate,
	) => void;
	onSaveAndWait?: (
		body:
			| AgentConfigurationUpdateRequestV2Writable
			| AgentSavedModelConfigurationUpdate,
	) => Promise<
		AgentProjectionV2 | AgentApiLifecycleAcceptedResponseV1 | undefined
	>;
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
	onUpgradeImage: (imageReference: string) => void;
	relayKeyError?: Error | null;
	/** 仅替换 Key 成功后的状态。 */
	relayKeyResult?: AgentDefaultRelayKeyState;
	relayKeySubmitting?: boolean;
	session: ConfigurationSessionState;
	submitting: boolean;
};

type DraftField<T extends string> = {
	key: T;
	label: string;
	required?: boolean;
	type?: "password" | "text";
};

type DraftRowsProps<T extends string> = {
	fields: readonly DraftField<T>[];
	idPrefix: string;
	label: string;
	onChange: (index: number, key: T, value: string) => void;
	onRemove: (index: number) => void;
	rows: readonly Record<T, string>[];
};

function blankSecret(): AgentConfigurationSecretDraft {
	return { name: "", value: "" };
}

function DraftRows<T extends string>({
	fields,
	idPrefix,
	label,
	onChange,
	onRemove,
	rows,
}: DraftRowsProps<T>) {
	return (
		<>
			{rows.map((row, index) => (
				<div className="grid gap-3 sm:grid-cols-3" key={`${label}-${index}`}>
					{fields.map((field) => (
						<div className="space-y-2" key={field.key}>
							<Label
								htmlFor={`configuration-${idPrefix}-${field.key}-${index}`}
							>
								{field.label}
							</Label>
							<Input
								autoComplete={
									field.type === "password" ? "new-password" : undefined
								}
								id={`configuration-${idPrefix}-${field.key}-${index}`}
								onChange={(event) =>
									onChange(index, field.key, event.target.value)
								}
								required={field.required}
								type={field.type ?? "text"}
								value={row[field.key]}
							/>
						</div>
					))}
					<Button
						variant="outline"
						className="self-end"
						onClick={() => onRemove(index)}
						type="button"
					>
						<Trash2Icon aria-hidden="true" data-icon="inline-start" />
						移除{label}
					</Button>
				</div>
			))}
		</>
	);
}

function unavailableScreen({
	administratorView = false,
}: {
	administratorView?: boolean;
} = {}) {
	return (
		<section
			aria-labelledby="agent-configuration-heading"
			className="space-y-4"
		>
			<h1
				id="agent-configuration-heading"
				className="font-semibold text-[28px]"
			>
				{administratorView ? "管理员管理视图" : "配置不可用"}
			</h1>
			<Alert>
				<AlertDescription>
					{administratorView
						? "此页仅提供管理员授权与生命周期操作。"
						: "当前无法访问此配置。"}
				</AlertDescription>
			</Alert>
		</section>
	);
}

export function AgentConfigurationScreen({
	agent,
	authorization,
	commandError = null,
	commandResult,
	defaultRelayKeyManaged = false,
	deploymentModelCandidates,
	savedRelayKeyCandidates,
	savedRelayKeyConfigurationRevision,
	savedRelayKeyVersion,
	savedRelayKeyCandidatesError = null,
	savedRelayKeyCandidatesLoading = false,
	lifecycle,
	onSave,
	onSaveAndWait,
	onRetrySavedRelayKeyCandidates,
	onPreviewDefaultRelayKeyCandidates,
	onReplaceDefaultRelayKey,
	onUpgradeImage,
	relayKeyError = null,
	relayKeyResult,
	relayKeySubmitting = false,
	session,
	submitting,
}: AgentConfigurationScreenProps) {
	const [draft, setDraft] = useState(() => configurationDraftFromAgent(agent));
	const [secretDialogName, setSecretDialogName] = useState<string>();
	const [secretDialogValue, setSecretDialogValue] = useState("");
	const [secretDialogError, setSecretDialogError] = useState<string>();
	const [secretDialogSubmitting, setSecretDialogSubmitting] = useState(false);
	const [secretNotice, setSecretNotice] = useState<string>();
	const [ownerError, setOwnerError] = useState<string>();
	const [catalogSelectionError, setCatalogSelectionError] = useState(false);
	const [savedSelectionError, setSavedSelectionError] = useState(false);
	const [imageReference, setImageReference] = useState("");
	const keyCheck = useKeylessKeyCheck(onPreviewDefaultRelayKeyCandidates);
	const submittedResult =
		commandResult?.agentId === agent.agentId ? commandResult : undefined;
	const resultRef = useResultFocus(submittedResult);
	if (
		session.kind !== "ready" ||
		!isAgentConfigurationOwner(agent, session.session)
	) {
		return unavailableScreen({
			administratorView:
				session.kind === "ready" &&
				session.session.user.roles.includes("system_admin"),
		});
	}

	const currentModels = agent.configuration.modelOptions
		.map((model) => model.displayName)
		.join("、");
	const currentDefaultModel = agent.configuration.modelOptions.find(
		(model) => model.optionId === agent.configuration.defaultModelOptionId,
	);
	const isDisabled = submitting || agent.managementStatus === "disabled";
	// 正在替换默认 Key（已输入或已检查）也算改动：保存时要引导用户先完成检查（#2560）。
	const hasChanges =
		agentConfigurationDraftChanged(agent, draft) ||
		keyCheck.typed ||
		Boolean(keyCheck.replacement);
	const catalogModelPicker = deploymentModelCandidates ? (
		<KeylessModelPicker
			candidates={deploymentModelCandidates}
			current={agent.configuration.modelOptions}
			currentDefault={{
				optionId: agent.configuration.defaultModelOptionId ?? "",
				level: agent.configuration.defaultReasoningLevel ?? "",
			}}
			disabled={isDisabled}
			idPrefix="configuration-catalog-model"
			key={deploymentModelCandidates
				.map((candidate) => `${candidate.endpointId}/${candidate.modelId}`)
				.join("|")}
			onChange={(selection: KeylessModelSelection | null) => {
				setCatalogSelectionError(selection === null);
				setDraft((current) => ({
					...current,
					replaceModels: true,
					models:
						selection?.options.map((option) => ({
							endpointId: option.endpointId,
							modelId: option.modelId,
							optionId: option.optionId,
							reasoningLevels: option.reasoningLevels.join(","),
						})) ?? [],
					defaultModelOptionId: selection?.defaultOptionId ?? "",
					defaultReasoningLevel: selection?.defaultReasoningLevel ?? "",
				}));
			}}
		/>
	) : null;
	const savedModelPicker =
		defaultRelayKeyManaged &&
		!keyCheck.typed &&
		savedRelayKeyCandidates !== undefined ? (
			<KeylessModelPicker
				candidates={savedRelayKeyCandidates}
				current={agent.configuration.modelOptions}
				currentDefault={{
					optionId: agent.configuration.defaultModelOptionId ?? "",
					level: agent.configuration.defaultReasoningLevel ?? "",
				}}
				disabled={isDisabled}
				idPrefix="configuration-saved-key-model"
				key={savedRelayKeyCandidates
					.map((candidate) => `${candidate.endpointId}/${candidate.modelId}`)
					.join("|")}
				onChange={(selection: KeylessModelSelection | null) => {
					setSavedSelectionError(selection === null);
					setDraft((current) => ({
						...current,
						replaceModels: true,
						models:
							selection?.options.map((option) => ({
								endpointId: option.endpointId,
								modelId: option.modelId,
								optionId: option.optionId,
								reasoningLevels: option.reasoningLevels.join(","),
							})) ?? [],
						defaultModelOptionId: selection?.defaultOptionId ?? "",
						defaultReasoningLevel: selection?.defaultReasoningLevel ?? "",
					}));
				}}
			/>
		) : null;
	const replaceDefaultRelayKey = () => {
		if (!onReplaceDefaultRelayKey || !keyCheck.typed) return;
		onReplaceDefaultRelayKey(keyCheck.key.trim());
		keyCheck.reset();
	};
	const updateSecret = (
		index: number,
		key: keyof AgentConfigurationSecretDraft,
		value: string,
	) =>
		setDraft((current) => ({
			...current,
			secrets: current.secrets.map((secret, secretIndex) =>
				secretIndex === index ? { ...secret, [key]: value } : secret,
			),
		}));
	const closeSecretDialog = () => {
		setSecretDialogName(undefined);
		setSecretDialogValue("");
		setSecretDialogError(undefined);
	};
	const replaceSecret = async () => {
		if (!secretDialogName || !secretDialogValue.trim()) {
			setSecretDialogError("请输入 Secret 值。");
			return;
		}
		const request = buildAgentSecretReplacementRequest(
			secretDialogName,
			secretDialogValue,
		);
		setSecretDialogSubmitting(true);
		setSecretDialogError(undefined);
		setSecretNotice(undefined);
		try {
			const result = await (onSaveAndWait
				? onSaveAndWait(request)
				: Promise.resolve(onSave(request)));
			const version =
				result && "configuration" in result
					? result.configuration.secrets.find(
							(secret) => secret.name === request.secrets?.[0]?.name,
						)?.version
					: undefined;
			setSecretNotice(
				version === undefined || version === null
					? "Secret 已写入，等待 Worker 激活。"
					: `Secret 已写入 pending version ${version}，等待 Worker 激活。`,
			);
			closeSecretDialog();
		} catch {
			setSecretDialogError("Secret 替换未完成，请重试。");
		} finally {
			setSecretDialogSubmitting(false);
		}
	};
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
			aria-labelledby="agent-configuration-heading"
			className="space-y-6"
		>
			<header className="page-heading">
				<div>
					<a
						className={buttonVariants({ variant: "ghost" })}
						href={`/agents/${encodeURIComponent(agent.agentId)}`}
					>
						<ArrowLeft aria-hidden="true" />
						返回 Agent 详情
					</a>
					<p className="page-eyebrow">Owner 配置 · {agent.name}</p>
					<h1 id="agent-configuration-heading">
						让 Agent 在正确的范围内运行。
					</h1>
					<p>保存后更新运行实例；Secret 只显示状态和版本，不回显值。</p>
				</div>
				<div className="tag-row">
					<Badge variant="outline" data-status={agent.managementStatus}>
						{agentManagementStatusLabels[agent.managementStatus]}
					</Badge>
					{agent.serviceAvailability && (
						<Badge variant="outline" data-status={agent.serviceAvailability}>
							{agentServiceAvailabilityLabel(agent.serviceAvailability)}
						</Badge>
					)}
				</div>
			</header>
			<p className="text-muted-foreground text-sm">
				{agent.managementStatus === "disabled"
					? "运行资格已撤销，Owner 无法恢复。"
					: "配置变更不需要重新审批。"}
			</p>
			<div className="form-layout full-width-form">
				<div className="min-w-0 space-y-6">
					{authorization}
					{submittedResult ? (
						<p
							ref={resultRef}
							tabIndex={-1}
							className="font-medium text-foreground text-sm"
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
						<Alert>
							<AlertDescription>
								{commandError.retryable === false
									? "权限或 Agent 状态已变化，请刷新页面。"
									: "配置未能保存，请重新填写 Secret 或模型凭证后再试。"}
							</AlertDescription>
						</Alert>
					) : null}
					{submittedResult ? null : (
						<form
							className="space-y-6"
							onSubmit={(event) => {
								event.preventDefault();
								if (isDisabled) return;
								submitConfiguration();
							}}
						>
							<fieldset
								disabled={isDisabled}
								className="min-w-0 space-y-6"
								aria-label="Agent 配置"
							>
								<section
									aria-labelledby="configuration-owner-heading"
									className="configuration-section min-w-0 space-y-4"
								>
									<h2
										className="configuration-section-heading"
										id="configuration-owner-heading"
									>
										Owner
									</h2>
									<DirectoryPicker
										id="configuration-owner-ids"
										kind="user"
										label="共同 Owner 用户"
										required
										help="至少保留一名有效 Owner"
										value={draft.coOwnerIds}
										disabled={isDisabled}
										error={ownerError}
										onChange={(value) => {
											setDraft((current) => ({
												...current,
												coOwnerIds: value,
											}));
											setOwnerError(undefined);
										}}
									/>
								</section>
								<section
									aria-labelledby="configuration-scope-heading"
									className="configuration-section detail-section min-w-0 space-y-4 border-border border-t pt-5"
								>
									<h2
										className="configuration-section-heading"
										id="configuration-scope-heading"
									>
										使用范围
									</h2>
									<div className="grid min-w-0 gap-4 sm:grid-cols-2">
										<DirectoryPicker
											id="configuration-user-availability"
											kind="user"
											label="可使用的用户"
											help="可选；用于补充个人范围"
											value={draft.userAvailabilityIds}
											disabled={isDisabled}
											onChange={(value) =>
												setDraft((current) => ({
													...current,
													userAvailabilityIds: value,
												}))
											}
										/>
										<DirectoryPicker
											id="configuration-organization-availability"
											kind="organization"
											label="可使用的组织"
											help="可选；组织范围会与用户范围合并"
											value={draft.organizationAvailabilityIds}
											disabled={isDisabled}
											onChange={(value) =>
												setDraft((current) => ({
													...current,
													organizationAvailabilityIds: value,
												}))
											}
										/>
									</div>
								</section>
								{!(
									agent.source.kind === "custom" &&
									agent.source.interactionMode === "self-managed"
								) ? (
									<section
										aria-labelledby="configuration-wecom-heading"
										className="detail-section space-y-4 border-border border-t pt-5"
										aria-describedby="wecom-visibility"
									>
										<h2
											className="configuration-section-heading"
											id="configuration-wecom-heading"
										>
											企微渠道
										</h2>
										<p
											id="wecom-visibility"
											className="text-muted-foreground text-sm"
										>
											群消息和 Agent 回复对群成员可见。Agent
											可用范围只限制谁能触发
											Agent，不能阻止群成员阅读已有内容；每位发送者的会话上下文仍独立。
										</p>
										<p className="text-muted-foreground text-sm">
											自建应用和智能机器人都可在下方完成绑定，凭证通过受保护的接口提交。
										</p>
										<WecomBotSetup
											key={`${agent.agentId}:wecom_bot`}
											agentId={agent.agentId}
											onUnbind={onSave}
										/>
										<WecomAppSetup
											key={`${agent.agentId}:wecom_app`}
											agentId={agent.agentId}
											onUnbind={onSave}
										/>
									</section>
								) : null}
								{agent.source.kind === "standard" ? (
									<section
										aria-labelledby="configuration-model-heading"
										className="configuration-section detail-section space-y-4 border-border border-t pt-5"
									>
										<h2
											className="configuration-section-heading"
											id="configuration-model-heading"
										>
											模型配置
										</h2>
										<p className="text-muted-foreground text-sm">
											{currentModels || "尚未配置可选模型"}
										</p>
										<p className="text-muted-foreground text-sm">
											当前默认：
											{currentDefaultModel
												? `${currentDefaultModel.displayName}${agent.configuration.defaultReasoningLevel ? ` · ${agent.configuration.defaultReasoningLevel}` : ""}`
												: "未提供"}
										</p>
										<p className="text-muted-foreground text-sm">
											已有 Agent 默认 Relay Key 不回显；需要替换时填写新 Key。
										</p>
										{onReplaceDefaultRelayKey ? (
											<div className="space-y-3">
												<Label htmlFor="configuration-default-relay-key">
													替换 Agent 默认 Relay Key
												</Label>
												<div className="flex flex-wrap gap-3">
													<Input
														autoComplete="new-password"
														disabled={isDisabled || relayKeySubmitting}
														id="configuration-default-relay-key"
														onChange={(event) =>
															keyCheck.setKey(event.target.value)
														}
														placeholder="输入新 Key"
														type="password"
														value={keyCheck.key}
													/>
													<Button
														disabled={
															isDisabled || keyCheck.checking || !keyCheck.typed
														}
														onClick={() => void keyCheck.runCheck()}
														type="button"
														variant="outline"
													>
														{keyCheck.checking ? "正在检查…" : "检查可用模型"}
													</Button>
													<Button
														disabled={
															isDisabled ||
															relayKeySubmitting ||
															!keyCheck.typed
														}
														onClick={replaceDefaultRelayKey}
														type="button"
													>
														{relayKeySubmitting ? "正在替换…" : "替换默认 Key"}
													</Button>
												</div>
												<p className="text-muted-foreground text-sm">
													当前 Key
													只显示已设置状态；输入值不会回显或写入普通业务投影。
												</p>
												{relayKeyResult?.isSet &&
												!relayKeySubmitting &&
												!relayKeyError ? (
													<p
														className="font-medium text-foreground text-sm"
														role="status"
													>
														默认 Key 已替换，当前版本{" "}
														{relayKeyResult.keyVersion}。
													</p>
												) : null}
												{keyCheck.blocked ? (
													<Alert variant="destructive">
														<AlertDescription>
															已填写新
															Key，但还没有可保存的模型选择：请先点击「检查可用模型」，选好模型（至少一个模型，每个模型至少一个推理档位）后再保存；不想更换
															Key 请清空输入框。
														</AlertDescription>
													</Alert>
												) : null}
												{keyCheck.error || relayKeyError ? (
													<Alert variant="destructive">
														<AlertDescription>
															Key 校验或替换失败，请刷新后重试。
														</AlertDescription>
													</Alert>
												) : null}
												{keyCheck.candidates.length > 0 &&
												!defaultRelayKeyManaged ? (
													<p className="text-muted-foreground text-sm">
														Key 可用模型：
														{keyCheck.candidates
															.map(
																(candidate) =>
																	`${candidate.endpointId} · ${candidate.modelId}`,
															)
															.join("、")}
													</p>
												) : null}
												{keyCheck.candidates.length > 0 &&
												defaultRelayKeyManaged ? (
													<>
														<KeylessModelPicker
															candidates={keyCheck.candidates}
															current={agent.configuration.modelOptions}
															currentDefault={{
																optionId:
																	agent.configuration.defaultModelOptionId ??
																	"",
																level:
																	agent.configuration.defaultReasoningLevel ??
																	"",
															}}
															disabled={isDisabled}
															idPrefix="configuration-keyless-model"
															key={keyCheck.candidates
																.map(
																	(candidate) =>
																		`${candidate.endpointId}/${candidate.modelId}`,
																)
																.join("|")}
															onChange={keyCheck.setSelection}
														/>
														<p className="text-muted-foreground text-sm">
															选好后点击页面底部的「校验并保存」：新
															Key、模型集合和其他修改会在同一次保存中生效。
														</p>
													</>
												) : null}
											</div>
										) : null}
										{defaultRelayKeyManaged && !keyCheck.typed ? (
											<div className="space-y-3">
												{savedRelayKeyCandidatesLoading ? (
													<p
														className="text-muted-foreground text-sm"
														role="status"
													>
														正在读取已保存 Key 的可用模型…
													</p>
												) : null}
												{savedRelayKeyCandidatesError ? (
													<Alert variant="destructive">
														<AlertDescription className="flex flex-wrap items-center gap-3">
															<span>
																已保存的默认 Key 暂时无法读取可用模型。
															</span>
															{onRetrySavedRelayKeyCandidates ? (
																<Button
																	disabled={savedRelayKeyCandidatesLoading}
																	onClick={onRetrySavedRelayKeyCandidates}
																	type="button"
																	variant="outline"
																>
																	{savedRelayKeyCandidatesLoading
																		? "正在重试…"
																		: "重新读取可用模型"}
																</Button>
															) : null}
														</AlertDescription>
													</Alert>
												) : null}
												{savedModelPicker}
												{savedSelectionError ? (
													<Alert variant="destructive">
														<AlertDescription>
															至少选择一个已保存 Key
															可用的模型，并为每个模型保留一个推理档位。
														</AlertDescription>
													</Alert>
												) : null}
											</div>
										) : null}
										{defaultRelayKeyManaged ? null : (
											<>
												<Label className="min-h-11 gap-3">
													<Checkbox
														disabled={isDisabled}
														checked={draft.replaceModels}
														onCheckedChange={(checked) => {
															setCatalogSelectionError(false);
															setDraft((current) => ({
																...current,
																replaceModels: checked,
																models: current.models,
															}));
														}}
													/>
													替换模型配置
												</Label>
												{draft.replaceModels
													? (catalogModelPicker ?? (
															<Alert variant="destructive">
																<AlertDescription>
																	模型目录暂时不可用，无法编辑模型配置；请刷新后重试。
																</AlertDescription>
															</Alert>
														))
													: null}
											</>
										)}
									</section>
								) : null}
								<section
									aria-labelledby="configuration-secrets-heading"
									className="configuration-section detail-section space-y-4 border-border border-t pt-5"
								>
									<h2
										className="configuration-section-heading"
										id="configuration-secrets-heading"
									>
										Secrets
									</h2>
									{agent.configuration.secrets.length === 0 ? (
										<p className="text-muted-foreground text-sm">
											尚未配置 Secret
										</p>
									) : null}
									<p className="text-muted-foreground text-sm">
										Secret
										仅显示设置状态与版本。填写同名的新值进行替换，原值不会回显。
									</p>
									{agent.configuration.secrets.map((secret) => (
										<div
											className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border px-3 py-2"
											key={secret.name}
										>
											<span className="text-sm">
												{secret.name}（{secret.isSet ? "已设置" : "未设置"}
												{secret.version === null
													? ""
													: `，版本 ${secret.version}`}
												）
											</span>
											<Button
												variant="outline"
												size="sm"
												disabled={isDisabled}
												onClick={() => {
													setSecretDialogName(secret.name);
													setSecretDialogValue("");
													setSecretDialogError(undefined);
													setSecretNotice(undefined);
												}}
												type="button"
											>
												替换 Secret
											</Button>
										</div>
									))}
									<DraftRows
										fields={
											[
												{ key: "name", label: "Secret 名称", required: true },
												{
													key: "value",
													label: "新 Secret 值",
													required: true,
													type: "password",
												},
											] as const
										}
										idPrefix="secret"
										label="Secret"
										onChange={updateSecret}
										onRemove={(index) =>
											setDraft((current) => ({
												...current,
												secrets: current.secrets.filter(
													(_, secretIndex) => secretIndex !== index,
												),
											}))
										}
										rows={draft.secrets}
									/>
									<Button
										variant="outline"
										onClick={() =>
											setDraft((current) => ({
												...current,
												secrets: [...current.secrets, blankSecret()],
											}))
										}
										type="button"
									>
										<PlusIcon aria-hidden="true" data-icon="inline-start" />
										添加 Secret
									</Button>
								</section>
								<Dialog
									open={secretDialogName !== undefined}
									onOpenChange={(open) => {
										if (!open && !secretDialogSubmitting) closeSecretDialog();
									}}
								>
									<DialogContent>
										<DialogTitle>替换 Secret</DialogTitle>
										<DialogDescription>
											{secretDialogName} 仅本次提交使用，不会回显。
										</DialogDescription>
										<div className="mt-5 space-y-2">
											<Label htmlFor="configuration-secret-replacement">
												新 Secret 值
											</Label>
											<Input
												autoComplete="new-password"
												aria-describedby={
													secretDialogError
														? "configuration-secret-replacement-error"
														: undefined
												}
												aria-invalid={secretDialogError ? "true" : undefined}
												id="configuration-secret-replacement"
												onChange={(event) => {
													setSecretDialogValue(event.target.value);
													setSecretDialogError(undefined);
												}}
												placeholder="仅本次提交使用，不会回显"
												type="password"
												value={secretDialogValue}
											/>
											{secretDialogError && (
												<Alert variant="destructive" className="field-error">
													<AlertDescription id="configuration-secret-replacement-error">
														{secretDialogError}
													</AlertDescription>
												</Alert>
											)}
										</div>
										<div className="mt-5 flex flex-wrap justify-end gap-3">
											<DialogClose
												className={buttonVariants({ variant: "ghost" })}
												disabled={secretDialogSubmitting}
											>
												取消
											</DialogClose>
											<Button
												disabled={secretDialogSubmitting}
												type="button"
												onClick={() => void replaceSecret()}
											>
												{secretDialogSubmitting ? "保存中…" : "保存替换"}
											</Button>
										</div>
									</DialogContent>
								</Dialog>
								{secretNotice ? <Toast>{secretNotice}</Toast> : null}
								<div className="form-footer border-border border-t pt-5">
									<Button
										aria-describedby={
											hasChanges ? undefined : "agent-configuration-unchanged"
										}
										disabled={isDisabled || !hasChanges}
										type="submit"
									>
										{submitting ? "校验并保存中…" : "校验并保存"}
									</Button>
									{hasChanges || isDisabled ? null : (
										<p
											className="text-muted-foreground text-sm"
											id="agent-configuration-unchanged"
										>
											没有需要保存的变更。
										</p>
									)}
								</div>
							</fieldset>
						</form>
					)}
					{agent.source.kind === "custom" && !submittedResult ? (
						<section className="detail-section space-y-4 border-border border-t pt-5">
							<h2 className="font-semibold text-foreground text-lg">
								镜像升级
							</h2>
							<p className="text-muted-foreground text-sm">
								当前来源：{agentSourceReferenceLabel(agent)}
							</p>
							<div className="flex flex-col gap-3 sm:flex-row">
								<div className="min-w-0 flex-1 space-y-2">
									<Label htmlFor="configuration-image-reference">
										新镜像引用
									</Label>
									<Input
										disabled={isDisabled}
										id="configuration-image-reference"
										onChange={(event) => setImageReference(event.target.value)}
										value={imageReference}
									/>
								</div>
								<Button
									variant="outline"
									className="self-end"
									disabled={isDisabled || imageReference.trim().length === 0}
									onClick={() => onUpgradeImage(imageReference.trim())}
									type="button"
								>
									{submitting ? "升级中…" : "升级镜像"}
								</Button>
							</div>
						</section>
					) : null}
					{lifecycle ? (
						<section className="detail-section lifecycle-panel border-border border-t pt-5">
							{lifecycle}
						</section>
					) : null}
				</div>
			</div>
		</section>
	);
}
