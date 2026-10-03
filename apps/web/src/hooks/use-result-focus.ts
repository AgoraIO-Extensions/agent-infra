import { useEffect, useRef } from "react";

// A successful command can remove its trigger or the whole form.
export function useResultFocus(result: unknown) {
	const ref = useRef<HTMLParagraphElement>(null);
	useEffect(() => {
		if (result) ref.current?.focus();
	}, [result]);
	return ref;
}
