import { useState } from "react";

import type {
	AgentConfigurationUpdateRequestV1Writable,
	AgentProjectionV1,
} from "../../pilot/generated/types.gen.js";
import type { BrowserSessionState } from "../agent-administration/agent-administration.js";
import { agentServiceAvailabilityLabel } from "../agent-discovery/agent-discovery-screen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import { isAgentConfigurationOwner } from "./agent-configuration.js";
import {
	type AgentConfigurationActionDraft,
	type AgentConfigurationModelDraft,
	type AgentConfigurationSecretDraft,
	buildAgentConfigurationRequest,
	configurationDraftFromAgent,
} from "./agent-configuration-draft.js";

type ConfigurationSessionState = BrowserSessionState | { kind: "loading" };

type AgentConfigurationScreenProps = {
	agent: AgentProjectionV1;
	commandError?: (Error & { readonly retryable?: boolean }) | null;
	commandResult?: AgentProjectionV1;
	onSave: (body: AgentConfigurationUpdateRequestV1Writable) => void;
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

const inputClassName =
	"min-h-11 w-full border border-slate-400 bg-white px-3 text-slate-950";

function blankAction(): AgentConfigurationActionDraft {
	return { providerId: "", actionId: "", actionVersion: "" };
}

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
							<label
								className="font-medium text-slate-800 text-sm"
								htmlFor={`configuration-${idPrefix}-${field.key}-${index}`}
							>
								{field.label}
							</label>
							<input
								autoComplete={
									field.type === "password" ? "new-password" : undefined
								}
								className={inputClassName}
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
					<button
						className="min-h-11 self-end border border-slate-400 px-3 font-medium text-slate-800 text-sm hover:bg-slate-100"
						onClick={() => onRemove(index)}
						type="button"
					>
						Remove {label}
					</button>
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
	const submittedResult =
		commandResult?.agentId === agent.agentId ? commandResult : undefined;

	const updateAction = (
		index: number,
		key: keyof AgentConfigurationActionDraft,
		value: string,
	) =>
		setDraft((current) => ({
			...current,
			actions: current.actions.map((action, actionIndex) =>
				actionIndex === index ? { ...action, [key]: value } : action,
			),
		}));
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
				<p className="font-medium text-slate-950 text-sm" role="status">
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
						submitConfiguration();
					}}
				>
					<fieldset className="space-y-4">
						<legend className="font-semibold text-slate-950 text-sm">
							Ownership
						</legend>
						<div className="space-y-2">
							<label
								className="font-medium text-slate-800 text-sm"
								htmlFor="configuration-owner-ids"
							>
								Owner user IDs
							</label>
							<textarea
								className="min-h-24 w-full border border-slate-400 bg-white px-3 py-2 text-slate-950"
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
								<label
									className="font-medium text-slate-800 text-sm"
									htmlFor="configuration-user-availability"
								>
									User availability IDs
								</label>
								<textarea
									className="min-h-24 w-full border border-slate-400 bg-white px-3 py-2 text-slate-950"
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
								<label
									className="font-medium text-slate-800 text-sm"
									htmlFor="configuration-organization-availability"
								>
									Organization availability IDs
								</label>
								<textarea
									className="min-h-24 w-full border border-slate-400 bg-white px-3 py-2 text-slate-950"
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
					{agent.capabilities.connection ? (
						<fieldset className="space-y-4 border-slate-200 border-t pt-5">
							<legend className="font-semibold text-slate-950 text-sm">
								Connection actions
							</legend>
							<DraftRows
								fields={
									[
										{ key: "providerId", label: "Provider ID", required: true },
										{ key: "actionId", label: "Action ID", required: true },
										{
											key: "actionVersion",
											label: "Action version",
											required: true,
										},
									] as const
								}
								idPrefix="action"
								label="action"
								onChange={updateAction}
								onRemove={(index) =>
									setDraft((current) => ({
										...current,
										actions: current.actions.filter(
											(_, actionIndex) => actionIndex !== index,
										),
									}))
								}
								rows={draft.actions}
							/>
							<button
								className="min-h-11 border border-slate-700 px-4 font-medium text-slate-800 text-sm hover:bg-slate-100"
								onClick={() =>
									setDraft((current) => ({
										...current,
										actions: [...current.actions, blankAction()],
									}))
								}
								type="button"
							>
								Add action
							</button>
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
							<label className="flex min-h-11 items-center gap-3 text-slate-800 text-sm">
								<input
									checked={draft.replaceModels}
									onChange={(event) =>
										setDraft((current) => ({
											...current,
											replaceModels: event.target.checked,
											models:
												event.target.checked && current.models.length === 0
													? [blankModel()]
													: current.models,
										}))
									}
									type="checkbox"
								/>
								Replace model configuration
							</label>
							{draft.replaceModels ? (
								<>
									<DraftRows
										fields={
											[
												{ key: "optionId", label: "Option ID", required: true },
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
									<button
										className="min-h-11 border border-slate-700 px-4 font-medium text-slate-800 text-sm hover:bg-slate-100"
										onClick={() =>
											setDraft((current) => ({
												...current,
												models: [...current.models, blankModel()],
											}))
										}
										type="button"
									>
										Add model
									</button>
									<div className="grid gap-4 sm:grid-cols-2">
										<div className="space-y-2">
											<label
												className="font-medium text-slate-800 text-sm"
												htmlFor="configuration-default-model"
											>
												Default option ID
											</label>
											<input
												className={inputClassName}
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
											<label
												className="font-medium text-slate-800 text-sm"
												htmlFor="configuration-default-reasoning"
											>
												Default reasoning level
											</label>
											<input
												className={inputClassName}
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
						<button
							className="min-h-11 border border-slate-700 px-4 font-medium text-slate-800 text-sm hover:bg-slate-100"
							onClick={() =>
								setDraft((current) => ({
									...current,
									secrets: [...current.secrets, blankSecret()],
								}))
							}
							type="button"
						>
							Add Secret
						</button>
					</fieldset>
					<button
						className="min-h-11 border border-slate-900 bg-slate-950 px-4 font-medium text-sm text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
						disabled={submitting}
						type="submit"
					>
						{submitting ? "Saving configuration..." : "Save configuration"}
					</button>
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
							<label
								className="font-medium text-slate-800 text-sm"
								htmlFor="configuration-image-reference"
							>
								New image reference
							</label>
							<input
								className={inputClassName}
								id="configuration-image-reference"
								onChange={(event) => setImageReference(event.target.value)}
								value={imageReference}
							/>
						</div>
						<button
							className="min-h-11 self-end border border-slate-700 px-4 font-medium text-slate-800 text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
							disabled={submitting || imageReference.trim().length === 0}
							onClick={() => onUpgradeImage(imageReference.trim())}
							type="button"
						>
							{submitting ? "Upgrading image..." : "Upgrade image"}
						</button>
					</div>
				</section>
			) : null}
		</section>
	);
}
