import { useEffect, useRef } from "react";

// A successful command can remove its trigger or the whole form.
export function useResultFocus<T extends HTMLElement = HTMLParagraphElement>(
	result: unknown,
) {
	const ref = useRef<T>(null);
	useEffect(() => {
		if (result) ref.current?.focus();
	}, [result]);
	return ref;
}
