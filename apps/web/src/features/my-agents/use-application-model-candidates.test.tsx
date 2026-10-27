import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useApplicationModelCandidates } from "./use-application-model-candidates.js";

afterEach(cleanup);
const candidates = [
	{
		endpointId: "relay",
		modelId: "model",
		reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
	},
];
it("ignores a late Key response after a template change", async () => {
	let complete: (value: typeof candidates) => void = () => {};
	const check = vi.fn(
		() =>
			new Promise<typeof candidates>((resolve) => {
				complete = resolve;
			}),
	);
	const { result, rerender } = renderHook(
		({ template }) => useApplicationModelCandidates(template, template, check),
		{ initialProps: { template: "codex" } },
	);
	act(() => result.current.setKey("synthetic-model-key"));
	let pending: Promise<void> | undefined;
	act(() => {
		pending = result.current.runCheck();
	});
	rerender({ template: "pi" });
	await act(async () => {
		complete(candidates);
		await pending;
	});
	expect(result.current.candidates).toEqual([]);
	expect(result.current.selection).toBeNull();
});
it("clears a checked selection when a new key or template is chosen", async () => {
	const check = vi.fn().mockResolvedValue(candidates);
	const { result, rerender } = renderHook(
		({ template }) => useApplicationModelCandidates(template, template, check),
		{ initialProps: { template: "codex" } },
	);
	act(() => result.current.setKey("synthetic-model-key"));
	await act(() => result.current.runCheck());
	await waitFor(() => expect(result.current.checked).toBe(true));
	act(() =>
		result.current.setSelection({
			options: [{ ...candidates[0], optionId: "relay:model" }],
			defaultOptionId: "relay:model",
			defaultReasoningLevel: "low",
		}),
	);
	expect(result.current.selection).not.toBeNull();
	rerender({ template: "pi" });
	expect(result.current.selection).toBeNull();
	expect(result.current.candidates).toEqual([]);
	act(() => result.current.setKey("changed-model-key"));
	expect(result.current.checked).toBe(false);
});
