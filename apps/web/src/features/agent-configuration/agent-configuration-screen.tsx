import { PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useResultFocus } from "@/hooks/use-result-focus";

import type {
	AgentConfigurationUpdateRequestV2Writable,
	AgentProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import { agentServiceAvailabilityLabel } from "../agent-discovery/agent-discovery-screen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type { BrowserSessionState } from "../browser-session.js";
import { isAgentConfigurationOwner } from "./agent-configuration.js";
import {
	type AgentConfigurationModelDraft,
	type AgentConfigurationSecretDraft,
	buildAgentConfigurationRequest,
	configurationDraftFromAgent,
} from "./agent-configuration-draft.js";
import { WecomBotSetup } from "./wecom-bot-setup.js";

type ConfigurationSessionState = BrowserSessionState | { kind: "loading" };

type AgentConfigurationScreenProps = {
	agent: AgentProjectionV2;
	commandError?: (Error & { readonly retryable?: boolean }) | null;
	commandResult?: AgentProjectionV2;
	lifecycle?: ReactNode;
	onSave: (body: AgentConfigurationUpdateRequestV2Writable) => void;
	onUpgradeImage: (imageReference: string) => void;
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
		credentialValue: "",
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
			<p className="text-muted-foreground" role="alert">
				当前无法访问此配置。
			</p>
		</section>
	);
}

export function AgentConfigurationScreen({
	agent,
	commandError = null,
	commandResult,
	lifecycle,
	onSave,
	onUpgradeImage,
	session,
	submitting,
}: AgentConfigurationScreenProps) {
	const [draft, setDraft] = useState(() => configurationDraftFromAgent(agent));
	const [imageReference, setImageReference] = useState("");
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
		setDraft((current) => ({
			...current,
			secrets: [],
			models: current.models.map((model) => ({
				...model,
				credentialValue: "",
			})),
		}));
		onSave(request);
	};

	return (
		<section
			aria-labelledby="agent-configuration-heading"
			className="space-y-6"
		>
			<header className="page-heading flex-col space-y-2">
				<h1
					id="agent-configuration-heading"
					className="font-semibold text-[28px]"
				>
					配置与生命周期
				</h1>
				<p className="break-words text-muted-foreground">
					{agent.name} · {agent.description}
				</p>
				<p className="text-muted-foreground text-sm">
					{agentManagementStatusLabels[agent.managementStatus]}
					{agent.serviceAvailability
						? ` · ${agentServiceAvailabilityLabel(agent.serviceAvailability)}`
						: ""}
				</p>
			</header>
			<p className="text-muted-foreground text-sm">
				{agent.managementStatus === "disabled"
					? "运行资格已撤销，Owner 无法恢复。"
					: "配置变更不需要重新审批。"}
			</p>
			<div className="form-layout">
				<div className="min-w-0 space-y-6">
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
						<p className="text-muted-foreground text-sm" role="alert">
							{commandError.retryable === false
								? "权限或 Agent 状态已变化，请刷新页面。"
								: "配置未能保存，请重新填写 Secret 或模型凭证后再试。"}
						</p>
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
								<fieldset className="space-y-4">
									<legend className="font-semibold text-foreground text-sm">
										Owner
									</legend>
									<p className="text-muted-foreground text-sm">
										填写真实用户 ID，每行一个或用逗号分隔。
									</p>
									<div className="space-y-2">
										<Label htmlFor="configuration-owner-ids">
											Owner 用户 ID
										</Label>
										<Textarea
											className="min-h-24"
											id="configuration-owner-ids"
											onChange={(event) =>
												setDraft((current) => ({
													...current,
													coOwnerIds: event.target.value,
												}))
											}
											required
											value={draft.coOwnerIds}
										/>
									</div>
								</fieldset>
								<fieldset className="detail-section space-y-4 border-border border-t pt-5">
									<legend className="font-semibold text-foreground text-sm">
										使用范围
									</legend>
									<div className="grid gap-4 sm:grid-cols-2">
										<div className="space-y-2">
											<Label htmlFor="configuration-user-availability">
												可用员工 ID
											</Label>
											<Textarea
												className="min-h-24"
												id="configuration-user-availability"
												onChange={(event) =>
													setDraft((current) => ({
														...current,
														userAvailabilityIds: event.target.value,
													}))
												}
												value={draft.userAvailabilityIds}
											/>
										</div>
										<div className="space-y-2">
											<Label htmlFor="configuration-organization-availability">
												可用组织 ID
											</Label>
											<Textarea
												className="min-h-24"
												id="configuration-organization-availability"
												onChange={(event) =>
													setDraft((current) => ({
														...current,
														organizationAvailabilityIds: event.target.value,
													}))
												}
												value={draft.organizationAvailabilityIds}
											/>
										</div>
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
											自建应用使用部署提供的回调配置；智能机器人可在下方直接绑定。
										</p>
										<WecomBotSetup
											key={agent.agentId}
											agentId={agent.agentId}
											onUnbind={onSave}
										/>
										{(["wecom_app"] as const).map((kind) => {
											const label = "自建应用";
											const change = draft.channels?.find(
												(c) => c.kind === kind,
											);
											const update = (
												next:
													| NonNullable<
															AgentConfigurationUpdateRequestV2Writable["channels"]
													  >[number]
													| null,
											) =>
												setDraft((current) => ({
													...current,
													channels: [
														...(current.channels ?? []).filter(
															(c) => c.kind !== kind,
														),
														...(next ? [next] : []),
													],
												}));
											return (
												<div className="space-y-3" key={kind}>
													<div className="flex items-center gap-2">
														<Checkbox
															id={`change-${kind}`}
															checked={!!change}
															onCheckedChange={(checked) =>
																update(
																	checked
																		? {
																				kind,
																				enabled: true,
																				bindingReference: "",
																			}
																		: null,
																)
															}
														/>
														<Label htmlFor={`change-${kind}`}>
															修改{label}绑定
														</Label>
													</div>
													{change ? (
														<div className="space-y-3 pl-6">
															<div className="flex items-center gap-2">
																<Checkbox
																	id={`enable-${kind}`}
																	checked={change.enabled}
																	onCheckedChange={(checked) =>
																		update(
																			checked
																				? {
																						kind,
																						enabled: true,
																						bindingReference: "",
																					}
																				: { kind, enabled: false },
																		)
																	}
																/>
																<Label htmlFor={`enable-${kind}`}>
																	启用{label}
																</Label>
															</div>
															{change.enabled ? (
																<div className="space-y-2">
																	<Label htmlFor={`binding-${kind}`}>
																		{label}配置标识
																	</Label>
																	<Input
																		id={`binding-${kind}`}
																		required
																		value={change.bindingReference}
																		onChange={(event) =>
																			update({
																				kind,
																				enabled: true,
																				bindingReference: event.target.value,
																			})
																		}
																	/>
																</div>
															) : (
																<p className="text-muted-foreground text-sm">
																	保存后解除此渠道绑定。
																</p>
															)}
														</div>
													) : null}
												</div>
											);
										})}
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
											已有模型凭证不回显；需要替换时填写新凭证。
										</p>
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
															: current.models.map((model) => ({
																	...model,
																	credentialValue: "",
																})),
													}))
												}
											/>
											替换模型配置
										</Label>
										{draft.replaceModels ? (
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
															{
																key: "credentialValue",
																label: "新模型凭证",
																type: "password",
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
								当前镜像：{agent.source.imageReference}
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
				{lifecycle ? <aside className="form-aside">{lifecycle}</aside> : null}
			</div>
		</section>
	);
}
