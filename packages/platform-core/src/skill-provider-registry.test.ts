import { describe, expect, it } from "vitest";
import {
	createSkillProviderRegistryV1,
	runSkillProviderBatchV1,
} from "./skill-provider-registry.js";

const bytes = new TextEncoder().encode("zip");
const candidate = (
	provider: "system" | "my_library" | "github",
	index: number,
) => ({
	provider,
	name: `skill-${index}`,
	version: "1.0.0",
	sourceVersion: `source-${index}`,
	sourceDigest: "a".repeat(64),
	approvalRef: provider === "github" ? "approval-1" : null,
	archiveBytes: bytes,
});

describe("controlled Skill Provider registry", () => {
	it("aggregates only configured adapters in Magic order", async () => {
		const registry = createSkillProviderRegistryV1({
			github: { discover: async () => [candidate("github", 1)] },
			system: { discover: async () => [candidate("system", 2)] },
			my_library: { discover: async () => [candidate("my_library", 3)] },
		});
		expect(registry.providers).toEqual(["system", "my_library", "github"]);
		expect((await registry.discover()).map((item) => item.provider)).toEqual([
			"system",
			"my_library",
			"github",
		]);
	});

	it("enforces ten items and three concurrent runners while preserving item order", async () => {
		const candidates = Array.from({ length: 10 }, (_, index) =>
			candidate("my_library", index),
		);
		let active = 0;
		let maximum = 0;
		const results = await runSkillProviderBatchV1(
			candidates,
			async (item, index) => {
				active += 1;
				maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, index % 2));
				active -= 1;
				return {
					index,
					provider: item.provider,
					status: "succeeded" as const,
					archiveDigest: "b".repeat(64),
					errorCode: null,
				};
			},
		);
		expect(maximum).toBeLessThanOrEqual(3);
		expect(results.map((result) => result.index)).toEqual(
			Array.from({ length: 10 }, (_, index) => index),
		);
	});

	it("contains a failed item without converting the batch to a false success", async () => {
		const results = await runSkillProviderBatchV1(
			[candidate("my_library", 1), candidate("my_library", 2)],
			async (item, index) => {
				if (index === 1)
					throw Object.assign(new Error(), { code: "scan_rejected" });
				return {
					index,
					provider: item.provider,
					status: "succeeded" as const,
					archiveDigest: "b".repeat(64),
					errorCode: null,
				};
			},
		);
		expect(results).toMatchObject([
			{ status: "succeeded" },
			{ status: "failed", errorCode: "scan_rejected" },
		]);
	});

	it("turns malformed runner evidence into an isolated failure", async () => {
		const results = await runSkillProviderBatchV1(
			[candidate("my_library", 1)],
			async (item, index) =>
				({
					index,
					provider: item.provider,
					status: "succeeded",
					archiveDigest: "not-a-digest",
					errorCode: "unexpected",
				}) as never,
		);
		expect(results[0]).toMatchObject({
			status: "failed",
			archiveDigest: null,
			errorCode: "unavailable",
		});
	});
});
