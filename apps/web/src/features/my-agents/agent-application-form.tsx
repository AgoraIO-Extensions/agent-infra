import { PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import type {
	AgentApplicationCreateRequestV2Writable,
	AgentApplicationProjectionV2,
	AgentApplicationUpdateRequestV2Writable,
	DeploymentConfigurationProjectionV2,
	DeploymentModelEndpointProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type AgentApplicationEnvironmentDraft,
	type AgentApplicationModelDraft,
	type AgentApplicationSourceKind,
	buildAgentApplicationRequest,
	showsModelConfiguration,
	sourceKindFor,
} from "./agent-application-draft.js";
import {
	type AgentApplicationEditAction,
	agentApplicationEditActionLabels,
} from "./my-agent-applications.js";

type AgentApplicationFormProps = { cancelAction?: ReactNode } & (
	| {
			mode: "create";
			deploymentConfiguration: DeploymentConfigurationProjectionV2;
			onSubmit: (body: AgentApplicationCreateRequestV2Writable) => void;
			submitting: boolean;
	  }
	| {
			action: AgentApplicationEditAction;
			application: AgentApplicationProjectionV2;
			deploymentConfiguration: DeploymentConfigurationProjectionV2;
			mode: "update";
			onSubmit: (body: AgentApplicationUpdateRequestV2Writable) => void;
			submitting: boolean;
	  }
);

type DraftField<T extends string> = {
	key: T;
	label: string;
	options?: readonly { value: string; label: string; disabled?: boolean }[];
	required?: boolean;
	type?: "password" | "text";
};

type DraftRowsProps<T extends string> = {
	fields: readonly DraftField<T>[];
	idPrefix: string;
	label: string;
	minimumRows?: number;
	onChange: (index: number, key: T, value: string) => void;
	onRemove: (index: number) => void;
	rows: readonly Record<T, string>[];
};

function blankEnvironment(): AgentApplicationEnvironmentDraft {
	return { name: "", value: "" };
}

function blankModel(): AgentApplicationModelDraft {
	return {
		optionId: "",
		endpointId: "",
		modelId: "",
		reasoningLevels: "",
		credentialValue: "",
	};
}

function optionIdFor(endpointId: string, modelId: string) {
	return `${encodeURIComponent(endpointId)}:${encodeURIComponent(modelId)}`;
}

function modelLabel(
	endpoint: DeploymentModelEndpointProjectionV2,
	modelId: string,
) {
	return `${endpoint.displayName} · ${modelId}`;
}

function templateFor(
	configuration: DeploymentConfigurationProjectionV2,
	templateId: string,
) {
	return configuration.templates.find(
		(template) => template.templateId === templateId,
	);
}

function ModelRows({
	models,
	endpoints,
	requiresReplacementCredential,
	onChange,
	onRemove,
}: {
	models: readonly AgentApplicationModelDraft[];
	endpoints: readonly DeploymentModelEndpointProjectionV2[];
	requiresReplacementCredential: boolean;
	onChange: (
		index: number,
		key: keyof AgentApplicationModelDraft,
		value: string,
	) => void;
	onRemove: (index: number) => void;
}) {
	return (
		<>
			{models.map((model, index) => {
				const endpoint = endpoints.find(
					(item) => item.endpointId === model.endpointId,
				);
				const selectedModel = endpoint?.models.find(
					(item) => item.modelId === model.modelId,
				);
				const modelOptions = endpoint?.models ?? [];
				return (
					<fieldset
						className="grid min-w-0 gap-3 sm:grid-cols-2"
						key={`model-${index}`}
					>
						<legend className="mb-3 font-medium">模型选项 {index + 1}</legend>
						<div className="space-y-2">
							<Label htmlFor={`application-model-option-endpoint-${index}`}>
								模型端点
							</Label>
							<Select
								value={model.endpointId}
								disabled={endpoints.length === 0}
								itemToStringLabel={(value) =>
									endpoints.find((item) => item.endpointId === value)
										?.displayName ?? String(value)
								}
								onValueChange={(value) =>
									value && onChange(index, "endpointId", value)
								}
							>
								<SelectTrigger
									id={`application-model-option-endpoint-${index}`}
									className="h-11 w-full text-base md:text-sm"
								>
									<SelectValue placeholder="选择模型端点" />
								</SelectTrigger>
								<SelectContent>
									{endpoints.map((item) => (
										<SelectItem key={item.endpointId} value={item.endpointId}>
											{item.displayName}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label htmlFor={`application-model-option-model-${index}`}>
								模型
							</Label>
							<Select
								value={model.modelId}
								disabled={modelOptions.length === 0}
								itemToStringLabel={(value) =>
									modelOptions.find((item) => item.modelId === value)
										?.modelId ?? String(value)
								}
								onValueChange={(value) =>
									value && onChange(index, "modelId", value)
								}
							>
								<SelectTrigger
									id={`application-model-option-model-${index}`}
									className="h-11 w-full text-base md:text-sm"
								>
									<SelectValue placeholder="选择模型" />
								</SelectTrigger>
								<SelectContent>
									{modelOptions.map((item) => (
										<SelectItem key={item.modelId} value={item.modelId}>
											{item.modelId}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label>允许的推理档位</Label>
							<div className="flex min-h-11 flex-wrap items-center gap-4">
								{(selectedModel?.reasoningLevels ?? []).map((level) => {
									const selected = model.reasoningLevels
										.split("\n")
										.includes(level);
									return (
										<Label className="min-h-8 gap-2" key={level}>
											<Checkbox
												checked={selected}
												onCheckedChange={(checked) => {
													const levels = new Set(
														model.reasoningLevels.split("\n").filter(Boolean),
													);
													if (checked) levels.add(level);
													else levels.delete(level);
													onChange(
														index,
														"reasoningLevels",
														[...levels].join("\n"),
													);
												}}
											/>
											{level}
										</Label>
									);
								})}
							</div>
						</div>
						<div className="space-y-2">
							<Label htmlFor={`application-model-option-credential-${index}`}>
								模型凭证
							</Label>
							<Input
								autoComplete="new-password"
								id={`application-model-option-credential-${index}`}
								onChange={(event) =>
									onChange(index, "credentialValue", event.target.value)
								}
								required={requiresReplacementCredential}
								type="password"
								value={model.credentialValue}
							/>
						</div>
						{models.length > 1 ? (
							<Button
								variant="outline"
								className="self-end"
								onClick={() => onRemove(index)}
								type="button"
							>
								<Trash2Icon aria-hidden="true" data-icon="inline-start" />
								移除模型选项
							</Button>
						) : null}
					</fieldset>
				);
			})}
		</>
	);
}

function DraftRows<T extends string>({
	fields,
	idPrefix,
	label,
	minimumRows = 0,
	onChange,
	onRemove,
	rows,
}: DraftRowsProps<T>) {
	return (
		<>
			{rows.map((row, index) => (
				<fieldset
					className="grid min-w-0 gap-3 sm:grid-cols-2"
					key={`${label}-${index}`}
				>
					<legend className="mb-3 font-medium">
						{label} {index + 1}
					</legend>
					{fields.map((field) => (
						<div className="space-y-2" key={field.key}>
							<Label htmlFor={`application-${idPrefix}-${field.key}-${index}`}>
								{field.label}
							</Label>
							{field.options ? (
								<Select
									disabled={field.options.length === 0}
									value={row[field.key]}
									itemToStringLabel={(value) =>
										field.options?.find((option) => option.value === value)
											?.label ?? String(value)
									}
									onValueChange={(value) =>
										value && onChange(index, field.key, value)
									}
								>
									<SelectTrigger
										id={`application-${idPrefix}-${field.key}-${index}`}
										className="h-11 w-full text-base md:text-sm"
									>
										<SelectValue placeholder="选择一项" />
									</SelectTrigger>
									<SelectContent>
										{field.options.map((option) => (
											<SelectItem
												key={option.value}
												value={option.value}
												disabled={option.disabled}
											>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<Input
									autoComplete={
										field.type === "password" ? "new-password" : undefined
									}
									id={`application-${idPrefix}-${field.key}-${index}`}
									onChange={(event) =>
										onChange(index, field.key, event.target.value)
									}
									required={field.required}
									type={field.type ?? "text"}
									value={row[field.key]}
								/>
							)}
						</div>
					))}
					{rows.length > minimumRows ? (
						<Button
							variant="outline"
							className="self-end"
							onClick={() => onRemove(index)}
							type="button"
						>
							<Trash2Icon aria-hidden="true" data-icon="inline-start" />
							移除{label}
						</Button>
					) : null}
				</fieldset>
			))}
		</>
	);
}

export function AgentApplicationForm(props: AgentApplicationFormProps) {
	const application = props.mode === "update" ? props.application : undefined;
	const configuration = application?.configuration;
	const deployment = props.deploymentConfiguration;
	const [name, setName] = useState(application?.name ?? "");
	const [description, setDescription] = useState(
		application?.description ?? "",
	);
	const [templateId, setTemplateId] = useState(
		application?.source.kind === "standard"
			? application.source.templateId
			: "",
	);
	const [sourceKind, setSourceKind] = useState<AgentApplicationSourceKind>(() =>
		sourceKindFor(application?.source),
	);
	const [imageReference, setImageReference] = useState(
		application?.source.kind === "custom"
			? application.source.imageReference
			: "",
	);
	const [identityResponsibility, setIdentityResponsibility] = useState<
		"platform-managed" | "self-managed"
	>(
		application?.source.kind === "custom" &&
			application.source.interactionMode === "self-managed"
			? application.source.identityResponsibility
			: "platform-managed",
	);
	const [coOwnerIds, setCoOwnerIds] = useState(
		configuration?.owners.map((owner) => owner.userId).join("\n") ?? "",
	);
	const [userAvailabilityIds, setUserAvailabilityIds] = useState(
		configuration?.availability
			.filter((target) => target.kind === "user")
			.map((target) => target.userId)
			.join("\n") ?? "",
	);
	const [organizationAvailabilityIds, setOrganizationAvailabilityIds] =
		useState(
			configuration?.availability
				.filter((target) => target.kind === "organization")
				.map((target) => target.organizationId)
				.join("\n") ?? "",
		);
	const [environment, setEnvironment] = useState<
		AgentApplicationEnvironmentDraft[]
	>(configuration?.environment.map((value) => ({ ...value })) ?? []);
	const [secrets, setSecrets] = useState<AgentApplicationEnvironmentDraft[]>(
		[],
	);
	const [configureModels, setConfigureModels] = useState(false);
	const [models, setModels] = useState<AgentApplicationModelDraft[]>(() => {
		if (props.mode === "create") return [blankModel()];
		const endpoints = props.deploymentConfiguration.modelCatalog.endpoints;
		return (configuration?.modelOptions ?? []).map((option) => {
			const endpointIds = endpoints
				.filter((endpoint) =>
					endpoint.models.some((model) => model.modelId === option.modelId),
				)
				.map((endpoint) => endpoint.endpointId);
			return {
				credentialValue: "",
				endpointId: endpointIds.length === 1 ? (endpointIds[0] ?? "") : "",
				modelId: option.modelId,
				optionId: option.optionId,
				reasoningLevels: option.reasoningLevels.join("\n"),
			};
		});
	});
	const [defaultModelOptionId, setDefaultModelOptionId] = useState(
		configuration?.defaultModelOptionId ?? "",
	);
	const [defaultReasoningLevel, setDefaultReasoningLevel] = useState(
		configuration?.defaultReasoningLevel ?? "",
	);
	const modelConfigurationVisible = showsModelConfiguration(
		props.mode,
		sourceKind,
		configureModels,
	);
	const requiresReplacementCredential =
		props.mode === "create" ||
		(application?.source.kind !== "standard" && sourceKind === "standard");
	const selectedTemplate = templateFor(deployment, templateId);
	const modelCatalogReady = deployment.modelCatalog.status === "populated";
	const standardChoicesBlocked =
		sourceKind === "standard" &&
		(deployment.templates.length === 0 || !modelCatalogReady);
	const modelEndpoints = deployment.modelCatalog.endpoints;
	useEffect(() => {
		if (props.mode !== "update" || modelEndpoints.length === 0) return;
		setModels((current) => {
			let changed = false;
			const next = current.map((model) => {
				if (model.endpointId || !model.modelId) return model;
				const endpointIds = modelEndpoints
					.filter((endpoint) =>
						endpoint.models.some((entry) => entry.modelId === model.modelId),
					)
					.map((endpoint) => endpoint.endpointId);
				if (endpointIds.length !== 1) return model;
				changed = true;
				return { ...model, endpointId: endpointIds[0] ?? "" };
			});
			return changed ? next : current;
		});
	}, [modelEndpoints, props.mode]);
	const environmentOptions = Array.from(
		new Set([
			...(selectedTemplate?.allowedEnvironmentKeys ?? []),
			...environment.map((item) => item.name).filter(Boolean),
		]),
	).map((value) => ({
		value,
		label: value,
		disabled: !selectedTemplate?.allowedEnvironmentKeys.includes(value),
	}));
	const secretOptions = (selectedTemplate?.allowedSecretKeys ?? []).map(
		(value) => ({ value, label: value }),
	);
	const staleTemplate = templateId.length > 0 && selectedTemplate === undefined;
	const staleModel =
		modelConfigurationVisible &&
		models.some((model) => {
			const levels = model.reasoningLevels.split("\n").filter(Boolean);
			const definition = modelEndpoints
				.find((endpoint) => endpoint.endpointId === model.endpointId)
				?.models.find((entry) => entry.modelId === model.modelId);
			return (
				!model.optionId ||
				!model.endpointId ||
				!model.modelId ||
				levels.length === 0 ||
				!definition ||
				!levels.every((level) => definition.reasoningLevels.includes(level))
			);
		});
	const defaultModelOptions = models.filter(
		(model) => model.optionId && model.endpointId && model.modelId,
	);
	const defaultModel = models.find(
		(model) => model.optionId === defaultModelOptionId,
	);
	const defaultModelDefinition = modelEndpoints
		.find((endpoint) => endpoint.endpointId === defaultModel?.endpointId)
		?.models.find((model) => model.modelId === defaultModel?.modelId);
	const defaultReasoningLevels =
		defaultModelDefinition?.reasoningLevels.filter((level) =>
			defaultModel?.reasoningLevels.split("\n").includes(level),
		) ?? [];
	const selectedDefaultReasoningLevel = defaultReasoningLevels.includes(
		defaultReasoningLevel,
	)
		? defaultReasoningLevel
		: "";
	const configurationMessage =
		deployment.status === "stale" || deployment.modelCatalog.status === "stale"
			? "部署选项已过期，请重新加载后再提交。"
			: deployment.status === "unavailable" ||
					deployment.modelCatalog.status === "unavailable"
				? "部署选项暂不可用，请重新加载；标准模板申请暂不能提交。"
				: deployment.status === "empty" ||
						(deployment.templates.length === 0 && sourceKind === "standard") ||
						(deployment.modelCatalog.status === "empty" &&
							sourceKind === "standard")
					? "当前部署没有可用的标准模板或模型选项，请联系管理员配置后重试。"
					: staleTemplate || staleModel
						? "当前申请包含已移除的部署选项，请重新加载并重新选择。"
						: undefined;

	const submit = () => {
		if (standardChoicesBlocked || staleTemplate || staleModel) return;
		const draft = {
			name,
			description,
			sourceKind,
			templateId,
			imageReference,
			identityResponsibility,
			coOwnerIds,
			userAvailabilityIds,
			organizationAvailabilityIds,
			environment,
			secrets,
			source: application?.source,
			configureModels,
			models,
			defaultModelOptionId,
			defaultReasoningLevel: selectedDefaultReasoningLevel,
		};
		setSecrets([]);
		setModels((current) =>
			current.map((model) => ({ ...model, credentialValue: "" })),
		);
		if (props.mode === "create") {
			props.onSubmit(buildAgentApplicationRequest("create", draft));
			return;
		}
		props.onSubmit(buildAgentApplicationRequest("update", draft));
	};

	return (
		<form
			className="space-y-6"
			onSubmit={(event) => {
				event.preventDefault();
				if (props.submitting) return;
				submit();
			}}
		>
			<fieldset
				disabled={props.submitting}
				className="min-w-0 space-y-6"
				aria-label="Agent 申请"
			>
				<fieldset className="form-section">
					<legend className="font-semibold text-lg">基本信息</legend>
					<p className="text-muted-foreground text-sm">
						说明 Agent 的用途，便于管理员审阅和使用者了解。
					</p>
					<div className="form-grid">
						<div className="space-y-2">
							<Label htmlFor="application-name">Agent 名称</Label>
							<Input
								id="application-name"
								onChange={(event) => setName(event.target.value)}
								required
								value={name}
							/>
						</div>
						<div className="space-y-2 sm:col-span-2">
							<Label htmlFor="application-description">用途说明</Label>
							<Textarea
								className="min-h-28"
								id="application-description"
								onChange={(event) => setDescription(event.target.value)}
								required
								value={description}
							/>
						</div>
					</div>
				</fieldset>
				<fieldset className="form-section">
					<legend className="font-semibold text-foreground text-lg">
						Agent 来源
					</legend>
					<p
						className="text-muted-foreground text-sm"
						id="application-source-help"
					>
						从部署提供的标准模板中选择，或填写自定义镜像地址。已有申请的来源不能更改。
					</p>
					{configurationMessage ? (
						<p className="alert text-destructive" role="status">
							{configurationMessage}
						</p>
					) : null}
					<div className="form-grid">
						<div className="space-y-2">
							<Label htmlFor="application-source-kind">Agent 来源</Label>
							<Select
								disabled={props.mode === "update"}
								value={sourceKind}
								itemToStringLabel={(value) =>
									(
										({
											standard: "标准模板",
											"custom-platform-adapter": "自定义 Agent · 平台交互入口",
											"custom-self-managed": "自定义 Agent · 自有交互入口",
										}) as Record<string, string>
									)[String(value)] ?? String(value)
								}
								onValueChange={(value) => {
									if (!value) return;
									const kind = value as AgentApplicationSourceKind;
									setSourceKind(kind);
									if (kind === "standard") {
										if (models.length === 0) setModels([blankModel()]);
										if (sourceKind !== "standard") setConfigureModels(true);
									}
									if (kind !== "standard") setConfigureModels(false);
								}}
							>
								<SelectTrigger
									id="application-source-kind"
									aria-describedby="application-source-help"
									className="h-11 w-full text-base md:text-sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="standard">标准模板</SelectItem>
									<SelectItem value="custom-platform-adapter">
										自定义 Agent · 平台交互入口
									</SelectItem>
									<SelectItem value="custom-self-managed">
										自定义 Agent · 自有交互入口
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{sourceKind === "standard" ? (
							<div className="space-y-2">
								<Label htmlFor="application-template-id">标准模板 ID</Label>
								<Select
									disabled={
										props.mode === "update" || deployment.templates.length === 0
									}
									value={templateId}
									itemToStringLabel={(value) =>
										deployment.templates.find(
											(template) => template.templateId === value,
										)?.displayName ??
										(staleTemplate ? "已移除模板（请重新加载）" : String(value))
									}
									onValueChange={(value) => value && setTemplateId(value)}
								>
									<SelectTrigger
										id="application-template-id"
										aria-describedby="application-source-help"
										className="h-11 w-full text-base md:text-sm"
									>
										<SelectValue placeholder="选择标准模板" />
									</SelectTrigger>
									<SelectContent>
										{deployment.templates.map((template) => (
											<SelectItem
												key={template.templateId}
												value={template.templateId}
											>
												{template.displayName}
											</SelectItem>
										))}
										{staleTemplate ? (
											<SelectItem disabled value={templateId}>
												已移除模板（请重新加载）
											</SelectItem>
										) : null}
									</SelectContent>
								</Select>
								{selectedTemplate ? (
									<p className="text-muted-foreground text-sm">
										{selectedTemplate.connectionEnabled
											? "支持 Connection"
											: "不支持 Connection"}
									</p>
								) : null}
							</div>
						) : (
							<div className="space-y-2">
								<Label htmlFor="application-image-reference">镜像地址</Label>
								<Input
									disabled={props.mode === "update"}
									id="application-image-reference"
									onChange={(event) => setImageReference(event.target.value)}
									required
									value={imageReference}
								/>
							</div>
						)}
						{sourceKind === "custom-self-managed" ? (
							<div className="space-y-2">
								<Label htmlFor="application-identity-responsibility">
									入口身份校验
								</Label>
								<Select
									disabled={props.mode === "update"}
									value={identityResponsibility}
									itemToStringLabel={(value) =>
										(
											({
												"platform-managed": "由平台校验",
												"self-managed": "由自有入口校验",
											}) as Record<string, string>
										)[String(value)] ?? String(value)
									}
									onValueChange={(value) => {
										if (
											value === "platform-managed" ||
											value === "self-managed"
										)
											setIdentityResponsibility(value);
									}}
								>
									<SelectTrigger
										id="application-identity-responsibility"
										className="h-11 w-full text-base md:text-sm"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="platform-managed">由平台校验</SelectItem>
										<SelectItem value="self-managed">由自有入口校验</SelectItem>
									</SelectContent>
								</Select>
							</div>
						) : null}
					</div>
				</fieldset>
				<fieldset className="form-section">
					<legend className="font-semibold text-foreground text-lg">
						Owner 与使用范围
					</legend>
					<p
						className="text-muted-foreground text-sm"
						id="application-access-help"
					>
						当前申请人自动成为 Owner。可补充共同 Owner
						及使用范围，每行填写一个用户或组织 ID。
					</p>
					<div className="form-grid">
						<div className="space-y-2">
							<Label htmlFor="application-co-owner-ids">
								共同 Owner 用户 ID
							</Label>
							<Textarea
								className="min-h-24"
								id="application-co-owner-ids"
								aria-describedby="application-access-help"
								onChange={(event) => setCoOwnerIds(event.target.value)}
								value={coOwnerIds}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="application-user-availability-ids">
								可使用的用户 ID
							</Label>
							<Textarea
								className="min-h-24"
								id="application-user-availability-ids"
								aria-describedby="application-access-help"
								onChange={(event) => setUserAvailabilityIds(event.target.value)}
								value={userAvailabilityIds}
							/>
						</div>
						<div className="space-y-2 sm:col-span-2">
							<Label htmlFor="application-organization-availability-ids">
								可使用的组织 ID
							</Label>
							<Textarea
								className="min-h-24"
								id="application-organization-availability-ids"
								aria-describedby="application-access-help"
								onChange={(event) =>
									setOrganizationAvailabilityIds(event.target.value)
								}
								value={organizationAvailabilityIds}
							/>
						</div>
					</div>
				</fieldset>
				<fieldset className="form-section">
					<legend className="font-semibold text-foreground text-lg">
						环境变量
					</legend>
					<p className="text-muted-foreground text-sm">
						仅填写部署允许的配置项；凭证请使用 Secret 或模型凭证字段。
					</p>
					<DraftRows
						fields={[
							{
								key: "name",
								label: "变量名称",
								options:
									sourceKind === "standard" ? environmentOptions : undefined,
								required: true,
							},
							{ key: "value", label: "变量值", required: true },
						]}
						idPrefix="environment"
						label="环境变量"
						onChange={(index, key, value) =>
							setEnvironment((current) =>
								current.map((item, itemIndex) =>
									itemIndex === index ? { ...item, [key]: value } : item,
								),
							)
						}
						onRemove={(index) =>
							setEnvironment((current) =>
								current.filter((_, itemIndex) => itemIndex !== index),
							)
						}
						rows={environment}
					/>
					<Button
						variant="outline"
						onClick={() =>
							setEnvironment((current) => [...current, blankEnvironment()])
						}
						type="button"
					>
						<PlusIcon aria-hidden="true" data-icon="inline-start" />
						添加环境变量
					</Button>
				</fieldset>
				<fieldset className="form-section">
					<legend className="font-semibold text-foreground text-lg">
						Secret
					</legend>
					<p className="text-muted-foreground text-sm">
						只提交新增或替换值，已有 Secret
						不回显。提交后会清空输入，重试时需重新填写替换值。
					</p>
					<DraftRows
						fields={[
							{
								key: "name",
								label: "Secret 名称",
								options: sourceKind === "standard" ? secretOptions : undefined,
								required: true,
							},
							{
								key: "value",
								label: "替换值",
								required: true,
								type: "password",
							},
						]}
						idPrefix="secret"
						label="Secret"
						onChange={(index, key, value) =>
							setSecrets((current) =>
								current.map((item, itemIndex) =>
									itemIndex === index ? { ...item, [key]: value } : item,
								),
							)
						}
						onRemove={(index) =>
							setSecrets((current) =>
								current.filter((_, itemIndex) => itemIndex !== index),
							)
						}
						rows={secrets}
					/>
					<Button
						variant="outline"
						onClick={() =>
							setSecrets((current) => [...current, blankEnvironment()])
						}
						type="button"
					>
						<PlusIcon aria-hidden="true" data-icon="inline-start" />
						添加 Secret
					</Button>
				</fieldset>
				{sourceKind === "standard" ? (
					<fieldset className="form-section">
						<legend className="font-semibold text-foreground text-lg">
							模型配置
						</legend>
						<p className="text-muted-foreground text-sm">
							标准模板在申请时必须配置模型。填写获准端点和模型
							ID，允许的推理档位每行一项；默认项须属于本次配置。
						</p>
						{props.mode === "update" ? (
							<Label className="min-h-11 gap-3">
								<Checkbox
									disabled={props.submitting}
									checked={configureModels}
									onCheckedChange={(checked) => {
										setConfigureModels(checked);
										if (checked && models.length === 0) {
											setModels([blankModel()]);
										}
									}}
								/>
								修改模型配置
							</Label>
						) : null}
						{modelConfigurationVisible ? (
							<>
								<ModelRows
									endpoints={modelEndpoints}
									models={models}
									requiresReplacementCredential={requiresReplacementCredential}
									onChange={(index, key, value) =>
										setModels((current) =>
											current.map((item, itemIndex) =>
												itemIndex !== index
													? item
													: key === "endpointId" || key === "modelId"
														? {
																...item,
																[key]: value,
																credentialValue: "",
																...(key === "endpointId"
																	? {
																			modelId: "",
																			reasoningLevels: "",
																			optionId: "",
																		}
																	: {
																			optionId:
																				item.endpointId && value
																					? optionIdFor(item.endpointId, value)
																					: "",
																			reasoningLevels: "",
																		}),
															}
														: { ...item, [key]: value },
											),
										)
									}
									onRemove={(index) =>
										setModels((current) =>
											current.filter((_, itemIndex) => itemIndex !== index),
										)
									}
								/>
								<div className="form-grid">
									<div className="space-y-2">
										<Label htmlFor="application-default-model-option">
											默认模型
										</Label>
										<Select
											value={defaultModelOptionId}
											disabled={defaultModelOptions.length === 0}
											itemToStringLabel={(value) => {
												const model = models.find(
													(item) => item.optionId === value,
												);
												const endpoint = model
													? modelEndpoints.find(
															(item) => item.endpointId === model.endpointId,
														)
													: undefined;
												return model && endpoint
													? modelLabel(endpoint, model.modelId)
													: "已移除模型";
											}}
											onValueChange={(value) =>
												value && setDefaultModelOptionId(value)
											}
										>
											<SelectTrigger
												id="application-default-model-option"
												className="h-11 w-full text-base md:text-sm"
											>
												<SelectValue placeholder="选择默认模型" />
											</SelectTrigger>
											<SelectContent>
												{defaultModelOptions.map((model) => {
													const endpoint = modelEndpoints.find(
														(item) => item.endpointId === model.endpointId,
													);
													return (
														<SelectItem
															key={model.optionId}
															value={model.optionId}
														>
															{endpoint
																? modelLabel(endpoint, model.modelId)
																: "已移除模型"}
														</SelectItem>
													);
												})}
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-2">
										<Label htmlFor="application-default-reasoning-level">
											默认推理档位
										</Label>
										<Select
											value={selectedDefaultReasoningLevel}
											disabled={!defaultModelDefinition}
											onValueChange={(value) =>
												value && setDefaultReasoningLevel(value)
											}
										>
											<SelectTrigger
												id="application-default-reasoning-level"
												className="h-11 w-full text-base md:text-sm"
											>
												<SelectValue placeholder="选择默认推理档位" />
											</SelectTrigger>
											<SelectContent>
												{defaultReasoningLevels.map((value) => (
													<SelectItem key={value} value={value}>
														{value}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
								</div>
								<Button
									variant="outline"
									onClick={() =>
										setModels((current) => [...current, blankModel()])
									}
									type="button"
								>
									<PlusIcon aria-hidden="true" data-icon="inline-start" />
									添加模型选项
								</Button>
							</>
						) : null}
					</fieldset>
				) : null}
				<div className="form-footer">
					<Button disabled={props.submitting} type="submit">
						{props.submitting
							? "正在提交…"
							: props.mode === "update"
								? agentApplicationEditActionLabels[props.action]
								: "提交申请"}
					</Button>
					{props.cancelAction}
				</div>
			</fieldset>
		</form>
	);
}
