import { expect, it } from "vitest";
import { observeNativeAdmissionV1 } from "./native-admission-observation.js";

it("observes a stage once without copying business inputs or results", async () => {
	const events: unknown[] = [];
	const result = { private: "PRIVATE_CANARY" };
	expect(
		await observeNativeAdmissionV1(
			(e) => events.push(e),
			"metadata.first",
			async () => result,
		),
	).toBe(result);
	expect(events).toEqual([
		{
			stage: "metadata.first",
			phase: "started",
			elapsedMs: expect.any(Number),
			observationId: expect.any(Number),
		},
		{
			stage: "metadata.first",
			phase: "completed",
			elapsedMs: expect.any(Number),
			observationId: expect.any(Number),
		},
	]);
	expect(JSON.stringify(events)).not.toContain("PRIVATE_CANARY");
});

it("preserves the same exception and operation when telemetry throws", async () => {
	const error = new Error("PRIVATE_CANARY");
	let attempts = 0;
	await expect(
		observeNativeAdmissionV1(
			() => {
				throw new Error("sink");
			},
			"store.lock",
			async () => {
				attempts++;
				throw error;
			},
		),
	).rejects.toBe(error);
	expect(attempts).toBe(1);
});
