import { ArrowRightIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLegend } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
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
import { cjkSpaced } from "@/lib/cjk-spacing";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
import type {
	AgentApplicationCreateRequestV2Writable,
	AgentApplicationProjectionV2,
	AgentApplicationUpdateRequestV2Writable,
	DeploymentConfigurationProjectionV2,
	DeploymentModelEndpointProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import type { AgentDefaultRelayKeyCheck } from "../agent-configuration/agent-configuration.js";
import { useKeylessKeyCheck } from "../agent-configuration/use-keyless-key-check.js";
import { agentSourceReferenceLabel } from "../agent-management-status.js";
import { DirectoryPicker } from "../directory-fields.js";
import {
	type AgentApplicationEnvironmentDraft,
	type AgentApplicationFieldErrors,
	type AgentApplicationModelDraft,
	type AgentApplicationSourceKind,
	buildAgentApplicationRequest,
	showsModelConfiguration,
	sourceKindFor,
	validateAgentApplicationDraft,
} from "./agent-application-draft.js";
import { ApplicationKeylessModelEditor } from "./application-keyless-model-editor.js";
import {
	applicationTemplateChoices,
	templateReadinessMessages,
} from "./deployment-configuration.js";
import {
	formatMultiServiceManifestSummary,
	MULTI_SERVICE_MANIFEST_MAX_BYTES,
	type MultiServiceManifestSummary,
	parseMultiServiceManifest,
} from "./multi-service-manifest.js";
import {
	type AgentApplicationEditAction,
	agentApplicationEditActionLabels,
} from "./my-agent-applications.js";

type AgentApplicationFormProps = {
	cancelAction?: ReactNode;
	showDeploymentStatus?: boolean;
} & (
	| {
			mode: "create";
			deploymentConfiguration: DeploymentConfigurationProjectionV2;
			deploymentConfigurationRetryable?: boolean;
			onSubmit: (body: AgentApplicationCreateRequestV2Writable) => void;
			serverError?: AgentApplicationServerError | null;
			submitting: boolean;
	  }
	| {
			action: AgentApplicationEditAction;
			application: AgentApplicationProjectionV2;
			deploymentConfiguration: DeploymentConfigurationProjectionV2;
			deploymentConfigurationRetryable?: boolean;
			mode: "update";
			/** 模型由默认 Relay Key 管理：更换模型集合要重新提交 Key，并只能从该 Key 的候选里选。 */
			defaultRelayKeyManaged?: boolean;
			/** 读取当前配置修订与 Key 版本后检查 Key 可见的模型。 */
			onCheckDefaultRelayKey?: (
				keyValue: string,
			) => Promise<AgentDefaultRelayKeyCheck>;
			onSubmit: (body: AgentApplicationUpdateRequestV2Writable) => void;
			serverError?: AgentApplicationServerError | null;
			submitting: boolean;
	  }
);

export type AgentApplicationServerError = {
	readonly code?: string;
};

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
	errorFor?: (index: number, key: T) => string | undefined;
	rows: readonly Record<T, string>[];
};

function fieldId(key: string) {
	if (key === "defaultModelOptionId") return "application-default-model-option";
	if (key === "defaultReasoningLevel")
		return "application-default-reasoning-level";
	const modelField =
		/^model\.(\d+)\.(endpointId|modelId|reasoningLevels)$/.exec(key);
	if (modelField) {
		const [, index, field] = modelField;
		const control =
			field === "endpointId"
				? "endpoint"
				: field === "modelId"
					? "model"
					: field === "reasoningLevels"
						? "reasoning"
						: "credential";
		return `application-model-option-${control}-${index}`;
	}
	return `application-${key
		.replaceAll(".", "-")
		.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

function errorId(key: string) {
	return `${fieldId(key)}-error`;
}

function describedBy(...ids: (string | undefined)[]) {
	return ids.filter(Boolean).join(" ") || undefined;
}

function firstFieldError(errors: AgentApplicationFieldErrors) {
	if (Object.keys(errors).length === 0) return undefined;
	const controls = Object.keys(errors)
		.map((key) => document.getElementById(fieldId(key)))
		.filter((element): element is HTMLElement => element instanceof HTMLElement)
		.sort((left, right) =>
			left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
				? -1
				: 1,
		);
	const isActionable = (element: HTMLElement) => {
		if (element.closest("[disabled]")) return false;
		if (!(element instanceof HTMLFieldSetElement)) return true;
		return Array.from(
			element.querySelectorAll(
				"input, button, select, textarea, [role='checkbox']",
			),
		).some(
			(control) =>
				control instanceof HTMLElement && !control.closest("[disabled]"),
		);
	};
	const fallback =
		document.getElementById("application-deployment-status") ??
		document.getElementById("application-add-model-option");
	return controls.find(isActionable) ?? fallback;
}

function reindexRowErrors(
	errors: AgentApplicationFieldErrors,
	prefix: "environment" | "secret" | "model",
	removedIndex: number,
) {
	const next: AgentApplicationFieldErrors = {};
	for (const [key, message] of Object.entries(errors)) {
		const [keyPrefix, indexValue, ...fieldParts] = key.split(".");
		if (keyPrefix !== prefix || fieldParts.length === 0) {
			next[key] = message;
			continue;
		}
		const rowIndex = Number(indexValue);
		if (!Number.isInteger(rowIndex) || rowIndex === removedIndex) continue;
		const nextIndex = rowIndex > removedIndex ? rowIndex - 1 : rowIndex;
		next[`${prefix}.${nextIndex}.${fieldParts.join(".")}`] = message;
	}
	return next;
}

function recomputeDuplicateNameErrors(
	errors: AgentApplicationFieldErrors,
	prefix: "environment" | "secret",
	rows: readonly AgentApplicationEnvironmentDraft[],
) {
	const duplicateMessage = "名称不能重复。";
	for (const errorKey of Object.keys(errors)) {
		if (
			errorKey.startsWith(`${prefix}.`) &&
			errorKey.endsWith(".name") &&
			errors[errorKey] === duplicateMessage
		)
			delete errors[errorKey];
	}
	const nameCounts = new Map<string, number>();
	for (const row of rows) {
		const name = row.name.trim();
		if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	}
	rows.forEach((row, index) => {
		if (row.name.trim() && nameCounts.get(row.name.trim()) !== 1)
			errors[`${prefix}.${index}.name`] = duplicateMessage;
	});
}

function recomputeDuplicateModelErrors(
	errors: AgentApplicationFieldErrors,
	rows: readonly AgentApplicationModelDraft[],
) {
	const duplicateMessage = "模型选项不能重复。";
	for (const errorKey of Object.keys(errors)) {
		if (
			errorKey.startsWith("model.") &&
			errorKey.endsWith(".modelId") &&
			errors[errorKey] === duplicateMessage
		)
			delete errors[errorKey];
	}
	const keyIndexes = new Map<string, number[]>();
	rows.forEach((model, index) => {
		const keys = [
			...(model.optionId ? [`id:${model.optionId}`] : []),
			...(model.endpointId && model.modelId
				? [`pair:${JSON.stringify([model.endpointId, model.modelId])}`]
				: []),
		];
		for (const key of keys) {
			const indexes = keyIndexes.get(key) ?? [];
			indexes.push(index);
			keyIndexes.set(key, indexes);
		}
	});
	for (const indexes of keyIndexes.values()) {
		if (indexes.length < 2) continue;
		for (const index of indexes)
			errors[`model.${index}.modelId`] = duplicateMessage;
	}
}

// 设计 .field-error：12px / 1.5 / --danger-ink，与上方控件之间是字段 gap 7px + 6px 外边距；
// 校验结果礼貌播报，不打断读屏（焦点已移到首个错误字段）。
function FieldError({ id, message }: { id: string; message?: string }) {
	return message ? (
		<p
			aria-live="polite"
			className="field-error mt-[6px] text-(--danger-ink) text-[12px] leading-[1.5]"
			id={id}
		>
			{message}
		</p>
	) : null;
}

function blankEnvironment(): AgentApplicationEnvironmentDraft {
	return { name: "", value: "" };
}

function blankModel(): AgentApplicationModelDraft {
	return {
		endpointId: "",
		modelId: "",
		optionId: "",
		reasoningLevels: "",
	};
}

function optionIdFor(endpointId: string, modelId: string) {
	return `${encodeURIComponent(endpointId)}:${encodeURIComponent(modelId)}`;
}

function legacyOptionIdFor(endpointId: string, modelId: string) {
	return `${endpointId}:${modelId}`;
}

function endpointIdForModelOption(
	option: Pick<AgentApplicationModelDraft, "modelId" | "optionId">,
	endpoints: readonly DeploymentModelEndpointProjectionV2[],
) {
	const exactMatches = endpoints.filter(
		(endpoint) =>
			option.optionId === optionIdFor(endpoint.endpointId, option.modelId),
	);
	if (exactMatches.length > 1) return "";
	const exact = exactMatches[0];
	const legacyExact = endpoints.filter(
		(endpoint) =>
			option.optionId ===
			legacyOptionIdFor(endpoint.endpointId, option.modelId),
	);
	if (
		exact &&
		legacyExact.some((endpoint) => endpoint.endpointId !== exact.endpointId)
	)
		return "";
	if (exact) return exact.endpointId;
	if (legacyExact.length === 1) return legacyExact[0]?.endpointId ?? "";
	return "";
}

function canonicalOptionIdForModelOption(
	option: Pick<AgentApplicationModelDraft, "modelId" | "optionId">,
	endpoints: readonly DeploymentModelEndpointProjectionV2[],
) {
	const endpointId = endpointIdForModelOption(option, endpoints);
	return endpointId ? optionIdFor(endpointId, option.modelId) : option.optionId;
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
	errors,
	onChange,
	onRemove,
}: {
	models: readonly AgentApplicationModelDraft[];
	endpoints: readonly DeploymentModelEndpointProjectionV2[];
	errors: AgentApplicationFieldErrors;
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
				const modelOptions = [
					...new Set(endpoint?.models.map((item) => item.modelId) ?? []),
				].map((modelId) => ({ value: modelId, label: modelId }));
				return (
					<fieldset
						className="model-option-fieldset grid min-w-0 gap-3 sm:grid-cols-2"
						key={`model-${index}`}
					>
						<FieldLegend className="mb-3">模型选项 {index + 1}</FieldLegend>
						<Field className="model-option-endpoint">
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
									aria-describedby={
										errors[`model.${index}.endpointId`]
											? errorId(`model.${index}.endpointId`)
											: undefined
									}
									aria-invalid={
										errors[`model.${index}.endpointId`] ? true : undefined
									}
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
							<FieldError
								id={errorId(`model.${index}.endpointId`)}
								message={errors[`model.${index}.endpointId`]}
							/>
						</Field>
						<Field className="model-option-model">
							<Label htmlFor={`application-model-option-model-${index}`}>
								模型
							</Label>
							<Select
								value={model.modelId}
								disabled={modelOptions.length === 0}
								itemToStringLabel={(value) =>
									modelOptions.find((item) => item.value === value)?.label ??
									String(value)
								}
								onValueChange={(value) =>
									value && onChange(index, "modelId", value)
								}
							>
								<SelectTrigger
									id={`application-model-option-model-${index}`}
									aria-describedby={
										errors[`model.${index}.modelId`]
											? errorId(`model.${index}.modelId`)
											: undefined
									}
									aria-invalid={
										errors[`model.${index}.modelId`] ? true : undefined
									}
								>
									<SelectValue placeholder="选择模型" />
								</SelectTrigger>
								<SelectContent>
									{modelOptions.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<FieldError
								id={errorId(`model.${index}.modelId`)}
								message={errors[`model.${index}.modelId`]}
							/>
						</Field>
						<div className="model-reasoning-field space-y-2">
							<fieldset
								aria-describedby={
									errors[`model.${index}.reasoningLevels`]
										? errorId(`model.${index}.reasoningLevels`)
										: undefined
								}
								aria-invalid={
									errors[`model.${index}.reasoningLevels`] ? true : undefined
								}
								aria-labelledby={`application-model-option-reasoning-label-${index}`}
								className="model-reasoning flex min-h-11 flex-wrap items-center gap-x-[22px] gap-y-3"
								id={`application-model-option-reasoning-${index}`}
								tabIndex={
									errors[`model.${index}.reasoningLevels`] ? -1 : undefined
								}
							>
								<FieldLegend
									id={`application-model-option-reasoning-label-${index}`}
								>
									允许的推理档位
								</FieldLegend>
								{!selectedModel && (
									<p className="text-muted-foreground text-sm">
										选择模型后显示可用档位。
									</p>
								)}
								{(selectedModel?.reasoningLevels ?? []).map((level) => {
									const selected = model.reasoningLevels
										.split("\n")
										.includes(level);
									return (
										<Label variant="option" key={level}>
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
											{reasoningLevelLabel(level)}
										</Label>
									);
								})}
							</fieldset>
							<FieldError
								id={errorId(`model.${index}.reasoningLevels`)}
								message={errors[`model.${index}.reasoningLevels`]}
							/>
						</div>
						{models.length > 1 ? (
							<Button
								variant="outline"
								className="model-remove self-end"
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
	errorFor,
	rows,
}: DraftRowsProps<T>) {
	return (
		<>
			{rows.map((row, index) => (
				<fieldset
					className="grid min-w-0 gap-3 sm:grid-cols-2"
					key={`${label}-${index}`}
				>
					<FieldLegend className="mb-3">
						{label} {index + 1}
					</FieldLegend>
					{fields.map((field) => (
						<Field key={field.key}>
							{(() => {
								const key = `${idPrefix}.${index}.${field.key}`;
								const id = fieldId(key);
								const message = errorFor?.(index, field.key);
								return (
									<>
										<Label htmlFor={id}>{field.label}</Label>
										{field.options ? (
											<Select
												disabled={field.options.length === 0}
												value={row[field.key]}
												itemToStringLabel={(value) =>
													field.options?.find(
														(option) => option.value === value,
													)?.label ?? String(value)
												}
												onValueChange={(value) =>
													value && onChange(index, field.key, value)
												}
											>
												<SelectTrigger
													id={id}
													aria-describedby={message ? errorId(key) : undefined}
													aria-invalid={message ? true : undefined}
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
												aria-describedby={message ? errorId(key) : undefined}
												aria-invalid={message ? true : undefined}
												autoComplete={
													field.type === "password" ? "new-password" : undefined
												}
												id={id}
												onChange={(event) =>
													onChange(index, field.key, event.target.value)
												}
												required={field.required}
												type={field.type ?? "text"}
												value={row[field.key]}
											/>
										)}
										<FieldError id={errorId(key)} message={message} />
									</>
								);
							})()}
						</Field>
					))}
					{rows.length > minimumRows ? (
						<Button
							variant="outline"
							className="self-end"
							onClick={() => onRemove(index)}
							type="button"
						>
							<Trash2Icon aria-hidden="true" data-icon="inline-start" />
							{/* label 以拉丁字母开头时补空格：「移除 Secret」「移除环境变量」。 */}
							{cjkSpaced`移除${label}`}
						</Button>
					) : null}
				</fieldset>
			))}
		</>
	);
}

export function AgentApplicationForm(props: AgentApplicationFormProps) {
	const formRef = useRef<HTMLFormElement>(null);
	const [focusRequest, setFocusRequest] = useState(0);
	const focusStateRef = useRef<{
		focusRequest: number;
		formError?: string;
		serverCode?: string;
		advancedConfigurationOpen: boolean;
	}>({ advancedConfigurationOpen: false, focusRequest: -1 });
	const application = props.mode === "update" ? props.application : undefined;
	const keyManaged =
		props.mode === "update" && props.defaultRelayKeyManaged === true;
	const keyCheck = useKeylessKeyCheck(
		props.mode === "update" ? props.onCheckDefaultRelayKey : undefined,
	);
	const configuration = application?.configuration;
	const persistedModelOptions = configuration?.modelOptions;
	const deployment = props.deploymentConfiguration;
	const templates = applicationTemplateChoices(deployment);
	const deploymentRetryable = props.deploymentConfigurationRetryable ?? false;
	const showDeploymentStatus = props.showDeploymentStatus ?? true;
	const modelEndpoints = deployment.modelCatalog.endpoints;
	const [name, setName] = useState(application?.name ?? "");
	const [description, setDescription] = useState(
		application?.description ?? "",
	);
	const [defaultRelayKey, setDefaultRelayKey] = useState("");
	const [templateId, setTemplateId] = useState(
		application?.source.kind === "standard"
			? application.source.templateId
			: "",
	);
	const [templateRevision, setTemplateRevision] = useState(
		application?.source.kind === "standard"
			? (deployment.templates.find(
					(template) => template.templateId === templateId,
				)?.readiness?.revision ?? "")
			: "",
	);
	const [sourceKind, setSourceKind] = useState<AgentApplicationSourceKind>(() =>
		sourceKindFor(application?.source),
	);
	const [imageReference, setImageReference] = useState(
		application?.source.kind === "custom"
			? agentSourceReferenceLabel(application)
			: "",
	);
	const [manifest, setManifest] = useState(
		application?.source.kind === "custom" && "manifest" in application.source
			? application.source.manifest
			: "",
	);
	const [manifestSummary, setManifestSummary] =
		useState<MultiServiceManifestSummary | null>(() => {
			if (
				application?.source.kind !== "custom" ||
				!("manifest" in application.source)
			)
				return null;
			const parsed = parseMultiServiceManifest(application.source.manifest);
			return parsed.ok ? parsed.summary : null;
		});
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
	// 编辑申请时，目录缺少 Owner 记录也显示申请投影中的 Owner 显示名。
	const ownerLabels = Object.fromEntries(
		(configuration?.owners ?? []).map((owner) => [
			owner.userId,
			owner.displayName,
		]),
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
	const [advancedConfigurationOpen, setAdvancedConfigurationOpen] = useState(
		() => environment.length > 0 || secrets.length > 0,
	);
	const [configureModels, setConfigureModels] = useState(false);
	const [models, setModels] = useState<AgentApplicationModelDraft[]>(() => {
		if (props.mode === "create") return [blankModel()];
		return (configuration?.modelOptions ?? []).map((option) => {
			return {
				endpointId: endpointIdForModelOption(option, modelEndpoints),
				modelId: option.modelId,
				optionId: canonicalOptionIdForModelOption(option, modelEndpoints),
				reasoningLevels: option.reasoningLevels.join("\n"),
			};
		});
	});
	const initialDefaultModelOptionId = configuration?.defaultModelOptionId ?? "";
	const initialDefaultModelOption = configuration?.modelOptions.find(
		(option) => option.optionId === initialDefaultModelOptionId,
	);
	const [defaultModelOptionId, setDefaultModelOptionId] = useState(
		initialDefaultModelOption
			? canonicalOptionIdForModelOption(
					initialDefaultModelOption,
					modelEndpoints,
				)
			: initialDefaultModelOptionId,
	);
	const [defaultReasoningLevel, setDefaultReasoningLevel] = useState(
		configuration?.defaultReasoningLevel ?? "",
	);
	const [localFieldErrors, setFieldErrors] =
		useState<AgentApplicationFieldErrors>({});
	const [serverValidationDismissed, setServerValidationDismissed] =
		useState(false);
	const serverErrorCodeRef = useRef<string | undefined>(
		props.serverError?.code,
	);
	useEffect(() => {
		if (
			props.submitting ||
			props.serverError?.code !== serverErrorCodeRef.current
		)
			setServerValidationDismissed(false);
		serverErrorCodeRef.current = props.serverError?.code;
	}, [props.serverError?.code, props.submitting]);
	function dismissServerValidation() {
		if (props.serverError?.code === "MODEL_SELECTION_INVALID")
			setServerValidationDismissed(true);
	}
	function dismissServerFormError() {
		if (props.serverError?.code === "INVALID_REQUEST")
			setServerValidationDismissed(true);
	}
	const clearFieldErrors = (...keys: string[]) => {
		dismissServerFormError();
		setFieldErrors((current) => {
			const next = { ...current };
			let changed = false;
			for (const key of keys) {
				if (key in next) {
					delete next[key];
					changed = true;
				}
			}
			return changed ? next : current;
		});
	};
	const updateManifest = (value: string) => {
		dismissServerFormError();
		setManifest(value);
		const parsed = parseMultiServiceManifest(value);
		setManifestSummary(parsed.ok ? parsed.summary : null);
		setFieldErrors((current) => {
			const next = { ...current };
			if (parsed.ok) delete next.manifest;
			else next.manifest = parsed.message;
			return next;
		});
	};
	const updateNameField = (
		prefix: "environment" | "secret",
		rows: readonly AgentApplicationEnvironmentDraft[],
		index: number,
		key: "name" | "value",
	) => {
		dismissServerFormError();
		setFieldErrors((current) => {
			const next = { ...current };
			delete next[`${prefix}.${index}.${key}`];
			if (key === "name") recomputeDuplicateNameErrors(next, prefix, rows);
			return next;
		});
	};
	const updateModelSelectionErrors = (
		rows: readonly AgentApplicationModelDraft[],
	) => {
		setFieldErrors((current) => {
			const next = { ...current };
			recomputeDuplicateModelErrors(next, rows);
			return next;
		});
	};
	// 由默认 Key 管理模型的申请改用“Key + 候选选择”，目录里的逐行模型编辑随之隐藏。
	const managedModelEdit =
		keyManaged && sourceKind === "standard" && configureModels;
	const modelConfigurationVisible =
		showsModelConfiguration(props.mode, sourceKind, configureModels) &&
		!managedModelEdit;
	const selectedTemplate = templateFor(deployment, templateId);
	const templateReadiness = selectedTemplate?.readiness;
	const readinessEnabled = deployment.templates.some(
		(template) => template.readiness !== undefined,
	);
	const templateUnavailable =
		readinessEnabled &&
		sourceKind === "standard" &&
		(templateReadiness?.state !== "ready" ||
			templateRevision !== templateReadiness?.revision);
	const modelCatalogReady = deployment.modelCatalog.status === "populated";
	const standardChoicesBlocked =
		sourceKind === "standard" &&
		(templateUnavailable ||
			(modelConfigurationVisible &&
				(deployment.status !== "populated" ||
					deployment.templates.length === 0 ||
					!modelCatalogReady)));
	useEffect(() => {
		if (props.mode !== "update" || modelEndpoints.length === 0) return;
		setModels((current) => {
			let changed = false;
			const next = current.map((model) => {
				const endpointId =
					model.endpointId || endpointIdForModelOption(model, modelEndpoints);
				const optionId = canonicalOptionIdForModelOption(model, modelEndpoints);
				if (!endpointId) return model;
				const definition = modelEndpoints
					.find((endpoint) => endpoint.endpointId === endpointId)
					?.models.find((entry) => entry.modelId === model.modelId);
				const reasoningLevels = definition
					? model.reasoningLevels
							.split("\n")
							.filter((level) => definition.reasoningLevels.includes(level))
							.join("\n")
					: model.reasoningLevels;
				if (
					endpointId === model.endpointId &&
					optionId === model.optionId &&
					reasoningLevels === model.reasoningLevels
				)
					return model;
				changed = true;
				return { ...model, endpointId, optionId, reasoningLevels };
			});
			return changed ? next : current;
		});
		setDefaultModelOptionId((current) => {
			const option = persistedModelOptions?.find(
				(item) => item.optionId === current,
			);
			return option
				? canonicalOptionIdForModelOption(option, modelEndpoints)
				: current;
		});
	}, [modelEndpoints, persistedModelOptions, props.mode]);
	const secretOptions = (selectedTemplate?.allowedSecretKeys ?? []).map(
		(value) => ({ value, label: value }),
	);
	const staleTemplate =
		deployment.status === "populated" &&
		templateId.length > 0 &&
		selectedTemplate === undefined;
	const staleModelIndexes = useMemo(
		() =>
			models.flatMap((model, index) => {
				const selectedModel = modelEndpoints
					.find((endpoint) => endpoint.endpointId === model.endpointId)
					?.models.find((entry) => entry.modelId === model.modelId);
				const reasoningLevels = model.reasoningLevels
					.split("\n")
					.filter(Boolean);
				const hasSelection =
					model.optionId.length > 0 ||
					(model.endpointId.length > 0 && model.modelId.length > 0);
				return hasSelection &&
					(!model.endpointId ||
						!model.modelId ||
						!selectedModel ||
						!reasoningLevels.every((level) =>
							selectedModel.reasoningLevels.includes(level),
						))
					? [index]
					: [];
			}),
		[modelEndpoints, models],
	);
	const staleModel = staleModelIndexes.length > 0;
	const modelServerErrorIndexes = useMemo(
		() =>
			props.serverError?.code === "MODEL_SELECTION_INVALID"
				? staleModelIndexes
				: [],
		[props.serverError?.code, staleModelIndexes],
	);
	const serverFieldErrors = useMemo(() => {
		const errors: AgentApplicationFieldErrors = {};
		if (!serverValidationDismissed && modelConfigurationVisible)
			for (const index of modelServerErrorIndexes)
				errors[`model.${index}.modelId`] =
					"该模型或推理档位未通过默认 Relay Key 的验证，请重新选择。";
		if (
			!serverValidationDismissed &&
			props.serverError?.code === "MODEL_SELECTION_INVALID" &&
			modelServerErrorIndexes.length === 0 &&
			modelConfigurationVisible
		)
			errors.defaultModelOptionId =
				"默认模型未通过默认 Relay Key 的验证，请重新选择。";
		if (
			!serverValidationDismissed &&
			props.mode === "update" &&
			props.serverError?.code === "MODEL_SELECTION_INVALID" &&
			!modelConfigurationVisible &&
			!managedModelEdit
		)
			errors.configureModels =
				"模型配置未通过默认 Relay Key 的验证，请开启修改模型配置。";
		// 部署未提供平台身份入口时，服务端以 ACTION_UNAVAILABLE 拒绝「由平台校验」（#3034）。
		// 只要仍选着它就保留提示并阻止再次提交；修改申请不能更改入口身份，提示新建申请。
		if (
			props.serverError?.code === "ACTION_UNAVAILABLE" &&
			sourceKind === "custom-self-managed" &&
			identityResponsibility === "platform-managed"
		)
			errors.identityResponsibility =
				props.mode === "update"
					? "当前部署未启用平台身份入口。已有申请不能更改入口身份校验，请新建申请并选择「由自有入口校验」。"
					: "当前部署未启用平台身份入口，请改选「由自有入口校验」后再提交。";
		return errors;
	}, [
		identityResponsibility,
		managedModelEdit,
		modelConfigurationVisible,
		modelServerErrorIndexes,
		props.mode,
		props.serverError?.code,
		serverValidationDismissed,
		sourceKind,
	]);
	const serverFormError =
		props.serverError?.code === "INVALID_REQUEST" && !serverValidationDismissed
			? "申请内容未通过服务端校验，请检查表单后重试。"
			: undefined;
	const hasActiveServerValidationError =
		props.serverError?.code === "MODEL_SELECTION_INVALID" &&
		!serverValidationDismissed;
	const fieldErrors = useMemo(
		() => ({ ...serverFieldErrors, ...localFieldErrors }),
		[serverFieldErrors, localFieldErrors],
	);
	const advancedConfigurationHasErrors = Object.keys(fieldErrors).some(
		(key) => key.startsWith("environment.") || key.startsWith("secret."),
	);
	useEffect(() => {
		if (advancedConfigurationHasErrors && !advancedConfigurationOpen)
			setAdvancedConfigurationOpen(true);
	}, [advancedConfigurationHasErrors, advancedConfigurationOpen]);
	const defaultModel = models.find(
		(model) => model.optionId === defaultModelOptionId,
	);
	const defaultModelDefinition = modelEndpoints
		.find((endpoint) => endpoint.endpointId === defaultModel?.endpointId)
		?.models.find((model) => model.modelId === defaultModel?.modelId);
	const defaultReasoningLevels = defaultModelDefinition
		? defaultModelDefinition.reasoningLevels.filter((level) =>
				defaultModel?.reasoningLevels.split("\n").includes(level),
			)
		: [];
	const configurationMessage =
		deployment.status === "stale" || deployment.modelCatalog.status === "stale"
			? "部署选项已过期，请重新加载后再提交。"
			: deployment.status === "unavailable" ||
					deployment.modelCatalog.status === "unavailable"
				? deploymentRetryable
					? "部署选项暂不可用，请重新加载；标准模板申请暂不能提交。"
					: "部署选项暂不可用，请联系管理员。"
				: deployment.status === "empty" ||
						(deployment.templates.length === 0 && sourceKind === "standard") ||
						(deployment.modelCatalog.status === "empty" &&
							sourceKind === "standard")
					? "当前部署没有可用的标准模板或模型选项，请联系管理员配置后重试。"
					: staleTemplate || (modelConfigurationVisible && staleModel)
						? "当前申请包含已移除的部署选项，请重新加载并重新选择。"
						: undefined;
	const sourceFields = (
		<>
			<p className="sr-only" id="application-source-help">
				从部署提供的标准模板中选择，填写自定义镜像地址，或上传受限的多服务
				YAML。已有申请的来源不能更改。
			</p>
			{showDeploymentStatus && configurationMessage ? (
				<p
					className="alert text-destructive sm:col-span-2"
					id="application-deployment-status"
					role="status"
					tabIndex={-1}
				>
					{configurationMessage}
				</p>
			) : null}
			<Field>
				<Label htmlFor="application-source-kind">来源</Label>
				<Select
					disabled={props.mode === "update"}
					value={sourceKind}
					itemToStringLabel={(value) =>
						(
							({
								standard: "标准模板",
								"custom-platform-adapter": "自定义 Agent · 平台交互入口",
								"custom-self-managed": "自定义 Agent · 自有交互入口",
								"custom-multi-service": "多服务 Agent · 自有交互入口",
							}) as Record<string, string>
						)[String(value)] ?? String(value)
					}
					onValueChange={(value) => {
						if (!value) return;
						const kind = value as AgentApplicationSourceKind;
						dismissServerFormError();
						setSourceKind(kind);
						if (kind === "standard") {
							if (models.length === 0) setModels([blankModel()]);
							if (sourceKind !== "standard") setConfigureModels(true);
						}
						if (kind !== "standard") setConfigureModels(false);
						document.getElementById("application-source-kind")?.focus();
					}}
				>
					<SelectTrigger
						aria-label="Agent 来源"
						id="application-source-kind"
						aria-describedby="application-source-help"
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
						<SelectItem value="custom-multi-service">
							多服务 Agent · 自有交互入口
						</SelectItem>
					</SelectContent>
				</Select>
			</Field>
			{sourceKind === "standard" ? (
				<Field>
					<Label htmlFor="application-template-id">标准模板</Label>
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
						onValueChange={(value) => {
							if (!value) return;
							setTemplateId(value);
							setTemplateRevision(
								templates.find((template) => template.templateId === value)
									?.readiness?.revision ?? "",
							);
							setSecrets((current) =>
								current.map((item) => ({ ...item, value: "" })),
							);
							clearFieldErrors("templateId");
						}}
					>
						<SelectTrigger
							id="application-template-id"
							aria-describedby={describedBy(
								"application-source-help",
								fieldErrors.templateId ? errorId("templateId") : undefined,
							)}
							aria-invalid={fieldErrors.templateId ? true : undefined}
						>
							<SelectValue placeholder="选择标准模板" />
						</SelectTrigger>
						<SelectContent>
							{templates.map((template) => (
								<SelectItem
									key={template.templateId}
									value={template.templateId}
									disabled={
										template.readiness !== undefined &&
										template.readiness.state !== "ready"
									}
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
					<ul
						className="space-y-1 text-muted-foreground text-sm"
						aria-label="模板就绪状态"
					>
						{templates.map((template) => (
							<li key={template.templateId}>
								{template.displayName}：
								{
									templateReadinessMessages[
										template.readiness?.state ?? "unverified"
									]
								}
							</li>
						))}
					</ul>
					{templateUnavailable && templateId ? (
						<p aria-live="polite" className="text-sm">
							{templateReadiness?.state === "ready"
								? "模板已更新，请刷新后确认。"
								: templateReadinessMessages[
										templateReadiness?.state ?? "unverified"
									]}
						</p>
					) : null}
					<FieldError
						id={errorId("templateId")}
						message={fieldErrors.templateId}
					/>
				</Field>
			) : sourceKind === "custom-multi-service" ? (
				<div className="space-y-3 sm:col-span-2">
					<Field>
						<Label htmlFor="application-multi-service-file">
							多服务资源 YAML
						</Label>
						<Input
							accept=".yaml,.yml,text/yaml,application/yaml"
							disabled={props.mode === "update"}
							id="application-multi-service-file"
							type="file"
							onChange={(event) => {
								const file = event.target.files?.[0];
								if (!file) return;
								if (file.size > MULTI_SERVICE_MANIFEST_MAX_BYTES) {
									setManifest("");
									setManifestSummary(null);
									setFieldErrors((current) => ({
										...current,
										manifest: `多服务 YAML 不能超过 ${MULTI_SERVICE_MANIFEST_MAX_BYTES} bytes。`,
									}));
									return;
								}
								void file.text().then(updateManifest);
							}}
						/>
						<p className="text-muted-foreground text-sm">
							上传受限 Kubernetes 资源清单，或直接粘贴 YAML；最多 262,144
							bytes。
						</p>
					</Field>
					{/* 上方「多服务资源 YAML」标签绑定的是文件输入；文本框另给可访问名称以便区分（#3119）。
					    占位符用 JSX 表达式字符串，属性字符串不处理 \n 转义，会把反斜杠原样显示。 */}
					<Textarea
						aria-describedby={
							fieldErrors.manifest ? errorId("manifest") : undefined
						}
						aria-invalid={fieldErrors.manifest ? true : undefined}
						aria-label="多服务资源 YAML 内容"
						className="min-h-56 font-mono text-sm"
						disabled={props.mode === "update"}
						id="application-multi-service-manifest"
						onChange={(event) => updateManifest(event.target.value)}
						placeholder={"schemaVersion: 1\nentryServiceName: api\nresources:"}
						value={manifest}
					/>
					<FieldError id={errorId("manifest")} message={fieldErrors.manifest} />
					{manifestSummary ? (
						<p className="text-muted-foreground text-sm" role="status">
							{formatMultiServiceManifestSummary(manifestSummary)}
						</p>
					) : null}
				</div>
			) : (
				<Field>
					<Label htmlFor="application-image-reference">镜像地址</Label>
					<Input
						disabled={props.mode === "update"}
						aria-describedby={
							fieldErrors.imageReference ? errorId("imageReference") : undefined
						}
						aria-invalid={fieldErrors.imageReference ? true : undefined}
						id="application-image-reference"
						onChange={(event) => {
							setImageReference(event.target.value);
							clearFieldErrors("imageReference");
						}}
						required
						value={imageReference}
					/>
					<FieldError
						id={errorId("imageReference")}
						message={fieldErrors.imageReference}
					/>
				</Field>
			)}
			{sourceKind === "custom-self-managed" ? (
				<Field>
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
							if (value === "platform-managed" || value === "self-managed") {
								dismissServerFormError();
								setIdentityResponsibility(value);
							}
						}}
					>
						<SelectTrigger
							aria-describedby={
								fieldErrors.identityResponsibility
									? errorId("identityResponsibility")
									: undefined
							}
							aria-invalid={
								fieldErrors.identityResponsibility ? true : undefined
							}
							id="application-identity-responsibility"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="platform-managed">由平台校验</SelectItem>
							<SelectItem value="self-managed">由自有入口校验</SelectItem>
						</SelectContent>
					</Select>
					<FieldError
						id={errorId("identityResponsibility")}
						message={fieldErrors.identityResponsibility}
					/>
				</Field>
			) : null}
		</>
	);

	useEffect(() => {
		const serverCode = props.serverError?.code;
		const previous = focusStateRef.current;
		const shouldFocus =
			focusRequest !== previous.focusRequest ||
			serverCode !== previous.serverCode ||
			serverFormError !== previous.formError ||
			advancedConfigurationOpen !== previous.advancedConfigurationOpen;
		focusStateRef.current = {
			advancedConfigurationOpen,
			focusRequest,
			formError: serverFormError,
			serverCode,
		};
		if (
			!shouldFocus ||
			(Object.keys(fieldErrors).length === 0 && !serverFormError)
		)
			return;
		const first = firstFieldError(fieldErrors);
		if (first instanceof HTMLElement) first.focus();
		else if (serverFormError) formRef.current?.focus();
	}, [
		advancedConfigurationOpen,
		fieldErrors,
		focusRequest,
		props.serverError?.code,
		serverFormError,
	]);

	const submit = () => {
		const draft = {
			name,
			description,
			defaultRelayKey,
			sourceKind,
			templateId,
			templateRevision,
			imageReference,
			manifest,
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
		const errors = validateAgentApplicationDraft(draft, {
			allowedEnvironmentKeys: selectedTemplate?.allowedEnvironmentKeys,
			allowedSecretKeys: selectedTemplate?.allowedSecretKeys,
			configurationMessage,
			defaultModelReasoningLevels: defaultModel?.reasoningLevels
				?.split("\n")
				.filter(Boolean),
			modelConfigurationVisible,
			requiresTemplateReadiness: readinessEnabled && sourceKind === "standard",
			requiresDefaultRelayKey:
				props.mode === "create" && sourceKind === "standard",
			staleModel,
			staleModelIndexes,
			staleTemplate,
			standardChoicesBlocked,
		});
		if (sourceKind === "custom-multi-service") {
			const parsed = parseMultiServiceManifest(manifest);
			if (!parsed.ok) errors.manifest = parsed.message;
		}
		if (managedModelEdit && !keyCheck.replacement)
			errors.defaultRelayKey = keyCheck.typed
				? "请先点击「检查可用模型」并选好模型（至少一个模型，每个模型至少一个推理档位）。"
				: "请输入 Agent 默认 Relay Key。";
		setFieldErrors(errors);
		setFocusRequest((current) => current + 1);
		if (
			Object.keys(errors).length > 0 ||
			Object.keys(serverFieldErrors).length > 0 ||
			hasActiveServerValidationError ||
			serverFormError
		)
			return;
		setSecrets([]);
		if (props.mode === "create") {
			props.onSubmit(buildAgentApplicationRequest("create", draft));
			return;
		}
		props.onSubmit(
			buildAgentApplicationRequest(
				"update",
				{ ...draft, configureModels: configureModels && !managedModelEdit },
				managedModelEdit ? keyCheck.replacement : undefined,
			),
		);
	};

	return (
		<form
			ref={formRef}
			noValidate
			aria-describedby={serverFormError ? "application-form-error" : undefined}
			className="application-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (props.submitting) return;
				submit();
			}}
			tabIndex={serverFormError ? -1 : undefined}
		>
			{serverFormError ? (
				<p
					aria-live="assertive"
					className="text-destructive text-sm"
					id="application-form-error"
				>
					{serverFormError}
				</p>
			) : null}
			<fieldset
				disabled={props.submitting}
				className="application-form-fields min-w-0"
				aria-label="Agent 申请"
			>
				<FormSection
					title="基本信息"
					className="application-basic-section"
					description="名称和描述会显示在 Agent 目录。"
				>
					<div className="form-grid">
						<Field>
							<Label htmlFor="application-name">Agent 名称</Label>
							<Input
								aria-describedby={
									fieldErrors.name ? errorId("name") : undefined
								}
								aria-invalid={fieldErrors.name ? true : undefined}
								id="application-name"
								onChange={(event) => {
									setName(event.target.value);
									clearFieldErrors("name");
								}}
								required
								value={name}
							/>
							<FieldError id={errorId("name")} message={fieldErrors.name} />
						</Field>
						<Field className="sm:col-span-2">
							<Label htmlFor="application-description">使用场景</Label>
							<Textarea
								aria-label="用途说明"
								aria-describedby={
									fieldErrors.description ? errorId("description") : undefined
								}
								aria-invalid={fieldErrors.description ? true : undefined}
								id="application-description"
								onChange={(event) => {
									setDescription(event.target.value);
									clearFieldErrors("description");
								}}
								required
								value={description}
							/>
							{/* 文案受 design-tokens.spec.ts 的帮助文字断言锁定，与导出稿一致（web-ui.md「已回写导出设计的结论」W-07）。 */}
							<span className="field-help">不填写模型内部思考或外部凭证。</span>
							<FieldError
								id={errorId("description")}
								message={fieldErrors.description}
							/>
						</Field>
						{sourceFields}
					</div>
				</FormSection>
				<FormSection
					title="共同 Owner 与使用范围"
					className="application-scope-section"
					description="从目录选择人员和组织；提交时保存服务端 ID。"
					descriptionId="application-access-help"
				>
					<div className="form-grid">
						<div className="sm:col-span-2">
							<DirectoryPicker
								id="application-co-owner-ids"
								kind="user"
								label="共同 Owner 用户"
								help="至少保留一名有效 Owner"
								placeholder="搜索共同 Owner"
								value={coOwnerIds}
								fallbackLabels={ownerLabels}
								onChange={(value) => {
									setCoOwnerIds(value);
									clearFieldErrors("coOwnerIds");
								}}
								error={fieldErrors.coOwnerIds}
								describedBy="application-access-help"
								errorId={errorId("coOwnerIds")}
							/>
						</div>
						<DirectoryPicker
							id="application-user-availability-ids"
							kind="user"
							label="可使用的用户"
							help="可选；用于补充个人范围"
							placeholder="搜索姓名、邮箱或组织路径"
							value={userAvailabilityIds}
							onChange={(value) => {
								setUserAvailabilityIds(value);
								clearFieldErrors("userAvailabilityIds");
							}}
							error={fieldErrors.userAvailabilityIds}
							describedBy="application-access-help"
							errorId={errorId("userAvailabilityIds")}
						/>
						<DirectoryPicker
							id="application-organization-availability-ids"
							kind="organization"
							label="可使用的组织"
							help="可选；组织范围会与用户范围合并"
							value={organizationAvailabilityIds}
							onChange={(value) => {
								setOrganizationAvailabilityIds(value);
								clearFieldErrors("organizationAvailabilityIds");
							}}
							error={fieldErrors.organizationAvailabilityIds}
							describedBy="application-access-help"
							errorId={errorId("organizationAvailabilityIds")}
						/>
					</div>
				</FormSection>
				{/* DOM 顺序即视觉顺序：模型与推理紧跟范围，高级配置在其后（WCAG 2.4.3，不用 CSS order 重排）。 */}
				{sourceKind === "standard" ? (
					<FormSection
						title="模型与推理"
						className="application-model-section"
						description="这里只显示已部署且通过校验的模型。"
					>
						{/* 说明文字与内容之间按设计 .form-grid 留 16px。 */}
						<div className="mt-4">
							{props.mode === "update" ? (
								<Field>
									<Label variant="option">
										<Checkbox
											id="application-configure-models"
											aria-describedby={
												fieldErrors.configureModels
													? errorId("configureModels")
													: undefined
											}
											aria-invalid={
												fieldErrors.configureModels ? true : undefined
											}
											disabled={props.submitting}
											checked={configureModels}
											onCheckedChange={(checked) => {
												dismissServerFormError();
												setConfigureModels(checked);
												if (checked && models.length === 0) {
													setModels([blankModel()]);
												}
											}}
										/>
										修改模型配置
									</Label>
									<FieldError
										id={errorId("configureModels")}
										message={fieldErrors.configureModels}
									/>
								</Field>
							) : null}
							{managedModelEdit ? (
								<ApplicationKeylessModelEditor
									current={persistedModelOptions ?? []}
									currentDefault={{
										optionId: initialDefaultModelOptionId,
										level: configuration?.defaultReasoningLevel ?? "",
									}}
									disabled={props.submitting}
									error={fieldErrors.defaultRelayKey}
									errorId={errorId("defaultRelayKey")}
									keyCheck={keyCheck}
									onChangeKey={() => clearFieldErrors("defaultRelayKey")}
								/>
							) : null}
							{modelConfigurationVisible ? (
								<>
									{props.mode === "create" ? (
										<Field>
											<Label htmlFor="application-default-relay-key">
												Agent 默认 Relay Key
											</Label>
											<Input
												autoComplete="new-password"
												aria-describedby={
													fieldErrors.defaultRelayKey
														? errorId("defaultRelayKey")
														: undefined
												}
												aria-invalid={
													fieldErrors.defaultRelayKey ? true : undefined
												}
												id="application-default-relay-key"
												onChange={(event) => {
													setDefaultRelayKey(event.target.value);
													clearFieldErrors("defaultRelayKey");
												}}
												required
												type="password"
												value={defaultRelayKey}
											/>
											<p className="text-muted-foreground text-sm">
												只提交一次；保存后仅显示已设置状态，Key 不会回显。
											</p>
											<FieldError
												id={errorId("defaultRelayKey")}
												message={fieldErrors.defaultRelayKey}
											/>
										</Field>
									) : null}
									<ModelRows
										endpoints={modelEndpoints}
										errors={fieldErrors}
										models={models}
										onChange={(index, key, value) => {
											const nextModels = models.map((item, itemIndex) =>
												itemIndex !== index
													? item
													: key === "endpointId" || key === "modelId"
														? {
																...item,
																[key]: value,
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
											);
											setModels(nextModels);
											const rowErrorKeys = [
												"endpointId",
												"modelId",
												"reasoningLevels",
											].map((field) => `model.${index}.${field}`);
											clearFieldErrors(
												...(key === "endpointId" || key === "modelId"
													? [
															...rowErrorKeys,
															"defaultModelOptionId",
															"defaultReasoningLevel",
														]
													: [`model.${index}.${key}`]),
											);
											if (key === "endpointId" || key === "modelId")
												updateModelSelectionErrors(nextModels);
											if (key === "endpointId" || key === "modelId")
												dismissServerValidation();
										}}
										onRemove={(index) => {
											dismissServerFormError();
											const next = models.filter(
												(_, itemIndex) => itemIndex !== index,
											);
											setModels(next);
											setFieldErrors((current) => {
												const nextErrors = reindexRowErrors(
													current,
													"model",
													index,
												);
												delete nextErrors.defaultModelOptionId;
												delete nextErrors.defaultReasoningLevel;
												recomputeDuplicateModelErrors(nextErrors, next);
												return nextErrors;
											});
											dismissServerValidation();
										}}
									/>
									<div className="form-grid">
										<Field>
											<Label htmlFor="application-default-model-option">
												默认模型
											</Label>
											<Select
												value={defaultModelOptionId}
												disabled={
													models.length === 0 || modelEndpoints.length === 0
												}
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
												onValueChange={(value) => {
													if (!value) return;
													setDefaultModelOptionId(value);
													clearFieldErrors(
														"defaultModelOptionId",
														"defaultReasoningLevel",
													);
													dismissServerValidation();
												}}
											>
												<SelectTrigger
													id="application-default-model-option"
													aria-describedby={
														fieldErrors.defaultModelOptionId
															? errorId("defaultModelOptionId")
															: undefined
													}
													aria-invalid={
														fieldErrors.defaultModelOptionId ? true : undefined
													}
												>
													<SelectValue placeholder="选择默认模型" />
												</SelectTrigger>
												<SelectContent>
													{models
														.filter((model) => model.optionId)
														.map((model) => {
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
											<FieldError
												id={errorId("defaultModelOptionId")}
												message={fieldErrors.defaultModelOptionId}
											/>
										</Field>
										<Field>
											<Label htmlFor="application-default-reasoning-level">
												默认推理档位
											</Label>
											<Select
												value={defaultReasoningLevel}
												disabled={!defaultModelDefinition}
												// 推理档位只显示中文，原始枚举不进入页面。
												itemToStringLabel={(value) =>
													reasoningLevelLabel(String(value))
												}
												onValueChange={(value) => {
													if (!value) return;
													setDefaultReasoningLevel(value);
													clearFieldErrors("defaultReasoningLevel");
												}}
											>
												<SelectTrigger
													id="application-default-reasoning-level"
													aria-describedby={
														fieldErrors.defaultReasoningLevel
															? errorId("defaultReasoningLevel")
															: undefined
													}
													aria-invalid={
														fieldErrors.defaultReasoningLevel ? true : undefined
													}
												>
													<SelectValue placeholder="选择默认推理档位" />
												</SelectTrigger>
												<SelectContent>
													{defaultReasoningLevels.map((value) => (
														<SelectItem key={value} value={value}>
															{reasoningLevelLabel(value)}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FieldError
												id={errorId("defaultReasoningLevel")}
												message={fieldErrors.defaultReasoningLevel}
											/>
										</Field>
									</div>
									<Button
										variant="outline"
										id="application-add-model-option"
										onClick={() => {
											dismissServerFormError();
											setModels((current) => [...current, blankModel()]);
										}}
										type="button"
									>
										<PlusIcon aria-hidden="true" data-icon="inline-start" />
										添加模型选项
									</Button>
								</>
							) : null}
						</div>
					</FormSection>
				) : null}
				<section
					className="application-advanced-section"
					aria-labelledby="application-advanced-heading"
				>
					<div className="application-advanced-heading">
						<div>
							<h2 id="application-advanced-heading">高级配置</h2>
							<p>环境变量和 Secret 只在部署需要时填写。</p>
						</div>
						<Button
							aria-expanded={advancedConfigurationOpen}
							className="application-advanced-toggle"
							onClick={() => setAdvancedConfigurationOpen((open) => !open)}
							size="sm"
							type="button"
							variant="outline"
						>
							{advancedConfigurationOpen ? "收起高级配置" : "展开高级配置"}
						</Button>
					</div>
					<div
						className="application-advanced-content"
						hidden={!advancedConfigurationOpen}
					>
						<FormSection
							title="环境变量"
							headingLevel={3}
							className="application-optional-section"
							description="仅填写部署允许的配置项；凭证请使用 Secret 或模型凭证字段。"
						>
							<DraftRows
								fields={[
									{
										key: "name",
										label: "变量名称",
										required: true,
									},
									{ key: "value", label: "变量值", required: true },
								]}
								idPrefix="environment"
								label="环境变量"
								errorFor={(index, key) =>
									fieldErrors[`environment.${index}.${key}`]
								}
								onChange={(index, key, value) => {
									const next = environment.map((item, itemIndex) =>
										itemIndex === index
											? {
													...item,
													[key]: value,
												}
											: item,
									);
									setEnvironment(next);
									updateNameField("environment", next, index, key);
								}}
								onRemove={(index) => {
									dismissServerFormError();
									const next = environment.filter(
										(_, itemIndex) => itemIndex !== index,
									);
									setEnvironment(next);
									setFieldErrors((current) => {
										const nextErrors = reindexRowErrors(
											current,
											"environment",
											index,
										);
										recomputeDuplicateNameErrors(
											nextErrors,
											"environment",
											next,
										);
										return nextErrors;
									});
								}}
								rows={environment}
							/>
							<Button
								variant="outline"
								onClick={() => {
									dismissServerFormError();
									setEnvironment((current) => [...current, blankEnvironment()]);
								}}
								type="button"
							>
								<PlusIcon aria-hidden="true" data-icon="inline-start" />
								添加环境变量
							</Button>
						</FormSection>
						<FormSection
							title="Secret"
							headingLevel={3}
							className="application-optional-section"
							description="只提交新增或替换值，已有 Secret 不回显。提交后会清空输入，重试时需重新填写替换值。"
						>
							<DraftRows
								fields={[
									{
										key: "name",
										label: "Secret 名称",
										options:
											sourceKind === "standard" ? secretOptions : undefined,
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
								errorFor={(index, key) => fieldErrors[`secret.${index}.${key}`]}
								onChange={(index, key, value) => {
									const next = secrets.map((item, itemIndex) =>
										itemIndex === index
											? {
													...item,
													[key]: value,
													...(key === "name" ? { value: "" } : {}),
												}
											: item,
									);
									setSecrets(next);
									updateNameField("secret", next, index, key);
								}}
								onRemove={(index) => {
									dismissServerFormError();
									const next = secrets.filter(
										(_, itemIndex) => itemIndex !== index,
									);
									setSecrets(next);
									setFieldErrors((current) => {
										const nextErrors = reindexRowErrors(
											current,
											"secret",
											index,
										);
										recomputeDuplicateNameErrors(nextErrors, "secret", next);
										return nextErrors;
									});
								}}
								rows={secrets}
							/>
							<Button
								variant="outline"
								onClick={() => {
									dismissServerFormError();
									setSecrets((current) => [...current, blankEnvironment()]);
								}}
								type="button"
							>
								<PlusIcon aria-hidden="true" data-icon="inline-start" />
								添加 Secret
							</Button>
						</FormSection>
					</div>
				</section>
				<div className="form-footer">
					{props.cancelAction}
					<div className="form-footer-actions">
						<Button disabled={props.submitting} type="submit">
							{props.submitting
								? "正在提交…"
								: props.mode === "update"
									? agentApplicationEditActionLabels[props.action]
									: "提交审批"}
							{/* 设计 .form-footer 主按钮「提交审批 →」：16px 箭头在文字后（M-10）。 */}
							{props.submitting ? null : (
								<ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
							)}
						</Button>
					</div>
				</div>
			</fieldset>
		</form>
	);
}
