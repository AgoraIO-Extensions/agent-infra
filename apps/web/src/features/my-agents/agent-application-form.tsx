import { useState } from "react";

import type {
	AgentApplicationCreateRequestV1Writable,
	AgentApplicationProjectionV1,
	AgentApplicationUpdateRequestV1Writable,
} from "../../pilot/generated/types.gen.js";
import {
	type AgentApplicationActionDraft,
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

type AgentApplicationFormProps =
	| {
			mode: "create";
			onSubmit: (body: AgentApplicationCreateRequestV1Writable) => void;
			submitting: boolean;
	  }
	| {
			action: AgentApplicationEditAction;
			application: AgentApplicationProjectionV1;
			mode: "update";
			onSubmit: (body: AgentApplicationUpdateRequestV1Writable) => void;
			submitting: boolean;
	  };

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

const inputClassName =
	"min-h-11 w-full border border-slate-400 bg-white px-3 text-slate-950";

function blankAction(): AgentApplicationActionDraft {
	return { providerId: "", actionId: "", actionVersion: "" };
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
				<div className="grid gap-3 sm:grid-cols-3" key={`${label}-${index}`}>
					{fields.map((field) => (
						<div className="space-y-2" key={field.key}>
							<label
								className="font-medium text-slate-800 text-sm"
								htmlFor={`application-${idPrefix}-${field.key}-${index}`}
							>
								{field.label}
							</label>
							{field.multiline ? (
								<textarea
									className="min-h-20 w-full border border-slate-400 bg-white px-3 py-2 text-slate-950"
									id={`application-${idPrefix}-${field.key}-${index}`}
									onChange={(event) =>
										onChange(index, field.key, event.target.value)
									}
									required={field.required}
									value={row[field.key]}
								/>
							) : (
								<input
									autoComplete={
										field.type === "password" ? "new-password" : undefined
									}
									className={inputClassName}
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
						<button
							className="min-h-11 self-end border border-slate-400 px-3 font-medium text-slate-800 text-sm hover:bg-slate-100"
							onClick={() => onRemove(index)}
							type="button"
						>
							Remove {label}
						</button>
					) : null}
				</div>
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
	const [actions, setActions] = useState<AgentApplicationActionDraft[]>(
		configuration?.actions.map((action) => ({ ...action })) ?? [],
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
			actions,
			environment,
			secrets,
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
				submit();
			}}
		>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<label
						className="font-medium text-slate-800 text-sm"
						htmlFor="application-name"
					>
						Application name
					</label>
					<input
						className={inputClassName}
						id="application-name"
						onChange={(event) => setName(event.target.value)}
						required
						value={name}
					/>
				</div>
				<div className="space-y-2 sm:col-span-2">
					<label
						className="font-medium text-slate-800 text-sm"
						htmlFor="application-description"
					>
						Description
					</label>
					<textarea
						className="min-h-28 w-full border border-slate-400 bg-white px-3 py-2 text-slate-950"
						id="application-description"
						onChange={(event) => setDescription(event.target.value)}
						required
						value={description}
					/>
				</div>
			</div>
			<fieldset className="space-y-4 border-slate-200 border-t pt-5">
				<legend className="font-semibold text-slate-950 text-sm">Source</legend>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<label
							className="font-medium text-slate-800 text-sm"
							htmlFor="application-source-kind"
						>
							Source kind
						</label>
						<select
							className={inputClassName}
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
							<option value="standard">Standard template</option>
							<option value="custom-platform-adapter">
								Custom platform interaction
							</option>
							<option value="custom-self-managed">
								Custom self-managed interaction
							</option>
						</select>
					</div>
					{sourceKind === "standard" ? (
						<div className="space-y-2">
							<label
								className="font-medium text-slate-800 text-sm"
								htmlFor="application-template-id"
							>
								Standard template ID
							</label>
							<input
								className={inputClassName}
								id="application-template-id"
								onChange={(event) => setTemplateId(event.target.value)}
								required
								value={templateId}
							/>
						</div>
					) : (
						<div className="space-y-2">
							<label
								className="font-medium text-slate-800 text-sm"
								htmlFor="application-image-reference"
							>
								Image reference
							</label>
							<input
								className={inputClassName}
								id="application-image-reference"
								onChange={(event) => setImageReference(event.target.value)}
								required
								value={imageReference}
							/>
						</div>
					)}
					{sourceKind === "custom-self-managed" ? (
						<div className="space-y-2">
							<label
								className="font-medium text-slate-800 text-sm"
								htmlFor="application-identity-responsibility"
							>
								Identity responsibility
							</label>
							<select
								className={inputClassName}
								id="application-identity-responsibility"
								onChange={(event) =>
									setIdentityResponsibility(
										event.target.value as "platform-managed" | "self-managed",
									)
								}
								value={identityResponsibility}
							>
								<option value="platform-managed">Platform-managed</option>
								<option value="self-managed">Self-managed</option>
							</select>
						</div>
					) : null}
				</div>
			</fieldset>
			<fieldset className="space-y-4 border-slate-200 border-t pt-5">
				<legend className="font-semibold text-slate-950 text-sm">Access</legend>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<label
							className="font-medium text-slate-800 text-sm"
							htmlFor="application-co-owner-ids"
						>
							Co-owner IDs
						</label>
						<textarea
							className="min-h-24 w-full border border-slate-400 bg-white px-3 py-2 text-slate-950"
							id="application-co-owner-ids"
							onChange={(event) => setCoOwnerIds(event.target.value)}
							value={coOwnerIds}
						/>
					</div>
					<div className="space-y-2">
						<label
							className="font-medium text-slate-800 text-sm"
							htmlFor="application-user-availability-ids"
						>
							User availability IDs
						</label>
						<textarea
							className="min-h-24 w-full border border-slate-400 bg-white px-3 py-2 text-slate-950"
							id="application-user-availability-ids"
							onChange={(event) => setUserAvailabilityIds(event.target.value)}
							value={userAvailabilityIds}
						/>
					</div>
					<div className="space-y-2 sm:col-span-2">
						<label
							className="font-medium text-slate-800 text-sm"
							htmlFor="application-organization-availability-ids"
						>
							Organization availability IDs
						</label>
						<textarea
							className="min-h-24 w-full border border-slate-400 bg-white px-3 py-2 text-slate-950"
							id="application-organization-availability-ids"
							onChange={(event) =>
								setOrganizationAvailabilityIds(event.target.value)
							}
							value={organizationAvailabilityIds}
						/>
					</div>
				</div>
			</fieldset>
			<fieldset className="space-y-4 border-slate-200 border-t pt-5">
				<legend className="font-semibold text-slate-950 text-sm">
					Actions
				</legend>
				<DraftRows
					fields={[
						{
							key: "providerId",
							label: "Action provider ID",
							required: true,
						},
						{ key: "actionId", label: "Action ID", required: true },
						{
							key: "actionVersion",
							label: "Action version",
							required: true,
						},
					]}
					idPrefix="action"
					label="action"
					onChange={(index, key, value) =>
						setActions((current) =>
							current.map((item, itemIndex) =>
								itemIndex === index ? { ...item, [key]: value } : item,
							),
						)
					}
					onRemove={(index) =>
						setActions((current) =>
							current.filter((_, itemIndex) => itemIndex !== index),
						)
					}
					rows={actions}
				/>
				<button
					className="min-h-11 border border-slate-700 px-4 font-medium text-slate-800 text-sm hover:bg-slate-100"
					onClick={() => setActions((current) => [...current, blankAction()])}
					type="button"
				>
					Add action
				</button>
			</fieldset>
			<fieldset className="space-y-4 border-slate-200 border-t pt-5">
				<legend className="font-semibold text-slate-950 text-sm">
					Environment
				</legend>
				<DraftRows
					fields={[
						{ key: "name", label: "Environment name", required: true },
						{ key: "value", label: "Environment value", required: true },
					]}
					idPrefix="environment"
					label="environment value"
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
				<button
					className="min-h-11 border border-slate-700 px-4 font-medium text-slate-800 text-sm hover:bg-slate-100"
					onClick={() =>
						setEnvironment((current) => [...current, blankEnvironment()])
					}
					type="button"
				>
					Add environment value
				</button>
			</fieldset>
			<fieldset className="space-y-4 border-slate-200 border-t pt-5">
				<legend className="font-semibold text-slate-950 text-sm">
					Secrets
				</legend>
				<DraftRows
					fields={[
						{ key: "name", label: "Secret name", required: true },
						{
							key: "value",
							label: "Secret value",
							required: true,
							type: "password",
						},
					]}
					idPrefix="secret"
					label="secret"
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
				<button
					className="min-h-11 border border-slate-700 px-4 font-medium text-slate-800 text-sm hover:bg-slate-100"
					onClick={() =>
						setSecrets((current) => [...current, blankEnvironment()])
					}
					type="button"
				>
					Add secret
				</button>
			</fieldset>
			{sourceKind === "standard" ? (
				<fieldset className="space-y-4 border-slate-200 border-t pt-5">
					<legend className="font-semibold text-slate-950 text-sm">
						Models
					</legend>
					{props.mode === "update" ? (
						<label className="flex min-h-11 items-center gap-3 text-slate-800 text-sm">
							<input
								checked={configureModels}
								onChange={(event) => {
									setConfigureModels(event.target.checked);
									if (event.target.checked && models.length === 0) {
										setModels([blankModel()]);
									}
								}}
								type="checkbox"
							/>
							Configure models
						</label>
					) : null}
					{modelConfigurationVisible ? (
						<>
							<DraftRows
								fields={[
									{
										key: "optionId",
										label: "Model option ID",
										required: true,
									},
									{
										key: "endpointId",
										label: "Model endpoint ID",
										required: true,
									},
									{ key: "modelId", label: "Model ID", required: true },
									{
										key: "reasoningLevels",
										label: "Reasoning levels",
										multiline: true,
										required: true,
									},
									{
										key: "credentialValue",
										label: "Credential value",
										required: requiresReplacementCredential,
										type: "password",
									},
								]}
								idPrefix="model-option"
								label="model option"
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
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-2">
									<label
										className="font-medium text-slate-800 text-sm"
										htmlFor="application-default-model-option"
									>
										Default model option ID
									</label>
									<input
										className={inputClassName}
										id="application-default-model-option"
										onChange={(event) =>
											setDefaultModelOptionId(event.target.value)
										}
										required
										value={defaultModelOptionId}
									/>
								</div>
								<div className="space-y-2">
									<label
										className="font-medium text-slate-800 text-sm"
										htmlFor="application-default-reasoning-level"
									>
										Default reasoning level
									</label>
									<input
										className={inputClassName}
										id="application-default-reasoning-level"
										onChange={(event) =>
											setDefaultReasoningLevel(event.target.value)
										}
										required
										value={defaultReasoningLevel}
									/>
								</div>
							</div>
							<button
								className="min-h-11 border border-slate-700 px-4 font-medium text-slate-800 text-sm hover:bg-slate-100"
								onClick={() =>
									setModels((current) => [...current, blankModel()])
								}
								type="button"
							>
								Add model option
							</button>
						</>
					) : null}
				</fieldset>
			) : null}
			<button
				className="min-h-11 bg-slate-900 px-4 font-medium text-sm text-white disabled:cursor-not-allowed disabled:bg-slate-400"
				disabled={props.submitting}
				type="submit"
			>
				{props.submitting
					? "Submitting..."
					: props.mode === "update"
						? agentApplicationEditActionLabels[props.action]
						: "Create application"}
			</button>
		</form>
	);
}
