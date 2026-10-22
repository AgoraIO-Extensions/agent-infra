import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { withObjectName } from "@/lib/accessible-name";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
import {
	candidateKey,
	currentOptionLabel,
	currentOptionMatchesCandidate,
	initialKeylessModelRows,
	type KeylessCurrentModelOption,
	type KeylessEndpointNames,
	type KeylessModelCandidate,
	type KeylessModelRows,
	type KeylessModelSelection,
	type KeylessModelSelectionProblem,
	keylessCandidateLabels,
	keylessModelSelection,
	keylessRowsFromSelection,
	normalizedKeylessDefaults,
	removedCurrentOptions,
	sameKeylessRows,
	selectedKeylessCandidates,
} from "./keyless-model-selection.js";

const problemMessages: Record<KeylessModelSelectionProblem, string> = {
	no_model: "至少选择一个模型。",
	no_reasoning_level: "每个已选模型至少保留一个推理档位。",
	no_default: "请选择默认模型选项。",
};

export type ConfigurationModelPickerChange = {
	/** 选择完整有效时的模型选择，否则为 null。 */
	readonly selection: KeylessModelSelection | null;
	/** 用户是否改动过选择；改回初始值时为 false（RK2-02）。 */
	readonly changed: boolean;
};

type ConfigurationModelPickerProps = {
	/** 该 Key 可见、且模板与目录都允许的模型。 */
	candidates: readonly KeylessModelCandidate[];
	/** 当前配置：用来预先勾选已启用的模型和默认项，也是判断是否改动的基准。 */
	current: readonly KeylessCurrentModelOption[];
	currentDefault: { optionId: string; level: string };
	/** 选择器上方的说明。 */
	description: string;
	disabled?: boolean;
	endpointNames?: KeylessEndpointNames;
	idPrefix?: string;
	/** 提交被拦下后由页面置真：未改动过也显示字段错误（RK2-03）。 */
	showErrors?: boolean;
	/** 以一次未保存的选择为起点（按新候选重建时保留用户勾选，RK2-08）。 */
	startFrom?: KeylessModelSelection;
	onChange: (change: ConfigurationModelPickerChange) => void;
};

/**
 * Owner 配置「模型与凭证」分区里的模型选择（RK2-01、RK2-07）：勾选模型与推理档位，再从
 * 已选组合里选一个「默认模型选项」。根节点不画边线，也不嵌套 fieldset + legend。
 * 申请表单仍使用 KeylessModelPicker，两处的取值与请求格式相同。
 */
export function ConfigurationModelPicker({
	candidates,
	current,
	currentDefault,
	description,
	disabled = false,
	endpointNames,
	idPrefix = "configuration-model",
	showErrors = false,
	startFrom,
	onChange,
}: ConfigurationModelPickerProps) {
	const baselineRows = useMemo(
		() => initialKeylessModelRows(candidates, current),
		[candidates, current],
	);
	const [rows, setRows] = useState<KeylessModelRows>(() =>
		startFrom ? keylessRowsFromSelection(candidates, startFrom) : baselineRows,
	);
	// 当前默认项的选项 ID 不符合约定时，按与预先勾选相同的规则换成对应候选（RK2-02）。
	const resolvedDefault = useMemo(() => {
		const option = current.find(
			(item) => item.optionId === currentDefault.optionId,
		);
		const candidate = option
			? candidates.find((item) =>
					currentOptionMatchesCandidate(option, item, candidates),
				)
			: undefined;
		return candidate
			? { optionId: candidateKey(candidate), level: currentDefault.level }
			: currentDefault;
	}, [candidates, current, currentDefault]);
	const [preferred, setPreferred] = useState(() =>
		startFrom
			? {
					optionId: startFrom.defaultOptionId,
					level: startFrom.defaultReasoningLevel,
				}
			: resolvedDefault,
	);
	const [touched, setTouched] = useState(startFrom !== undefined);
	const labels = useMemo(
		() => keylessCandidateLabels(candidates, endpointNames),
		[candidates, endpointNames],
	);
	const defaults = useMemo(
		() => normalizedKeylessDefaults(candidates, rows, preferred),
		[candidates, rows, preferred],
	);
	const baselineDefaults = useMemo(
		() => normalizedKeylessDefaults(candidates, baselineRows, resolvedDefault),
		[candidates, baselineRows, resolvedDefault],
	);
	const result = useMemo(
		() => keylessModelSelection(candidates, rows, defaults),
		[candidates, rows, defaults],
	);
	const changed =
		touched &&
		!(
			sameKeylessRows(candidates, rows, baselineRows) &&
			defaults.optionId === baselineDefaults.optionId &&
			defaults.level === baselineDefaults.level
		);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	useEffect(() => {
		onChangeRef.current({ selection: result.selection ?? null, changed });
	}, [result, changed]);

	const selected = selectedKeylessCandidates(candidates, rows).filter(
		(candidate) => (rows[candidateKey(candidate)]?.levels.length ?? 0) > 0,
	);
	const defaultChoices = selected.flatMap((candidate) =>
		[...(rows[candidateKey(candidate)]?.levels ?? [])]
			.toSorted()
			.map((level) => ({
				value: `${candidateKey(candidate)}|${level}`,
				optionId: candidateKey(candidate),
				level,
				label: `${labels.get(candidateKey(candidate)) ?? candidate.modelId} · ${reasoningLevelLabel(level)}`,
			})),
	);
	const removed = changed
		? removedCurrentOptions(candidates, rows, current)
		: [];
	const problem = result.problem;
	// 改回初始选择时不显示错误：页面同时判定为未改动，保存也不会带上模型（acc-2 新问题 2）。
	const errorVisible = Boolean(problem) && (changed || showErrors);
	const errorId = `${idPrefix}-error`;
	const setRow = (key: string, change: Partial<KeylessModelRows[string]>) => {
		setTouched(true);
		setRows((existing) => ({
			...existing,
			[key]: {
				checked: existing[key]?.checked ?? false,
				levels: existing[key]?.levels ?? [],
				...change,
			},
		}));
	};
	const currentLabel = (option: KeylessCurrentModelOption) => {
		const candidate = candidates.find((item) =>
			currentOptionMatchesCandidate(option, item, candidates),
		);
		return (
			(candidate ? labels.get(candidateKey(candidate)) : undefined) ??
			currentOptionLabel(option, endpointNames)
		);
	};

	return (
		<div
			id={idPrefix}
			data-slot="keyless-model-picker"
			className="keyless-model-picker"
		>
			{removed.length > 0 ? (
				<Alert tone="warn" role="status">
					<AlertTitle>保存后会移除这些模型</AlertTitle>
					<AlertDescription>
						{removed.map(currentLabel).join("、")}
					</AlertDescription>
				</Alert>
			) : null}
			<p className="keyless-model-description">{description}</p>
			<fieldset
				aria-label="允许的模型"
				aria-describedby={errorVisible ? errorId : undefined}
				className="keyless-model-list"
			>
				{candidates.map((candidate, candidateIndex) => {
					const key = candidateKey(candidate);
					const label = labels.get(key) ?? candidate.modelId;
					const row = rows[key] ?? { checked: false, levels: [] };
					return (
						<div className="keyless-model-item" key={key}>
							<Label variant="option">
								<Checkbox
									checked={row.checked}
									disabled={disabled}
									onCheckedChange={(checked) =>
										setRow(key, {
											checked,
											// 首次勾选时默认启用全部档位，避免一个也不选。
											levels:
												checked && row.levels.length === 0
													? [...candidate.reasoningLevels]
													: row.levels,
										})
									}
								/>
								{label}
							</Label>
							{row.checked ? (
								<fieldset
									aria-label={`${label} 的推理档位`}
									className="keyless-level-row"
								>
									{candidate.reasoningLevels.map((level, levelIndex) => {
										// 多个模型同时展开档位时，名称带上所属模型（「均衡：{模型}」，D2-58）。
										// base-ui 复选框默认取外层 label 作 aria-labelledby，所以与 E3-16 相同，
										// 名称取自旁边的隐藏文本；可见文字与点击标签切换不变。
										const nameId = `${idPrefix}-level-${candidateIndex}-${levelIndex}-name`;
										return (
											<Fragment key={level}>
												<Label variant="option">
													<Checkbox
														aria-labelledby={nameId}
														checked={row.levels.includes(level)}
														disabled={disabled}
														onCheckedChange={(checked) =>
															setRow(key, {
																levels: checked
																	? [...row.levels, level]
																	: row.levels.filter((item) => item !== level),
															})
														}
													/>
													{reasoningLevelLabel(level)}
												</Label>
												<span id={nameId} hidden>
													{withObjectName(reasoningLevelLabel(level), label)}
												</span>
											</Fragment>
										);
									})}
								</fieldset>
							) : null}
						</div>
					);
				})}
			</fieldset>
			<div className="keyless-model-default">
				<Field>
					<Label htmlFor={`${idPrefix}-default-option`}>默认模型选项</Label>
					<NativeSelect
						disabled={disabled || defaultChoices.length === 0}
						id={`${idPrefix}-default-option`}
						onChange={(event) => {
							const choice = defaultChoices.find(
								(item) => item.value === event.target.value,
							);
							if (!choice) return;
							setTouched(true);
							setPreferred({ optionId: choice.optionId, level: choice.level });
						}}
						value={
							defaults.optionId ? `${defaults.optionId}|${defaults.level}` : ""
						}
					>
						{defaultChoices.length === 0 ? (
							<NativeSelectOption value="">请先选择模型</NativeSelectOption>
						) : null}
						{defaultChoices.map((choice) => (
							<NativeSelectOption key={choice.value} value={choice.value}>
								{choice.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			</div>
			{errorVisible && problem ? (
				<FieldError id={errorId}>{problemMessages[problem]}</FieldError>
			) : null}
		</div>
	);
}

/** 让页面在保存被拦下时把焦点移到选择器第一个控件（RK2-03）。 */
export function focusConfigurationModelPicker(idPrefix: string) {
	document
		.getElementById(idPrefix)
		?.querySelector<HTMLElement>('[role="checkbox"]')
		?.focus();
}
