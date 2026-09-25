import { PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
	type AgentApplicationFieldErrors,
	type AgentApplicationModelDraft,
	type AgentApplicationSourceKind,
	buildAgentApplicationRequest,
	showsModelConfiguration,
	sourceKindFor,
	validateAgentApplicationDraft,
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
			serverError?: AgentApplicationServerError | null;
			submitting: boolean;
	  }
	| {
			action: AgentApplicationEditAction;
			application: AgentApplicationProjectionV2;
			deploymentConfiguration: DeploymentConfigurationProjectionV2;
			mode: "update";
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
	multiline?: boolean;
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
		/^model\.(\d+)\.(endpointId|modelId|reasoningLevels|credentialValue)$/.exec(
			key,
		);
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

function FieldError({ id, message }: { id: string; message?: string }) {
	return message ? (
		<p aria-live="assertive" className="text-destructive text-sm" id={id}>
			{message}
		</p>
	) : null;
}

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
	if (option.optionId.includes(":")) return "";
	const candidates = endpoints.filter((endpoint) =>
		endpoint.models.some((model) => model.modelId === option.modelId),
	);
	return candidates.length === 1 ? (candidates[0]?.endpointId ?? "") : "";
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
	requiresReplacementCredential,
	persistedModelOptionIds,
	errors,
	onChange,
	onRemove,
}: {
	models: readonly AgentApplicationModelDraft[];
	endpoints: readonly DeploymentModelEndpointProjectionV2[];
	persistedModelOptionIds?: readonly string[];
	requiresReplacementCredential: boolean;
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
				const modelOptions =
					endpoint?.models.map((item) => ({
						value: item.modelId,
						label: item.modelId,
					})) ?? [];
				const needsReplacementCredential =
					requiresReplacementCredential ||
					(persistedModelOptionIds !== undefined &&
						!persistedModelOptionIds.includes(model.optionId));
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
									aria-describedby={
										errors[`model.${index}.endpointId`]
											? errorId(`model.${index}.endpointId`)
											: undefined
									}
									aria-invalid={
										errors[`model.${index}.endpointId`] ? true : undefined
									}
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
							<FieldError
								id={errorId(`model.${index}.endpointId`)}
								message={errors[`model.${index}.endpointId`]}
							/>
						</div>
						<div className="space-y-2">
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
									className="h-11 w-full text-base md:text-sm"
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
						</div>
						<div className="space-y-2">
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
								className="flex min-h-11 flex-wrap items-center gap-4"
								id={`application-model-option-reasoning-${index}`}
								tabIndex={
									errors[`model.${index}.reasoningLevels`] ? -1 : undefined
								}
							>
								<legend
									id={`application-model-option-reasoning-label-${index}`}
								>
									允许的推理档位
								</legend>
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
							</fieldset>
							<FieldError
								id={errorId(`model.${index}.reasoningLevels`)}
								message={errors[`model.${index}.reasoningLevels`]}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor={`application-model-option-credential-${index}`}>
								模型凭证
							</Label>
							<Input
								autoComplete="new-password"
								disabled={modelOptions.length === 0}
								aria-describedby={
									errors[`model.${index}.credentialValue`]
										? errorId(`model.${index}.credentialValue`)
										: undefined
								}
								aria-invalid={
									errors[`model.${index}.credentialValue`] ? true : undefined
								}
								id={`application-model-option-credential-${index}`}
								onChange={(event) =>
									onChange(index, "credentialValue", event.target.value)
								}
								required={needsReplacementCredential}
								type="password"
								value={model.credentialValue}
							/>
							<FieldError
								id={errorId(`model.${index}.credentialValue`)}
								message={errors[`model.${index}.credentialValue`]}
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
					<legend className="mb-3 font-medium">
						{label} {index + 1}
					</legend>
					{fields.map((field) => (
						<div className="space-y-2" key={field.key}>
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
										) : field.multiline ? (
											<Textarea
												aria-describedby={message ? errorId(key) : undefined}
												aria-invalid={message ? true : undefined}
												className="min-h-20"
												id={id}
												onChange={(event) =>
													onChange(index, field.key, event.target.value)
												}
												required={field.required}
												value={row[field.key]}
											/>
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
	const formRef = useRef<HTMLFormElement>(null);
	const [focusRequest, setFocusRequest] = useState(0);
	const focusStateRef = useRef<{
		focusRequest: number;
		formError?: string;
		serverCode?: string;
	}>({ focusRequest: -1 });
	const application = props.mode === "update" ? props.application : undefined;
	const configuration = application?.configuration;
	const persistedModelOptions = configuration?.modelOptions;
	const deployment = props.deploymentConfiguration;
	const modelEndpoints = deployment.modelCatalog.endpoints;
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
		return (configuration?.modelOptions ?? []).map((option) => {
			return {
				credentialValue: "",
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
	const modelConfigurationVisible = showsModelConfiguration(
		props.mode,
		sourceKind,
		configureModels,
	);
	const requiresReplacementCredential =
		props.mode === "create" ||
		(application?.source.kind !== "standard" && sourceKind === "standard");
	const persistedModelOptionIds =
		props.mode === "update"
			? (configuration?.modelOptions.map((option) =>
					canonicalOptionIdForModelOption(option, modelEndpoints),
				) ?? [])
			: undefined;
	const selectedTemplate = templateFor(deployment, templateId);
	const modelCatalogReady = deployment.modelCatalog.status === "populated";
	const standardChoicesBlocked =
		sourceKind === "standard" &&
		modelConfigurationVisible &&
		(deployment.status !== "populated" ||
			deployment.templates.length === 0 ||
			!modelCatalogReady);
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
					"服务端拒绝了该模型选项，请重新选择。";
		if (
			!serverValidationDismissed &&
			props.serverError?.code === "MODEL_SELECTION_INVALID" &&
			modelServerErrorIndexes.length === 0 &&
			modelConfigurationVisible
		)
			errors.defaultModelOptionId = "服务端拒绝了默认模型，请重新选择。";
		if (
			!serverValidationDismissed &&
			props.mode === "update" &&
			props.serverError?.code === "MODEL_SELECTION_INVALID" &&
			!modelConfigurationVisible
		)
			errors.configureModels = "服务端拒绝了模型配置，请开启修改模型配置。";
		return errors;
	}, [
		modelConfigurationVisible,
		modelServerErrorIndexes,
		props.mode,
		props.serverError?.code,
		serverValidationDismissed,
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
				? "部署选项暂不可用，请重新加载；标准模板申请暂不能提交。"
				: deployment.status === "empty" ||
						(deployment.templates.length === 0 && sourceKind === "standard") ||
						(deployment.modelCatalog.status === "empty" &&
							sourceKind === "standard")
					? "当前部署没有可用的标准模板或模型选项，请联系管理员配置后重试。"
					: staleTemplate || (modelConfigurationVisible && staleModel)
						? "当前申请包含已移除的部署选项，请重新加载并重新选择。"
						: undefined;

	useEffect(() => {
		const serverCode = props.serverError?.code;
		const previous = focusStateRef.current;
		const shouldFocus =
			focusRequest !== previous.focusRequest ||
			serverCode !== previous.serverCode ||
			serverFormError !== previous.formError;
		focusStateRef.current = {
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
	}, [fieldErrors, focusRequest, props.serverError?.code, serverFormError]);

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
		const errors = validateAgentApplicationDraft(draft, {
			allowedEnvironmentKeys: selectedTemplate?.allowedEnvironmentKeys,
			allowedSecretKeys: selectedTemplate?.allowedSecretKeys,
			configurationMessage,
			defaultModelReasoningLevels: defaultModel?.reasoningLevels
				?.split("\n")
				.filter(Boolean),
			modelConfigurationVisible,
			persistedModelOptionIds,
			requiresReplacementCredential,
			staleModel,
			staleModelIndexes,
			staleTemplate,
			standardChoicesBlocked,
		});
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
			ref={formRef}
			noValidate
			aria-describedby={serverFormError ? "application-form-error" : undefined}
			className="space-y-6"
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
						</div>
						<div className="space-y-2 sm:col-span-2">
							<Label htmlFor="application-description">用途说明</Label>
							<Textarea
								aria-describedby={
									fieldErrors.description ? errorId("description") : undefined
								}
								aria-invalid={fieldErrors.description ? true : undefined}
								className="min-h-28"
								id="application-description"
								onChange={(event) => {
									setDescription(event.target.value);
									clearFieldErrors("description");
								}}
								required
								value={description}
							/>
							<FieldError
								id={errorId("description")}
								message={fieldErrors.description}
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
						<p
							className="alert text-destructive"
							id="application-deployment-status"
							role="status"
							tabIndex={-1}
						>
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
									onValueChange={(value) => {
										if (!value) return;
										setTemplateId(value);
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
											fieldErrors.templateId
												? errorId("templateId")
												: undefined,
										)}
										aria-invalid={fieldErrors.templateId ? true : undefined}
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
								<FieldError
									id={errorId("templateId")}
									message={fieldErrors.templateId}
								/>
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
									aria-describedby={
										fieldErrors.imageReference
											? errorId("imageReference")
											: undefined
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
										) {
											dismissServerFormError();
											setIdentityResponsibility(value);
										}
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
								aria-describedby={describedBy(
									"application-access-help",
									fieldErrors.coOwnerIds ? errorId("coOwnerIds") : undefined,
								)}
								aria-invalid={fieldErrors.coOwnerIds ? true : undefined}
								onChange={(event) => {
									setCoOwnerIds(event.target.value);
									clearFieldErrors("coOwnerIds");
								}}
								value={coOwnerIds}
							/>
							<FieldError
								id={errorId("coOwnerIds")}
								message={fieldErrors.coOwnerIds}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="application-user-availability-ids">
								可使用的用户 ID
							</Label>
							<Textarea
								className="min-h-24"
								id="application-user-availability-ids"
								aria-describedby={describedBy(
									"application-access-help",
									fieldErrors.userAvailabilityIds
										? errorId("userAvailabilityIds")
										: undefined,
								)}
								aria-invalid={
									fieldErrors.userAvailabilityIds ? true : undefined
								}
								onChange={(event) => {
									setUserAvailabilityIds(event.target.value);
									clearFieldErrors("userAvailabilityIds");
								}}
								value={userAvailabilityIds}
							/>
							<FieldError
								id={errorId("userAvailabilityIds")}
								message={fieldErrors.userAvailabilityIds}
							/>
						</div>
						<div className="space-y-2 sm:col-span-2">
							<Label htmlFor="application-organization-availability-ids">
								可使用的组织 ID
							</Label>
							<Textarea
								className="min-h-24"
								id="application-organization-availability-ids"
								aria-describedby={describedBy(
									"application-access-help",
									fieldErrors.organizationAvailabilityIds
										? errorId("organizationAvailabilityIds")
										: undefined,
								)}
								aria-invalid={
									fieldErrors.organizationAvailabilityIds ? true : undefined
								}
								onChange={(event) => {
									setOrganizationAvailabilityIds(event.target.value);
									clearFieldErrors("organizationAvailabilityIds");
								}}
								value={organizationAvailabilityIds}
							/>
							<FieldError
								id={errorId("organizationAvailabilityIds")}
								message={fieldErrors.organizationAvailabilityIds}
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
								recomputeDuplicateNameErrors(nextErrors, "environment", next);
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
								const nextErrors = reindexRowErrors(current, "secret", index);
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
							<div className="space-y-2">
								<Label className="min-h-11 gap-3">
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
							</div>
						) : null}
						{modelConfigurationVisible ? (
							<>
								<ModelRows
									endpoints={modelEndpoints}
									errors={fieldErrors}
									models={models}
									persistedModelOptionIds={persistedModelOptionIds}
									requiresReplacementCredential={requiresReplacementCredential}
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
																		credentialValue: "",
																	}
																: {
																		optionId:
																			item.endpointId && value
																				? optionIdFor(item.endpointId, value)
																				: "",
																		reasoningLevels: "",
																		credentialValue: "",
																	}),
														}
													: { ...item, [key]: value },
										);
										setModels(nextModels);
										const rowErrorKeys = [
											"endpointId",
											"modelId",
											"reasoningLevels",
											"credentialValue",
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
									<div className="space-y-2">
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
												className="h-11 w-full text-base md:text-sm"
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
									</div>
									<div className="space-y-2">
										<Label htmlFor="application-default-reasoning-level">
											默认推理档位
										</Label>
										<Select
											value={defaultReasoningLevel}
											disabled={!defaultModelDefinition}
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
										<FieldError
											id={errorId("defaultReasoningLevel")}
											message={fieldErrors.defaultReasoningLevel}
										/>
									</div>
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
