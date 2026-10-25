import { RefreshCw } from "lucide-react";
import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useLayoutEffect,
	useRef,
} from "react";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { FormSection } from "@/components/ui/form-section";
import { Label } from "@/components/ui/label";
import { LoadingLine } from "@/components/ui/spinner";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { RecoveryButton } from "../recovery-button.js";
import {
	type AgentConfigurationRequestError,
	isRetryableConfigurationError,
} from "./agent-configuration.js";
import type { AgentConfigurationDraft } from "./agent-configuration-draft.js";
import {
	ConfigurationModelPicker,
	type ConfigurationModelPickerChange,
} from "./configuration-model-picker.js";
import {
	currentOptionLabel,
	type KeylessEndpointNames,
	type KeylessModelCandidate,
	type KeylessModelSelection,
} from "./keyless-model-selection.js";

export const catalogModelPickerId = "configuration-catalog-model";
export const savedModelPickerId = "configuration-saved-key-model";

type ConfigurationModelSectionProps = {
	agent: AgentProjectionV2;
	defaultRelayKeyManaged: boolean;
	deploymentModelCandidates?: readonly KeylessModelCandidate[];
	draft: AgentConfigurationDraft;
	endpointNames?: KeylessEndpointNames;
	isDisabled: boolean;
	/** 默认 Key 替换进行中：选择器保留并禁用（RK2-08）。 */
	keyBusy: boolean;
	onCatalogSelectionErrorChange: (error: boolean) => void;
	onRetrySavedRelayKeyCandidates?: () => void;
	onSavedSelectionErrorChange: (error: boolean) => void;
	savedRelayKeyCandidates?: readonly KeylessModelCandidate[];
	savedRelayKeyCandidatesError: AgentConfigurationRequestError | null;
	savedRelayKeyCandidatesLoading: boolean;
	/** 保存被拦下后显示选择器的字段错误（RK2-03）。 */
	showSelectionErrors: boolean;
	setDraft: Dispatch<SetStateAction<AgentConfigurationDraft>>;
};

function selectionDraft(
	current: AgentConfigurationDraft,
	selection: KeylessModelSelection | null,
	replaceModels: boolean,
): AgentConfigurationDraft {
	return {
		...current,
		replaceModels,
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

/** 草稿里未保存的模型选择，用作按新候选重建选择器的起点（RK2-08）。 */
function draftSelection(
	draft: AgentConfigurationDraft,
): KeylessModelSelection | undefined {
	if (!draft.replaceModels || draft.models.length === 0) return undefined;
	return {
		options: draft.models.map((model) => ({
			optionId: model.optionId,
			endpointId: model.endpointId,
			modelId: model.modelId,
			reasoningLevels: model.reasoningLevels.split(",").filter(Boolean),
		})),
		defaultOptionId: draft.defaultModelOptionId,
		defaultReasoningLevel: draft.defaultReasoningLevel,
	};
}

/**
 * 标准模板的「模型与凭证」分区（RK2-01～RK2-07）：默认 Key 托管时用已保存 Key 的候选
 * 选择模型，否则用部署目录候选。默认 Key 的状态与替换在下一个分区。
 */
export function ConfigurationModelSection({
	agent,
	defaultRelayKeyManaged,
	deploymentModelCandidates,
	draft,
	endpointNames = {},
	isDisabled,
	keyBusy,
	onCatalogSelectionErrorChange,
	onRetrySavedRelayKeyCandidates,
	onSavedSelectionErrorChange,
	savedRelayKeyCandidates,
	savedRelayKeyCandidatesError,
	savedRelayKeyCandidatesLoading,
	showSelectionErrors,
	setDraft,
}: ConfigurationModelSectionProps) {
	const modelOptions = agent.configuration.modelOptions;
	const currentDefaultModel = modelOptions.find(
		(model) => model.optionId === agent.configuration.defaultModelOptionId,
	);
	const currentDefault = {
		optionId: agent.configuration.defaultModelOptionId ?? "",
		level: agent.configuration.defaultReasoningLevel ?? "",
	};
	const summary = (
		<div className="configuration-model-summary">
			<p>
				当前模型：
				{modelOptions.length
					? modelOptions
							.map((model) => currentOptionLabel(model, endpointNames))
							.join("、")
					: "尚未配置可选模型"}
			</p>
			<p>
				当前默认：
				{currentDefaultModel
					? `${currentOptionLabel(currentDefaultModel, endpointNames)}${agent.configuration.defaultReasoningLevel ? ` · ${reasoningLevelLabel(agent.configuration.defaultReasoningLevel)}` : ""}`
					: "未提供"}
			</p>
		</div>
	);
	// 已保存 Key 的选择器因读取不可重试地失败而收起时（#3418 N14-02），焦点原在选择器里的交给本分区标题，
	// 不落到 body。渲染时记下焦点是否在本分区内容里（提交前 DOM 仍是上一次的选择器）。
	const savedPickerShown =
		defaultRelayKeyManaged && Boolean(savedRelayKeyCandidates?.length);
	const contentRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const focusInside = useRef(false);
	const pickerWasShown = useRef(savedPickerShown);
	focusInside.current =
		typeof document !== "undefined" &&
		Boolean(contentRef.current?.contains(document.activeElement));
	useLayoutEffect(() => {
		const hidden = pickerWasShown.current && !savedPickerShown;
		pickerWasShown.current = savedPickerShown;
		if (!hidden || !focusInside.current) return;
		const active = document.activeElement;
		if (!active || active === document.body || !active.isConnected)
			headingRef.current?.focus();
	}, [savedPickerShown]);
	const startFrom = draftSelection(draft);
	const pickerKey = (candidates: readonly KeylessModelCandidate[]) =>
		candidates
			.map((candidate) => `${candidate.endpointId}/${candidate.modelId}`)
			.join("|");

	if (defaultRelayKeyManaged) {
		const retryable = isRetryableConfigurationError(
			savedRelayKeyCandidatesError,
		);
		let content: ReactNode;
		if (savedRelayKeyCandidates?.length)
			content = (
				<ConfigurationModelPicker
					candidates={savedRelayKeyCandidates}
					current={modelOptions}
					currentDefault={currentDefault}
					description="只列出默认 Key 可见、且模板支持的模型。勾选后可调整推理档位和默认模型选项。"
					disabled={isDisabled || keyBusy}
					endpointNames={endpointNames}
					idPrefix={savedModelPickerId}
					key={pickerKey(savedRelayKeyCandidates)}
					// 已保存 Key 模式只在改过选择时校验（RK2-03）：改回初始选择后不再沿用提交时的错误。
					showErrors={showSelectionErrors && draft.replaceModels}
					startFrom={startFrom}
					onChange={({
						selection,
						changed,
					}: ConfigurationModelPickerChange) => {
						onSavedSelectionErrorChange(changed && selection === null);
						setDraft((current) => selectionDraft(current, selection, changed));
					}}
				/>
			);
		else if (savedRelayKeyCandidates !== undefined)
			content = (
				<>
					{summary}
					<Alert tone="warn">
						<AlertTitle>当前默认 Key 没有此模板可用的模型</AlertTitle>
						<AlertDescription>
							在下方「Agent 默认 Relay Key」中替换默认 Key
							后可重新选择模型；当前配置保持不变。
						</AlertDescription>
					</Alert>
				</>
			);
		else if (savedRelayKeyCandidatesError)
			content = (
				<>
					{summary}
					<Alert tone="danger" role="alert">
						<AlertTitle>
							{retryable ? "暂时无法读取可用模型" : "无法读取可用模型"}
						</AlertTitle>
						<AlertDescription>
							{retryable
								? "当前配置保持不变，可以重新读取。"
								: "权限或 Agent 状态已变化，请刷新页面；如果默认 Key 已失效，请替换默认 Key。"}
						</AlertDescription>
						{retryable && onRetrySavedRelayKeyCandidates ? (
							<AlertAction>
								{/* 公共恢复按钮（#3242 K7-02）：读取中可聚焦；没有已读到的候选时重读会先回到
								    读取中、失败提示随之收起，焦点交给 h1，仍失败时回到这里，不落到 body。 */}
								<RecoveryButton
									busy={savedRelayKeyCandidatesLoading}
									onClick={onRetrySavedRelayKeyCandidates}
									recoveryKey="重新读取可用模型"
									variant="outline"
								>
									<RefreshCw aria-hidden="true" data-icon="inline-start" />
									{savedRelayKeyCandidatesLoading
										? "正在重新读取…"
										: "重新读取可用模型"}
								</RecoveryButton>
							</AlertAction>
						) : null}
					</Alert>
				</>
			);
		else
			content = (
				<>
					{summary}
					{savedRelayKeyCandidatesLoading ? (
						<LoadingLine>正在读取已保存 Key 的可用模型…</LoadingLine>
					) : null}
				</>
			);
		return (
			<FormSection
				title="模型与凭证"
				description="Owner 可以设置默认模型和可用推理档位。"
				headingRef={headingRef}
			>
				<div className="configuration-model-content" ref={contentRef}>
					{content}
				</div>
			</FormSection>
		);
	}

	return (
		<FormSection
			title="模型与凭证"
			description="Owner 可以设置默认模型和可用推理档位。"
		>
			<div className="configuration-model-content">
				{draft.replaceModels && deploymentModelCandidates ? null : summary}
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
				{draft.replaceModels ? (
					deploymentModelCandidates ? (
						<ConfigurationModelPicker
							candidates={deploymentModelCandidates}
							current={modelOptions}
							currentDefault={currentDefault}
							description="只列出部署目录中模板支持的模型。勾选后可调整推理档位和默认模型选项。"
							disabled={isDisabled}
							endpointNames={endpointNames}
							idPrefix={catalogModelPickerId}
							key={pickerKey(deploymentModelCandidates)}
							showErrors={showSelectionErrors}
							onChange={({ selection }: ConfigurationModelPickerChange) => {
								onCatalogSelectionErrorChange(selection === null);
								// 勾选「替换模型配置」即表示要替换：初始选择也写入草稿。
								setDraft((current) =>
									selectionDraft(current, selection, current.replaceModels),
								);
							}}
						/>
					) : (
						<Alert tone="danger" role="alert">
							<AlertDescription>
								模型目录暂时不可用，无法编辑模型配置；请刷新后重试。
							</AlertDescription>
						</Alert>
					)
				) : null}
			</div>
		</FormSection>
	);
}
