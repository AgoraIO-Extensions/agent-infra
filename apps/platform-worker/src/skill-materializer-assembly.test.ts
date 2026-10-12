import { expect, it } from "vitest";
import { resolveDeploymentSkillMaterializerV1 } from "./skill-materializer-assembly.js";

const materializer = {
	materialize: async () => ({ generationId: "a", skills: [] }),
};

it("returns the configured materializer when no deployment factory is present", async () => {
	await expect(
		resolveDeploymentSkillMaterializerV1({
			databaseUrl: "postgresql://db/platform",
			signal: new AbortController().signal,
			configured: materializer,
		}),
	).resolves.toBe(materializer);
});

it("uses the deployment factory with the validated database and signal", async () => {
	const signal = new AbortController().signal;
	const result = await resolveDeploymentSkillMaterializerV1({
		databaseUrl: "postgresql://db/platform",
		signal,
		factory: async (input) => {
			expect(input.databaseUrl).toBe("postgresql://db/platform");
			expect(input.signal).toBe(signal);
			return materializer;
		},
	});
	expect(result).toBe(materializer);
});

it("fails closed for malformed factory or materializer output", async () => {
	await expect(
		resolveDeploymentSkillMaterializerV1({
			databaseUrl: "postgresql://db/platform",
			signal: new AbortController().signal,
			factory: {} as never,
		}),
	).rejects.toThrow("SKILL_MATERIALIZER_CONFIGURATION_INVALID");
	await expect(
		resolveDeploymentSkillMaterializerV1({
			databaseUrl: "postgresql://db/platform",
			signal: new AbortController().signal,
			factory: async () => ({}) as never,
		}),
	).rejects.toThrow("SKILL_MATERIALIZER_CONFIGURATION_INVALID");
});
