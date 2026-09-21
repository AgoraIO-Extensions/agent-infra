import { PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

import type {
	AgentApplicationCreateRequestV2Writable,
	AgentApplicationProjectionV2,
	AgentApplicationUpdateRequestV2Writable,
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
			onSubmit: (body: AgentApplicationCreateRequestV2Writable) => void;
			submitting: boolean;
	  }
	| {
			action: AgentApplicationEditAction;
			application: AgentApplicationProjectionV2;
			mode: "update";
			onSubmit: (body: AgentApplicationUpdateRequestV2Writable) => void;
			submitting: boolean;
	  }
);

type DraftField<T extends string> = {
	key: T;
	label: string;
	multiline?: boolean;
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
							{field.multiline ? (
								<Textarea
									className="min-h-20"
									id={`application-${idPrefix}-${field.key}-${index}`}
									onChange={(event) =>
										onChange(index, field.key, event.target.value)
									}
									required={field.required}
									value={row[field.key]}
								/>
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
	const [models, setModels] = useState<AgentApplicationModelDraft[]>(() =>
		props.mode === "create" ? [blankModel()] : [],
	);
	const [defaultModelOptionId, setDefaultModelOptionId] = useState("");
	const [defaultReasoningLevel, setDefaultReasoningLevel] = useState("");
	const modelConfigurationVisible = showsModelConfiguration(
		props.mode,
		sourceKind,
		configureModels,
	);
	const requiresReplacementCredential =
		props.mode === "create" ||
		(application?.source.kind !== "standard" && sourceKind === "standard");

	const submit = () => {
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
			defaultReasoningLevel,
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
						填写部署提供的标准模板 ID 或镜像地址。已有申请的来源不能更改。
					</p>
					<div className="form-grid">
						<div className="space-y-2">
							<Label htmlFor="application-source-kind">Agent 来源</Label>
							<NativeSelect
								disabled={props.mode === "update"}
								id="application-source-kind"
								onChange={(event) => {
									const kind = event.target.value as AgentApplicationSourceKind;
									setSourceKind(kind);
									if (kind === "standard") {
										if (models.length === 0) setModels([blankModel()]);
										if (sourceKind !== "standard") setConfigureModels(true);
									}
									if (kind !== "standard") setConfigureModels(false);
								}}
								value={sourceKind}
							>
								<NativeSelectOption value="standard">
									标准模板
								</NativeSelectOption>
								<NativeSelectOption value="custom-platform-adapter">
									自定义 Agent · 平台交互入口
								</NativeSelectOption>
								<NativeSelectOption value="custom-self-managed">
									自定义 Agent · 自有交互入口
								</NativeSelectOption>
							</NativeSelect>
						</div>
						{sourceKind === "standard" ? (
							<div className="space-y-2">
								<Label htmlFor="application-template-id">标准模板 ID</Label>
								<Input
									disabled={props.mode === "update"}
									id="application-template-id"
									aria-describedby="application-source-help"
									onChange={(event) => setTemplateId(event.target.value)}
									required
									value={templateId}
								/>
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
								<NativeSelect
									disabled={props.mode === "update"}
									id="application-identity-responsibility"
									onChange={(event) =>
										setIdentityResponsibility(
											event.target.value as "platform-managed" | "self-managed",
										)
									}
									value={identityResponsibility}
								>
									<NativeSelectOption value="platform-managed">
										由平台校验
									</NativeSelectOption>
									<NativeSelectOption value="self-managed">
										由自有入口校验
									</NativeSelectOption>
								</NativeSelect>
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
							{ key: "name", label: "变量名称", required: true },
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
							{ key: "name", label: "Secret 名称", required: true },
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
								<DraftRows
									fields={[
										{
											key: "optionId",
											label: "模型选项 ID",
											required: true,
										},
										{
											key: "endpointId",
											label: "获准端点 ID",
											required: true,
										},
										{ key: "modelId", label: "模型 ID", required: true },
										{
											key: "reasoningLevels",
											label: "允许的推理档位",
											multiline: true,
											required: true,
										},
										{
											key: "credentialValue",
											label: "模型凭证",
											required: requiresReplacementCredential,
											type: "password",
										},
									]}
									idPrefix="model-option"
									label="模型选项"
									minimumRows={1}
									onChange={(index, key, value) =>
										setModels((current) =>
											current.map((item, itemIndex) =>
												itemIndex === index ? { ...item, [key]: value } : item,
											),
										)
									}
									onRemove={(index) =>
										setModels((current) =>
											current.filter((_, itemIndex) => itemIndex !== index),
										)
									}
									rows={models}
								/>
								<div className="form-grid">
									<div className="space-y-2">
										<Label htmlFor="application-default-model-option">
											默认模型选项 ID
										</Label>
										<Input
											id="application-default-model-option"
											onChange={(event) =>
												setDefaultModelOptionId(event.target.value)
											}
											required
											value={defaultModelOptionId}
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor="application-default-reasoning-level">
											默认推理档位
										</Label>
										<Input
											id="application-default-reasoning-level"
											onChange={(event) =>
												setDefaultReasoningLevel(event.target.value)
											}
											required
											value={defaultReasoningLevel}
										/>
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
