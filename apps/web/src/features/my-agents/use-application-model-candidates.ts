import { useEffect, useRef, useState } from "react";
import { getAgentApplicationModelCandidatesV2 } from "../../pilot/generated-v2/sdk.gen.js";
import type {
	KeylessModelCandidate,
	KeylessModelSelection,
} from "../agent-configuration/keyless-model-selection.js";

/** Preview is bound to the entered Key and selected template; submit independently revalidates. */
export function useApplicationModelCandidates(
	templateId: string,
	scope: string,
	check: typeof loadApplicationModelCandidates = loadApplicationModelCandidates,
) {
	const [key, setKeyText] = useState("");
	const [result, setResult] = useState<{
		scope: string;
		candidates: readonly KeylessModelCandidate[];
	} | null>(null);
	const [selection, setSelection] = useState<KeylessModelSelection | null>(
		null,
	);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState(false);
	const generation = useRef(0);
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const clear = () => {
		setResult(null);
		setSelection(null);
		setError(false);
		setChecking(false);
	};
	useEffect(() => {
		generation.current += 1;
		setResult(null);
		setSelection(null);
		setError(false);
		setChecking(false);
		currentScope.current = scope;
	}, [scope]);
	const checked = result?.scope === scope;
	return {
		key,
		typed: key.trim().length > 0,
		checking,
		error,
		checked,
		noCandidates: checked && result.candidates.length === 0,
		candidates: checked ? result.candidates : [],
		selection: checked ? selection : null,
		setSelection,
		setKey(value: string) {
			generation.current += 1;
			setKeyText(value);
			clear();
		},
		async runCheck() {
			if (!templateId || !key.trim()) return;
			const mine = ++generation.current;
			const requestScope = scope;
			clear();
			setChecking(true);
			try {
				const candidates = await check(templateId, key.trim());
				if (
					mine !== generation.current ||
					currentScope.current !== requestScope
				)
					return;
				setResult({
					scope: requestScope,
					candidates,
				});
			} catch {
				if (
					mine === generation.current &&
					currentScope.current === requestScope
				)
					setError(true);
			} finally {
				if (
					mine === generation.current &&
					currentScope.current === requestScope
				)
					setChecking(false);
			}
		},
	};
}

export async function loadApplicationModelCandidates(
	templateId: string,
	defaultRelayKey: string,
) {
	const result = await getAgentApplicationModelCandidatesV2({
		body: { templateId, defaultRelayKey },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) throw new Error("APPLICATION_MODEL_CANDIDATES_UNAVAILABLE");
	return result.data.candidates;
}
