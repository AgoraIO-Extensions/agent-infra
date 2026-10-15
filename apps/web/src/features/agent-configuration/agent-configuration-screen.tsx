import { ArrowLeft, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useResultFocus } from "@/hooks/use-result-focus";

import type {
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
} from "./agent-configuration.js";
import { isAgentConfigurationOwner } from "./agent-configuration.js";
import {
	type AgentConfigurationModelDraft,
	type AgentConfigurationSecretDraft,
	buildAgentConfigurationRequest,
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
	commandResult?: AgentProjectionV2;
	lifecycle?: ReactNode;
	onSave: (body: AgentConfigurationUpdateRequestV2Writable) => void;
	/** Agent 由默认 Relay Key 管理模型（配置 V3）：用候选模型选择代替自由文本字段。 */
	defaultRelayKeyManaged?: boolean;
	/** Deployment catalog candidates for non-Key-managed Agents. */
	deploymentModelCandidates?: readonly KeylessModelCandidate[];
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

function blankModel(): AgentConfigurationModelDraft {
	return {
		optionId: "",
		endpointId: "",
		modelId: "",
		reasoningLevels: "",
	};
}

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

function unavailableScreen() {
	return (
		<section
			aria-labelledby="agent-configuration-heading"
			className="space-y-4"
		>
			<h1
				id="agent-configuration-heading"
				className="font-semibold text-[28px]"
			>
				配置不可用
			</h1>
			<Alert>
				<AlertDescription>当前无法访问此配置。</AlertDescription>
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
	lifecycle,
	onSave,
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
	const [ownerError, setOwnerError] = useState<string>();
	const [imageReference, setImageReference] = useState("");
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

	const currentModels = agent.configuration.modelOptions
		.map((model) => model.displayName)
		.join("、");
	const currentDefaultModel = agent.configuration.modelOptions.find(
		(model) => model.optionId === agent.configuration.defaultModelOptionId,
	);
	const currentSecrets = agent.configuration.secrets
		.map(
			(secret) =>
				`${secret.name}（${secret.isSet ? "已设置" : "未设置"}${secret.version === null ? "" : `，版本 ${secret.version}`}）`,
		)
		.join("、");
	const isDisabled = submitting || agent.managementStatus === "disabled";
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
			onChange={(selection: KeylessModelSelection | null) =>
				setDraft((current) => ({
					...current,
					replaceModels: selection !== null,
					models:
						selection?.options.map((option) => ({
							endpointId: option.endpointId,
							modelId: option.modelId,
							optionId: option.optionId,
							reasoningLevels: option.reasoningLevels.join(","),
						})) ?? [],
					defaultModelOptionId: selection?.defaultOptionId ?? "",
					defaultReasoningLevel: selection?.defaultReasoningLevel ?? "",
				}))
			}
		/>
	) : null;
	const replaceDefaultRelayKey = () => {
		if (!onReplaceDefaultRelayKey || !keyCheck.typed) return;
		onReplaceDefaultRelayKey(keyCheck.key.trim());
		keyCheck.reset();
	};
	const updateModel = (
		index: number,
		key: keyof AgentConfigurationModelDraft,
		value: string,
	) =>
		setDraft((current) => ({
			...current,
			models: current.models.map((model, modelIndex) =>
				modelIndex === index ? { ...model, [key]: value } : model,
			),
		}));
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
	const submitConfiguration = () => {
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
		setDraft((current) => ({
			...current,
			secrets: [],
		}));
		// 填写了 Key 并选好模型：与页面其他修改一起，Key、模型集合和配置修订一次保存。
		if (defaultRelayKeyManaged && keyCheck.replacement) {
			onSave({ ...request, ...keyCheck.replacement });
			keyCheck.reset();
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
							{agentManagementStatusLabels[submittedResult.managementStatus]}。
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
								<fieldset className="min-w-0 space-y-4">
									<legend className="font-semibold text-foreground text-sm">
										Owner
									</legend>
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
								</fieldset>
								<fieldset className="detail-section min-w-0 space-y-4 border-border border-t pt-5">
									<legend className="font-semibold text-foreground text-sm">
										使用范围
									</legend>
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
								</fieldset>
								{!(
									agent.source.kind === "custom" &&
									agent.source.interactionMode === "self-managed"
								) ? (
									<fieldset
										className="detail-section space-y-4 border-border border-t pt-5"
										aria-describedby="wecom-visibility"
									>
										<legend className="font-semibold text-foreground text-sm">
											企微渠道
										</legend>
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
									</fieldset>
								) : null}
								{agent.source.kind === "standard" ? (
									<fieldset className="detail-section space-y-4 border-border border-t pt-5">
										<legend className="font-semibold text-foreground text-sm">
											模型配置
										</legend>
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
										{defaultRelayKeyManaged ? null : (
											<>
												<Label className="min-h-11 gap-3">
													<Checkbox
														disabled={isDisabled}
														checked={draft.replaceModels}
														onCheckedChange={(checked) =>
															setDraft((current) => ({
																...current,
																replaceModels: checked,
																models: checked
																	? current.models.length === 0
																		? [blankModel()]
																		: current.models
																	: current.models,
															}))
														}
													/>
													替换模型配置
												</Label>
												{draft.replaceModels && catalogModelPicker ? (
													catalogModelPicker
												) : draft.replaceModels ? (
													<>
														<DraftRows
															fields={
																[
																	{
																		key: "optionId",
																		label: "选项 ID",
																		required: true,
																	},
																	{
																		key: "endpointId",
																		label: "端点 ID",
																		required: true,
																	},
																	{
																		key: "modelId",
																		label: "模型 ID",
																		required: true,
																	},
																	{
																		key: "reasoningLevels",
																		label: "可选推理强度",
																		required: true,
																	},
																] as const
															}
															idPrefix="model"
															label="模型"
															onChange={updateModel}
															onRemove={(index) =>
																setDraft((current) => ({
																	...current,
																	models: current.models.filter(
																		(_, modelIndex) => modelIndex !== index,
																	),
																}))
															}
															rows={draft.models}
														/>
														<Button
															variant="outline"
															onClick={() =>
																setDraft((current) => ({
																	...current,
																	models: [...current.models, blankModel()],
																}))
															}
															type="button"
														>
															<PlusIcon
																aria-hidden="true"
																data-icon="inline-start"
															/>
															添加模型
														</Button>
														<div className="grid gap-4 sm:grid-cols-2">
															<div className="space-y-2">
																<Label htmlFor="configuration-default-model">
																	默认模型选项 ID
																</Label>
																<Input
																	id="configuration-default-model"
																	onChange={(event) =>
																		setDraft((current) => ({
																			...current,
																			defaultModelOptionId: event.target.value,
																		}))
																	}
																	required
																	value={draft.defaultModelOptionId}
																/>
															</div>
															<div className="space-y-2">
																<Label htmlFor="configuration-default-reasoning">
																	默认推理强度
																</Label>
																<Input
																	id="configuration-default-reasoning"
																	onChange={(event) =>
																		setDraft((current) => ({
																			...current,
																			defaultReasoningLevel: event.target.value,
																		}))
																	}
																	required
																	value={draft.defaultReasoningLevel}
																/>
															</div>
														</div>
													</>
												) : null}
											</>
										)}
									</fieldset>
								) : null}
								<fieldset className="detail-section space-y-4 border-border border-t pt-5">
									<legend className="font-semibold text-foreground text-sm">
										Secrets
									</legend>
									<p className="text-muted-foreground text-sm">
										{currentSecrets || "尚未配置 Secret"}
									</p>
									<p className="text-muted-foreground text-sm">
										Secret
										仅显示设置状态与版本。填写同名的新值进行替换，原值不会回显。
									</p>
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
								</fieldset>
								<div className="form-footer border-border border-t pt-5">
									<Button disabled={isDisabled} type="submit">
										{submitting ? "校验并保存中…" : "校验并保存"}
									</Button>
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
				</div>
				{lifecycle ? (
					<section className="form-aside lifecycle-panel">{lifecycle}</section>
				) : null}
			</div>
		</section>
	);
}
