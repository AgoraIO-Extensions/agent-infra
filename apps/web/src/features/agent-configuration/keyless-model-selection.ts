/**
 * 带默认 Relay Key 的 Agent 更换模型集合：从该 Key 可见的候选模型里选择（#2421）。
 * 这里只放纯函数：候选与当前配置如何对应、勾选状态如何变成请求里的模型选择。
 */

export type KeylessModelCandidate = {
	readonly endpointId: string;
	readonly modelId: string;
	readonly reasoningLevels: readonly string[];
};

export type KeylessCurrentModelOption = {
	readonly optionId: string;
	readonly modelId: string;
	readonly reasoningLevels: readonly string[];
};

export type KeylessModelRow = {
	readonly checked: boolean;
	readonly levels: readonly string[];
};

export type KeylessModelRows = Readonly<Record<string, KeylessModelRow>>;

export type KeylessModelSelection = {
	options: {
		optionId: string;
		endpointId: string;
		modelId: string;
		reasoningLevels: string[];
	}[];
	defaultOptionId: string;
	defaultReasoningLevel: string;
};

/** 与申请表单、服务端一致的选项 ID：端点和模型分别做 URI 编码后用冒号连接。 */
export function optionIdFor(endpointId: string, modelId: string) {
	return `${encodeURIComponent(endpointId)}:${encodeURIComponent(modelId)}`;
}

/** 早期配置用未编码的 `端点:模型`；仍按它识别当前选项。 */
function legacyOptionIdFor(endpointId: string, modelId: string) {
	return `${endpointId}:${modelId}`;
}

export function candidateKey(candidate: KeylessModelCandidate) {
	return optionIdFor(candidate.endpointId, candidate.modelId);
}

function matchingCurrentOption(
	candidate: KeylessModelCandidate,
	candidates: readonly KeylessModelCandidate[],
	current: readonly KeylessCurrentModelOption[],
) {
	const key = candidateKey(candidate);
	const exact = current.find(
		(option) =>
			option.optionId === key ||
			option.optionId ===
				legacyOptionIdFor(candidate.endpointId, candidate.modelId),
	);
	if (exact) return exact;
	// 选项 ID 不符合约定时，只有候选里这个模型唯一才按模型 ID 对应，避免误选其他端点。
	const sameModel = candidates.filter(
		(item) => item.modelId === candidate.modelId,
	);
	return sameModel.length === 1
		? current.find((option) => option.modelId === candidate.modelId)
		: undefined;
}

/** 以当前配置为起点：当前已启用的模型预先勾选，推理档位取与候选的交集。 */
export function initialKeylessModelRows(
	candidates: readonly KeylessModelCandidate[],
	current: readonly KeylessCurrentModelOption[],
): KeylessModelRows {
	return Object.fromEntries(
		candidates.map((candidate) => {
			const match = matchingCurrentOption(candidate, candidates, current);
			const kept = match
				? candidate.reasoningLevels.filter((level) =>
						match.reasoningLevels.includes(level),
					)
				: [];
			return [
				candidateKey(candidate),
				{
					checked: match !== undefined,
					levels:
						kept.length > 0
							? kept
							: match
								? [...candidate.reasoningLevels]
								: [],
				},
			];
		}),
	);
}

export function selectedKeylessCandidates(
	candidates: readonly KeylessModelCandidate[],
	rows: KeylessModelRows,
) {
	return candidates.filter(
		(candidate) => rows[candidateKey(candidate)]?.checked,
	);
}

/** 默认项必须落在已勾选的模型和档位内；不再有效时回到当前默认或第一项。 */
export function normalizedKeylessDefaults(
	candidates: readonly KeylessModelCandidate[],
	rows: KeylessModelRows,
	preferred: { optionId: string; level: string },
) {
	const selected = selectedKeylessCandidates(candidates, rows).filter(
		(candidate) => (rows[candidateKey(candidate)]?.levels.length ?? 0) > 0,
	);
	const chosen =
		selected.find(
			(candidate) => candidateKey(candidate) === preferred.optionId,
		) ?? selected[0];
	if (!chosen) return { optionId: "", level: "" };
	const levels = rows[candidateKey(chosen)]?.levels ?? [];
	return {
		optionId: candidateKey(chosen),
		level: levels.includes(preferred.level)
			? preferred.level
			: (levels.toSorted()[0] ?? ""),
	};
}

export type KeylessModelSelectionProblem =
	| "no_model"
	| "no_reasoning_level"
	| "no_default";

/**
 * 把勾选状态变成请求里的模型选择。推理档位按字典序排序：服务端准入结果就是排序后的，
 * 请求必须与它逐字一致。
 */
export function keylessModelSelection(
	candidates: readonly KeylessModelCandidate[],
	rows: KeylessModelRows,
	defaults: { optionId: string; level: string },
):
	| { selection: KeylessModelSelection; problem?: undefined }
	| { selection?: undefined; problem: KeylessModelSelectionProblem } {
	const selected = selectedKeylessCandidates(candidates, rows);
	if (selected.length === 0) return { problem: "no_model" };
	if (
		selected.some(
			(item) => (rows[candidateKey(item)]?.levels.length ?? 0) === 0,
		)
	)
		return { problem: "no_reasoning_level" };
	const defaultRow = rows[defaults.optionId];
	if (
		!defaults.optionId ||
		!defaultRow?.checked ||
		!defaultRow.levels.includes(defaults.level)
	)
		return { problem: "no_default" };
	return {
		selection: {
			options: selected.map((candidate) => ({
				optionId: candidateKey(candidate),
				endpointId: candidate.endpointId,
				modelId: candidate.modelId,
				reasoningLevels: [
					...(rows[candidateKey(candidate)]?.levels ?? []),
				].toSorted(),
			})),
			defaultOptionId: defaults.optionId,
			defaultReasoningLevel: defaults.level,
		},
	};
}
