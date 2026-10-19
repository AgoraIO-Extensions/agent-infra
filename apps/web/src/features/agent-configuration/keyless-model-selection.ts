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
	/** 投影中的显示名；只用于提示文字。 */
	readonly displayName?: string;
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

/** 端点 ID → 部署目录中的端点显示名。 */
export type KeylessEndpointNames = Readonly<Record<string, string>>;

/**
 * 候选模型的可读名称（RK2-01）：端点用部署目录显示名，模型在契约补显示名前沿用模型名；
 * 原始端点 ID 不进入页面。目录里找不到端点时只显示模型名，同名时加序号区分。
 */
export function keylessCandidateLabels(
	candidates: readonly KeylessModelCandidate[],
	endpointNames: KeylessEndpointNames = {},
): ReadonlyMap<string, string> {
	const base = candidates.map((candidate) => {
		const endpoint = endpointNames[candidate.endpointId];
		return endpoint ? `${endpoint} · ${candidate.modelId}` : candidate.modelId;
	});
	const seen = new Map<string, number>();
	return new Map(
		candidates.map((candidate, index) => {
			const label = base[index] ?? candidate.modelId;
			const total = base.filter((item) => item === label).length;
			const count = (seen.get(label) ?? 0) + 1;
			seen.set(label, count);
			return [
				candidateKey(candidate),
				total > 1 ? `${label}（${count}）` : label,
			] as const;
		}),
	);
}

/**
 * 已配置模型的可读名称：选项 ID 中的端点换成部署目录显示名，原始端点 ID 不显示（RK2-01）；
 * 选项 ID 不是约定格式或目录里没有该端点时，用投影的显示名。
 */
export function currentOptionLabel(
	option: KeylessCurrentModelOption,
	endpointNames: KeylessEndpointNames = {},
) {
	const separator = option.optionId.indexOf(":");
	if (separator > 0) {
		try {
			const endpoint =
				endpointNames[decodeURIComponent(option.optionId.slice(0, separator))];
			if (endpoint) return `${endpoint} · ${option.modelId}`;
		} catch {
			// 编码不合法时按显示名展示。
		}
	}
	return option.displayName ?? option.modelId;
}

/** 当前配置中的某个模型是否对应这个候选（与预先勾选使用同一规则）。 */
export function currentOptionMatchesCandidate(
	option: KeylessCurrentModelOption,
	candidate: KeylessModelCandidate,
	candidates: readonly KeylessModelCandidate[],
) {
	return matchingCurrentOption(candidate, candidates, [option]) !== undefined;
}

/**
 * 当前已配置、但在这次选择中会被移除的模型（RK2-02）：候选里没有它，或对应候选没被勾选。
 */
export function removedCurrentOptions(
	candidates: readonly KeylessModelCandidate[],
	rows: KeylessModelRows,
	current: readonly KeylessCurrentModelOption[],
) {
	return current.filter(
		(option) =>
			!candidates.some(
				(candidate) =>
					rows[candidateKey(candidate)]?.checked &&
					currentOptionMatchesCandidate(option, candidate, candidates),
			),
	);
}

/** 两组勾选状态是否等价（未勾选行的档位不计）。 */
export function sameKeylessRows(
	candidates: readonly KeylessModelCandidate[],
	left: KeylessModelRows,
	right: KeylessModelRows,
) {
	return candidates.every((candidate) => {
		const key = candidateKey(candidate);
		const a = left[key];
		const b = right[key];
		const checked = Boolean(a?.checked);
		if (checked !== Boolean(b?.checked)) return false;
		if (!checked) return true;
		const levels = (row: KeylessModelRow | undefined) =>
			JSON.stringify([...(row?.levels ?? [])].toSorted());
		return levels(a) === levels(b);
	});
}

/** 以一次未保存的选择为起点（例如替换默认 Key 后按新候选重建，RK2-08），只保留新候选内的部分。 */
export function keylessRowsFromSelection(
	candidates: readonly KeylessModelCandidate[],
	selection: Pick<KeylessModelSelection, "options">,
): KeylessModelRows {
	return Object.fromEntries(
		candidates.map((candidate) => {
			const picked = selection.options.find(
				(option) => option.optionId === candidateKey(candidate),
			);
			const levels = picked
				? candidate.reasoningLevels.filter((level) =>
						picked.reasoningLevels.includes(level),
					)
				: [];
			return [
				candidateKey(candidate),
				{ checked: picked !== undefined && levels.length > 0, levels },
			];
		}),
	);
}

/**
 * 新候选是否覆盖当前全部模型及其推理档位（G-09）：覆盖时只替换 Key，不改模型集合；
 * 否则返回新 Key 不能调用的当前模型。
 */
export function uncoveredCurrentOptions(
	candidates: readonly KeylessModelCandidate[],
	current: readonly KeylessCurrentModelOption[],
) {
	return current.filter((option) => {
		const candidate = candidates.find((item) =>
			currentOptionMatchesCandidate(option, item, candidates),
		);
		return (
			candidate === undefined ||
			option.reasoningLevels.some(
				(level) => !candidate.reasoningLevels.includes(level),
			)
		);
	});
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
