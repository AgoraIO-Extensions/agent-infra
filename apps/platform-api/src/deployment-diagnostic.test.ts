import { describe, expect, it } from "vitest";
import {
	deploymentDiagnosticV1,
	platformApiStartupFailureMessageV1,
	withDeploymentDiagnosticV1,
} from "./deployment-diagnostic.js";

const key = Symbol.for("agent-infra.platform-api.deployment-diagnostic.v1");

describe("deployment startup diagnostics (#2382)", () => {
	it("names the reason and template without other configuration", () => {
		const error = withDeploymentDiagnosticV1(new Error("private sentinel"), {
			reason: "codex_model_profiles_missing",
			templateId: "codex",
		});
		const message = platformApiStartupFailureMessageV1(error);
		expect(message).toBe(
			"Platform API failed to start: codex_model_profiles_missing (template codex); see deploy/platform-api/README.md",
		);
		expect(message).not.toContain("private sentinel");
	});

	it("keeps the generic message without a valid diagnostic", () => {
		expect(platformApiStartupFailureMessageV1(new Error("private"))).toBe(
			"Platform API failed to start",
		);
		expect(platformApiStartupFailureMessageV1("private")).toBe(
			"Platform API failed to start",
		);
		expect(
			platformApiStartupFailureMessageV1(
				new Error("PLATFORM_API_DEPLOYMENT_MODULE is required"),
			),
		).toBe("PLATFORM_API_DEPLOYMENT_MODULE is required");
	});

	it("rejects forged reasons and drops template IDs outside the safe format", () => {
		const forged = Object.defineProperty(new Error(), key, {
			value: { reason: "sk-private-value", templateId: "codex" },
		});
		expect(deploymentDiagnosticV1(forged)).toBeUndefined();
		expect(platformApiStartupFailureMessageV1(forged)).toBe(
			"Platform API failed to start",
		);
		for (const templateId of ["", "has space", "x".repeat(65), "a/b"]) {
			const error = withDeploymentDiagnosticV1(new Error(), {
				reason: "codex_model_profiles_invalid",
				templateId,
			});
			expect(deploymentDiagnosticV1(error)).toEqual({
				reason: "codex_model_profiles_invalid",
			});
			expect(platformApiStartupFailureMessageV1(error)).toBe(
				"Platform API failed to start: codex_model_profiles_invalid; see deploy/platform-api/README.md",
			);
		}
	});
});
