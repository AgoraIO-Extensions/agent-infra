import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";

import {
	candidateKey,
	initialKeylessModelRows,
	type KeylessCurrentModelOption,
	type KeylessModelCandidate,
	type KeylessModelRows,
	type KeylessModelSelection,
	type KeylessModelSelectionProblem,
	keylessModelSelection,
	normalizedKeylessDefaults,
	selectedKeylessCandidates,
} from "./keyless-model-selection.js";

const problemMessages: Record<KeylessModelSelectionProblem, string> = {
	no_model: "至少选择一个模型。",
	no_reasoning_level: "每个已选模型至少保留一个推理档位。",
	no_default: "请选择默认模型和默认推理档位。",
};

type KeylessModelPickerProps = {
	/** 该 Key 可见、且模板与目录都允许的模型。 */
	candidates: readonly KeylessModelCandidate[];
	/** 当前配置：用来预先勾选已启用的模型和默认项。 */
	current: readonly KeylessCurrentModelOption[];
	currentDefault: { optionId: string; level: string };
	disabled?: boolean;
	idPrefix?: string;
	/** 选择完整有效时给出模型选择，否则为 null。 */
	onChange: (selection: KeylessModelSelection | null) => void;
};

export function KeylessModelPicker({
	candidates,
	current,
	currentDefault,
	disabled = false,
	idPrefix = "keyless-model",
	onChange,
}: KeylessModelPickerProps) {
	const [rows, setRows] = useState<KeylessModelRows>(() =>
		initialKeylessModelRows(candidates, current),
	);
	const [preferred, setPreferred] = useState(currentDefault);
	const defaults = useMemo(
		() => normalizedKeylessDefaults(candidates, rows, preferred),
		[candidates, rows, preferred],
	);
	const result = useMemo(
		() => keylessModelSelection(candidates, rows, defaults),
		[candidates, rows, defaults],
	);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	useEffect(() => {
		onChangeRef.current(result.selection ?? null);
	}, [result]);

	const selected = selectedKeylessCandidates(candidates, rows).filter(
		(candidate) => (rows[candidateKey(candidate)]?.levels.length ?? 0) > 0,
	);
	const defaultLevels = [...(rows[defaults.optionId]?.levels ?? [])].toSorted();
	const setRow = (key: string, change: Partial<KeylessModelRows[string]>) =>
		setRows((existing) => ({
			...existing,
			[key]: {
				checked: existing[key]?.checked ?? false,
				levels: existing[key]?.levels ?? [],
				...change,
			},
		}));

	return (
		<section
			aria-labelledby={`${idPrefix}-heading`}
			className="configuration-section detail-section space-y-3 border-border border-t pt-4"
		>
			<h2 className="configuration-section-heading" id={`${idPrefix}-heading`}>
				选择允许的模型
			</h2>
			<p className="text-muted-foreground text-sm">
				只列出该 Key 可见、且模板支持的模型。勾选后可调整推理档位和默认项。
			</p>
			{candidates.map((candidate) => {
				const key = candidateKey(candidate);
				const row = rows[key] ?? { checked: false, levels: [] };
				return (
					<div className="space-y-2" key={key}>
						<Label className="min-h-11 gap-3">
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
							{candidate.endpointId} · {candidate.modelId}
						</Label>
						{row.checked ? (
							<fieldset className="flex min-w-0 flex-wrap gap-4 pl-7">
								<legend className="sr-only">
									{candidate.modelId} 的推理档位
								</legend>
								{candidate.reasoningLevels.map((level) => (
									<Label className="min-h-11 gap-2" key={level}>
										<Checkbox
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
										{level}
									</Label>
								))}
							</fieldset>
						) : null}
					</div>
				);
			})}
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor={`${idPrefix}-default-model`}>默认模型</Label>
					<NativeSelect
						disabled={disabled || selected.length === 0}
						id={`${idPrefix}-default-model`}
						onChange={(event) =>
							setPreferred((existing) => ({
								...existing,
								optionId: event.target.value,
							}))
						}
						value={defaults.optionId}
					>
						{selected.length === 0 ? (
							<NativeSelectOption value="">请先选择模型</NativeSelectOption>
						) : null}
						{selected.map((candidate) => (
							<NativeSelectOption
								key={candidateKey(candidate)}
								value={candidateKey(candidate)}
							>
								{candidate.endpointId} · {candidate.modelId}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`${idPrefix}-default-reasoning`}>默认推理档位</Label>
					<NativeSelect
						disabled={disabled || defaultLevels.length === 0}
						id={`${idPrefix}-default-reasoning`}
						onChange={(event) =>
							setPreferred((existing) => ({
								...existing,
								level: event.target.value,
							}))
						}
						value={defaults.level}
					>
						{defaultLevels.length === 0 ? (
							<NativeSelectOption value="">请先选择模型</NativeSelectOption>
						) : null}
						{defaultLevels.map((level) => (
							<NativeSelectOption key={level} value={level}>
								{level}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			</div>
			{result.problem ? (
				<p className="text-destructive text-sm" role="status">
					{problemMessages[result.problem]}
				</p>
			) : null}
		</section>
	);
}
