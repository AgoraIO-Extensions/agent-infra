import { describe, expect, it } from "vitest";

import {
	type DeploymentConfigurationState,
	projectDeploymentConfiguration,
} from "./deployment-configuration.js";
import { deploymentConfiguration } from "./test-fixtures.js";

describe("projectDeploymentConfiguration", () => {
	it("drops cached ready data when the current read fails", () => {
		const state: DeploymentConfigurationState = {
			kind: "ready",
			configuration: deploymentConfiguration,
		};
		const result = projectDeploymentConfiguration(
			state,
			Object.assign(new Error("temporarily unavailable"), { retryable: true }),
			true,
		);

		expect(result.configuration.status).toBe("unavailable");
		expect(result.configuration.modelCatalog.endpoints).toEqual([]);
		expect(result.retryable).toBe(true);
	});

	it("keeps successful projections and their retry classification", () => {
		const state: DeploymentConfigurationState = {
			kind: "ready",
			configuration: deploymentConfiguration,
		};

		expect(projectDeploymentConfiguration(state, undefined, false)).toEqual({
			configuration: deploymentConfiguration,
			retryable: true,
		});
	});
});
