import type { Dispatch, SetStateAction } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingLine } from "@/components/ui/spinner";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import type { AgentDefaultRelayKeyState } from "./agent-configuration.js";
import type { AgentConfigurationDraft } from "./agent-configuration-draft.js";
import { KeylessModelPicker } from "./keyless-model-picker.js";
import type {
	KeylessModelCandidate,
	KeylessModelSelection,
} from "./keyless-model-selection.js";
import type { useKeylessKeyCheck } from "./use-keyless-key-check.js";

type ConfigurationModelSectionProps = {
	agent: AgentProjectionV2;
	defaultRelayKeyManaged: boolean;
	deploymentModelCandidates?: readonly KeylessModelCandidate[];
	draft: AgentConfigurationDraft;
	isDisabled: boolean;
	keyCheck: ReturnType<typeof useKeylessKeyCheck>;
	onCatalogSelectionErrorChange: (error: boolean) => void;
	onReplaceDefaultRelayKey?: (keyValue: string) => void;
	onRetrySavedRelayKeyCandidates?: () => void;
	onSavedSelectionErrorChange: (error: boolean) => void;
	relayKeyError: Error | null;
	relayKeyResult?: AgentDefaultRelayKeyState;
	relayKeySubmitting: boolean;
	savedRelayKeyCandidates?: readonly KeylessModelCandidate[];
	savedRelayKeyCandidatesError: Error | null;
	savedRelayKeyCandidatesLoading: boolean;
	savedSelectionError: boolean;
	setDraft: Dispatch<SetStateAction<AgentConfigurationDraft>>;
};

function selectionDraft(
	current: AgentConfigurationDraft,
	selection: KeylessModelSelection | null,
): AgentConfigurationDraft {
	return {
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
	};
}

/**
 * 标准模板的「模型配置」分区：当前模型、默认 Relay Key 替换与模型选择。
 * 状态（草稿、Key 检查、选择错误）由配置页持有，保存时一起校验。
 */
export function ConfigurationModelSection({
	agent,
	defaultRelayKeyManaged,
	deploymentModelCandidates,
	draft,
	isDisabled,
	keyCheck,
	onCatalogSelectionErrorChange,
	onReplaceDefaultRelayKey,
	onRetrySavedRelayKeyCandidates,
	onSavedSelectionErrorChange,
	relayKeyError,
	relayKeyResult,
	relayKeySubmitting,
	savedRelayKeyCandidates,
	savedRelayKeyCandidatesError,
	savedRelayKeyCandidatesLoading,
	savedSelectionError,
	setDraft,
}: ConfigurationModelSectionProps) {
	const currentModels = agent.configuration.modelOptions
		.map((model) => model.displayName)
		.join("、");
	const currentDefaultModel = agent.configuration.modelOptions.find(
		(model) => model.optionId === agent.configuration.defaultModelOptionId,
	);
	const currentDefault = {
		optionId: agent.configuration.defaultModelOptionId ?? "",
		level: agent.configuration.defaultReasoningLevel ?? "",
	};
	const catalogModelPicker = deploymentModelCandidates ? (
		<KeylessModelPicker
			candidates={deploymentModelCandidates}
			current={agent.configuration.modelOptions}
			currentDefault={currentDefault}
			disabled={isDisabled}
			idPrefix="configuration-catalog-model"
			key={deploymentModelCandidates
				.map((candidate) => `${candidate.endpointId}/${candidate.modelId}`)
				.join("|")}
			onChange={(selection: KeylessModelSelection | null) => {
				onCatalogSelectionErrorChange(selection === null);
				setDraft((current) => selectionDraft(current, selection));
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
				currentDefault={currentDefault}
				disabled={isDisabled}
				idPrefix="configuration-saved-key-model"
				key={savedRelayKeyCandidates
					.map((candidate) => `${candidate.endpointId}/${candidate.modelId}`)
					.join("|")}
				onChange={(selection: KeylessModelSelection | null) => {
					onSavedSelectionErrorChange(selection === null);
					setDraft((current) => selectionDraft(current, selection));
				}}
			/>
		) : null;
	const replaceDefaultRelayKey = () => {
		if (!onReplaceDefaultRelayKey || !keyCheck.typed) return;
		onReplaceDefaultRelayKey(keyCheck.key.trim());
		keyCheck.reset();
	};

	return (
		<FormSection title="模型配置">
			<div className="mt-4 space-y-4">
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
								onChange={(event) => keyCheck.setKey(event.target.value)}
								placeholder="输入新 Key"
								type="password"
								value={keyCheck.key}
							/>
							<Button
								disabled={isDisabled || keyCheck.checking || !keyCheck.typed}
								onClick={() => void keyCheck.runCheck()}
								type="button"
								variant="outline"
							>
								{keyCheck.checking ? "正在检查…" : "检查可用模型"}
							</Button>
							<Button
								disabled={isDisabled || relayKeySubmitting || !keyCheck.typed}
								onClick={replaceDefaultRelayKey}
								type="button"
							>
								{relayKeySubmitting ? "正在替换…" : "替换默认 Key"}
							</Button>
						</div>
						<p className="text-muted-foreground text-sm">
							当前 Key 只显示已设置状态；输入值不会回显或写入普通业务投影。
						</p>
						{relayKeyResult?.isSet && !relayKeySubmitting && !relayKeyError ? (
							<p className="font-medium text-foreground text-sm" role="status">
								默认 Key 已替换，当前版本 {relayKeyResult.keyVersion}。
							</p>
						) : null}
						{keyCheck.blocked ? (
							<Alert tone="danger" role="alert">
								<AlertDescription>
									已填写新
									Key，但还没有可保存的模型选择：请先点击「检查可用模型」，选好模型（至少一个模型，每个模型至少一个推理档位）后再保存；不想更换
									Key 请清空输入框。
								</AlertDescription>
							</Alert>
						) : null}
						{keyCheck.error || relayKeyError ? (
							<Alert tone="danger" role="alert">
								<AlertDescription>
									Key 校验或替换失败，请刷新后重试。
								</AlertDescription>
							</Alert>
						) : null}
						{keyCheck.candidates.length > 0 && !defaultRelayKeyManaged ? (
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
						{keyCheck.candidates.length > 0 && defaultRelayKeyManaged ? (
							<>
								<KeylessModelPicker
									candidates={keyCheck.candidates}
									current={agent.configuration.modelOptions}
									currentDefault={currentDefault}
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
							<LoadingLine>正在读取已保存 Key 的可用模型…</LoadingLine>
						) : null}
						{savedRelayKeyCandidatesError ? (
							<Alert tone="danger" role="alert">
								<AlertDescription>
									已保存的默认 Key 暂时无法读取可用模型。
								</AlertDescription>
								{onRetrySavedRelayKeyCandidates ? (
									<AlertAction>
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
									</AlertAction>
								) : null}
							</Alert>
						) : null}
						{savedModelPicker}
						{savedSelectionError ? (
							<Alert tone="danger" role="alert">
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
						<Label variant="option">
							<Checkbox
								disabled={isDisabled}
								checked={draft.replaceModels}
								onCheckedChange={(checked) => {
									onCatalogSelectionErrorChange(false);
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
									<Alert tone="danger" role="alert">
										<AlertDescription>
											模型目录暂时不可用，无法编辑模型配置；请刷新后重试。
										</AlertDescription>
									</Alert>
								))
							: null}
					</>
				)}
			</div>
		</FormSection>
	);
}
