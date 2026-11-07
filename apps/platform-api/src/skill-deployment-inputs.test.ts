import { expect, it } from "vitest";
import { resolveDeploymentSkillAgentVersionV1 } from "./deployment.js";
import { readCurrentSkillAdmissionPolicyV1 } from "./skill-hub-read-assembly.js";

it("uses the fixed injected Skill version, preserves legacy input and rejects conflicts", () => {
	expect(resolveDeploymentSkillAgentVersionV1(undefined, "hub-v1")).toBe(
		"hub-v1",
	);
	expect(resolveDeploymentSkillAgentVersionV1("hub-v1", undefined)).toBe(
		"hub-v1",
	);
	expect(resolveDeploymentSkillAgentVersionV1("hub-v1", "hub-v1")).toBe(
		"hub-v1",
	);
	expect(resolveDeploymentSkillAgentVersionV1(undefined, "")).toBeUndefined();
	expect(() => resolveDeploymentSkillAgentVersionV1("v1", "v2")).toThrow(
		"PLATFORM_AGENT_VERSION_CONFIGURATION_CONFLICT",
	);
	expect(() =>
		resolveDeploymentSkillAgentVersionV1(undefined, "../version"),
	).toThrow("PLATFORM_DEPLOYMENT_CONFIGURATION_INVALID");
});

it("maps unavailable scanner or trust policy input to bounded dependency unavailability", async () => {
	for (const resolve of [
		undefined,
		async () => {
			throw new Error("private scanner path and credential sentinel");
		},
		async () => null as never,
	]) {
		const provider = resolve ? { resolveAdmissionPolicy: resolve } : undefined;
		await expect(
			readCurrentSkillAdmissionPolicyV1(provider),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			readCurrentSkillAdmissionPolicyV1(provider),
		).rejects.not.toThrow("private scanner");
	}
});

it("retains the deployment policy receiver and rechecks current policy on each call", async () => {
	const provider = {
		calls: 0,
		async resolveAdmissionPolicy() {
			this.calls += 1;
			return { policyRevision: `policy-${this.calls}` } as never;
		},
	};
	expect(await readCurrentSkillAdmissionPolicyV1(provider)).toMatchObject({
		policyRevision: "policy-1",
	});
	expect(await readCurrentSkillAdmissionPolicyV1(provider)).toMatchObject({
		policyRevision: "policy-2",
	});
});
