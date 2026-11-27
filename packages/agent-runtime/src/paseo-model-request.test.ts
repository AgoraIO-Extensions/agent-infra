import { describe, expect, it, vi } from "vitest";
import { createPaseoModelAuthorizer } from "./paseo-model-request.js";

describe("createPaseoModelAuthorizer", () => {
	it("uses the initial grant once and ordinary grants afterward", async () => {
		const initial = vi.fn(async () => ({
			relayKey: "first",
			revalidate: vi.fn(),
		}));
		const ordinary = vi.fn(async () => ({
			relayKey: "next",
			revalidate: vi.fn(),
		}));
		const authorize = createPaseoModelAuthorizer(initial, ordinary);
		const action = {
			kind: "model",
			executionId: "e",
			runtimeOperationId: "e",
		} as never;
		await expect(authorize(action)).resolves.toMatchObject({
			relayKey: "first",
		});
		await expect(authorize(action)).resolves.toMatchObject({
			relayKey: "next",
		});
		expect(initial).toHaveBeenCalledOnce();
		expect(ordinary).toHaveBeenCalledOnce();
	});

	it("retries initial authorization after a failed attempt", async () => {
		const initial = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({ relayKey: "first", revalidate: vi.fn() });
		const ordinary = vi.fn();
		const authorize = createPaseoModelAuthorizer(initial, ordinary);
		const action = {
			kind: "model",
			executionId: "e",
			runtimeOperationId: "e",
		} as never;
		await expect(authorize(action)).resolves.toBeUndefined();
		await expect(authorize(action)).resolves.toMatchObject({
			relayKey: "first",
		});
		expect(initial).toHaveBeenCalledTimes(2);
		expect(ordinary).not.toHaveBeenCalled();
	});
});
