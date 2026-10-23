import { useRef, useState } from "react";

import type { AgentDefaultRelayKeyCheck } from "./agent-configuration.js";
import type { KeylessModelSelection } from "./keyless-model-selection.js";

export type KeylessKeyReplacement = {
	readonly defaultRelayKey: string;
	readonly expectedConfigurationRevision: number;
	readonly expectedKeyVersion: number | null;
	readonly modelConfiguration: KeylessModelSelection;
};

/**
 * 重新提交默认 Key 并更换模型集合的页面状态（#2421）：Key 文本、检查得到的候选和版本、
 * 用户选好的模型。检查响应绑定到发起检查时的输入——Key 一旦被改动或重置，迟到的响应
 * 直接丢弃，避免把 A 的候选和版本与 B 一起提交。
 */
export function useKeylessKeyCheck(
	check?: (keyValue: string) => Promise<AgentDefaultRelayKeyCheck>,
) {
	const [key, setKeyText] = useState("");
	const [candidates, setCandidates] = useState<
		AgentDefaultRelayKeyCheck["candidates"]
	>([]);
	const [versions, setVersions] = useState<{
		configurationRevision: number;
		keyVersion: number | null;
	}>();
	const [selection, setSelection] = useState<KeylessModelSelection | null>(
		null,
	);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState(false);
	const [blocked, setBlocked] = useState(false);
	const generation = useRef(0);
	const checkRef = useRef(check);
	checkRef.current = check;

	const clearResult = () => {
		setCandidates([]);
		setVersions(undefined);
		setSelection(null);
		setError(false);
		setBlocked(false);
	};
	const typed = key.trim().length > 0;
	// 检查成功后才有版本：据此区分「还没检查」与「检查过但没有可用模型」（#3268 N8-2-05）。
	const checked = versions !== undefined;
	const replacement: KeylessKeyReplacement | undefined =
		typed && versions && selection
			? {
					defaultRelayKey: key.trim(),
					expectedConfigurationRevision: versions.configurationRevision,
					expectedKeyVersion: versions.keyVersion,
					modelConfiguration: selection,
				}
			: undefined;

	return {
		blocked,
		candidates,
		/** 当前 Key 已检查成功（候选可能为空）。 */
		checked,
		checking,
		error,
		key,
		/** 检查成功但该 Key 没有此模板可用的模型。 */
		noCandidates: checked && candidates.length === 0,
		/** 已填写 Key，但还没有可提交的检查结果与有效选择。 */
		incomplete: typed && !replacement,
		replacement,
		typed,
		/** 保存被拦下：用户填了 Key 却没有完成检查与选择。 */
		block: () => setBlocked(true),
		reset: () => {
			generation.current += 1;
			setKeyText("");
			setChecking(false);
			clearResult();
		},
		runCheck: async () => {
			const keyValue = key.trim();
			const run = checkRef.current;
			if (!keyValue || !run) return;
			generation.current += 1;
			const mine = generation.current;
			setChecking(true);
			clearResult();
			try {
				const result = await run(keyValue);
				if (generation.current !== mine) return;
				setCandidates(result.candidates);
				setVersions({
					configurationRevision: result.configurationRevision,
					keyVersion: result.keyVersion,
				});
			} catch {
				if (generation.current === mine) setError(true);
			} finally {
				if (generation.current === mine) setChecking(false);
			}
		},
		setKey: (value: string) => {
			generation.current += 1;
			setKeyText(value);
			setChecking(false);
			clearResult();
		},
		setSelection: (value: KeylessModelSelection | null) => {
			setSelection(value);
			setBlocked(false);
		},
	};
}
