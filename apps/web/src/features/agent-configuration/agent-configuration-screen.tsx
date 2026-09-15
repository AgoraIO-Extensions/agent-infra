import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
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
import type { BrowserSessionState } from "../agent-administration/agent-administration.js";
import { agentServiceAvailabilityLabel } from "../agent-discovery/agent-discovery-screen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import { isAgentConfigurationOwner } from "./agent-configuration.js";
import {
	type AgentConfigurationModelDraft,
	type AgentConfigurationSecretDraft,
	buildAgentConfigurationRequest,
	configurationDraftFromAgent,
} from "./agent-configuration-draft.js";

type ConfigurationSessionState = BrowserSessionState | { kind: "loading" };

type AgentConfigurationScreenProps = {
	agent: AgentProjectionV2;
	commandError?: (Error & { readonly retryable?: boolean }) | null;
	commandResult?: AgentProjectionV2;
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
						Remove {label}
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
				className="font-semibold text-2xl text-slate-950"
			>
				Configuration is unavailable
			</h1>
			<p className="text-slate-600" role="alert">
				This configuration is unavailable.
			</p>
		</section>
	);
}

export function AgentConfigurationScreen({
	agent,
	commandError = null,
	commandResult,
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
		.join(", ");
	const currentSecrets = agent.configuration.secrets
		.map(
			(secret) =>
				`${secret.name} (${secret.isSet ? "set" : "not set"}${secret.version === null ? "" : `, version ${secret.version}`})`,
		)
		.join(", ");
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
			<header className="space-y-2 border-slate-200 border-b pb-5">
				<p className="font-medium text-slate-500 text-sm">Agent</p>
				<h1
					id="agent-configuration-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					Owner settings
				</h1>
				<p className="text-slate-600 text-sm">
					{agentManagementStatusLabels[agent.managementStatus]}
					{agent.serviceAvailability
						? `, ${agentServiceAvailabilityLabel(agent.serviceAvailability)}`
						: ""}
				</p>
			</header>
			{submittedResult ? (
				<p
					ref={resultRef}
					tabIndex={-1}
					className="font-medium text-slate-950 text-sm"
					role="status"
				>
					Configuration submitted:{" "}
					{agentManagementStatusLabels[submittedResult.managementStatus]}.
				</p>
			) : null}
			{commandError ? (
				<p className="text-slate-600 text-sm" role="alert">
					{commandError.retryable === false
						? "Your permission or this Agent changed. Refresh the page."
						: "Unable to save this configuration. Re-enter any Secret or model credential before trying again."}
				</p>
			) : null}
			{submittedResult ? null : (
				<form
					className="space-y-6"
					onSubmit={(event) => {
						event.preventDefault();
						if (submitting) return;
						submitConfiguration();
					}}
				>
					<fieldset
						disabled={submitting}
						className="min-w-0 space-y-6"
						aria-label="Agent configuration"
					>
						<fieldset className="space-y-4">
							<legend className="font-semibold text-slate-950 text-sm">
								Ownership
							</legend>
							<div className="space-y-2">
								<Label htmlFor="configuration-owner-ids">Owner user IDs</Label>
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
						<fieldset className="space-y-4 border-slate-200 border-t pt-5">
							<legend className="font-semibold text-slate-950 text-sm">
								Availability
							</legend>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-2">
									<Label htmlFor="configuration-user-availability">
										User availability IDs
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
										Organization availability IDs
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
								className="space-y-4 border-slate-200 border-t pt-5"
								aria-describedby="wecom-visibility"
							>
								<legend className="font-semibold text-slate-950 text-sm">
									企微渠道
								</legend>
								<p id="wecom-visibility" className="text-slate-600 text-sm">
									群消息和 Agent 回复对群成员可见。Agent 可用范围只限制谁能触发
									Agent，不能阻止群成员阅读已有内容；每位发送者的会话上下文仍独立。
								</p>
								<p className="text-slate-600 text-sm">
									从部署环境取得获准的配置标识后绑定，无需在此填写企微密钥。
								</p>
								{(["wecom_bot", "wecom_app"] as const).map((kind) => {
									const label =
										kind === "wecom_bot" ? "智能机器人" : "自建应用";
									const change = draft.channels?.find((c) => c.kind === kind);
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
																? { kind, enabled: true, bindingReference: "" }
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
														<p className="text-slate-600 text-sm">
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
							<fieldset className="space-y-4 border-slate-200 border-t pt-5">
								<legend className="font-semibold text-slate-950 text-sm">
									Models
								</legend>
								<p className="text-slate-600 text-sm">
									{currentModels || "No selectable models"}
								</p>
								<Label className="min-h-11 gap-3">
									<Checkbox
										disabled={submitting}
										checked={draft.replaceModels}
										onCheckedChange={(checked) =>
											setDraft((current) => ({
												...current,
												replaceModels: checked,
												models:
													checked && current.models.length === 0
														? [blankModel()]
														: current.models,
											}))
										}
									/>
									Replace model configuration
								</Label>
								{draft.replaceModels ? (
									<>
										<DraftRows
											fields={
												[
													{
														key: "optionId",
														label: "Option ID",
														required: true,
													},
													{
														key: "endpointId",
														label: "Endpoint ID",
														required: true,
													},
													{ key: "modelId", label: "Model ID", required: true },
													{
														key: "reasoningLevels",
														label: "Reasoning levels",
														required: true,
													},
													{
														key: "credentialValue",
														label: "Credential value",
														type: "password",
													},
												] as const
											}
											idPrefix="model"
											label="model"
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
											<PlusIcon aria-hidden="true" data-icon="inline-start" />
											Add model
										</Button>
										<div className="grid gap-4 sm:grid-cols-2">
											<div className="space-y-2">
												<Label htmlFor="configuration-default-model">
													Default option ID
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
													Default reasoning level
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
						<fieldset className="space-y-4 border-slate-200 border-t pt-5">
							<legend className="font-semibold text-slate-950 text-sm">
								Secrets
							</legend>
							<p className="text-slate-600 text-sm">
								{currentSecrets || "No Secret configured"}
							</p>
							<DraftRows
								fields={
									[
										{ key: "name", label: "Secret name", required: true },
										{
											key: "value",
											label: "Secret value",
											required: true,
											type: "password",
										},
									] as const
								}
								idPrefix="secret"
								label="secret"
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
								Add Secret
							</Button>
						</fieldset>
						<Button disabled={submitting} type="submit">
							{submitting ? "Saving configuration..." : "Save configuration"}
						</Button>
					</fieldset>
				</form>
			)}
			{agent.source.kind === "custom" && !submittedResult ? (
				<section className="space-y-4 border-slate-200 border-t pt-5">
					<h2 className="font-semibold text-lg text-slate-950">
						Image upgrade
					</h2>
					<p className="text-slate-600 text-sm">
						Current image: {agent.source.imageReference}
					</p>
					<div className="flex flex-col gap-3 sm:flex-row">
						<div className="min-w-0 flex-1 space-y-2">
							<Label htmlFor="configuration-image-reference">
								New image reference
							</Label>
							<Input
								disabled={submitting}
								id="configuration-image-reference"
								onChange={(event) => setImageReference(event.target.value)}
								value={imageReference}
							/>
						</div>
						<Button
							variant="outline"
							className="self-end"
							disabled={submitting || imageReference.trim().length === 0}
							onClick={() => onUpgradeImage(imageReference.trim())}
							type="button"
						>
							{submitting ? "Upgrading image..." : "Upgrade image"}
						</Button>
					</div>
				</section>
			) : null}
		</section>
	);
}
