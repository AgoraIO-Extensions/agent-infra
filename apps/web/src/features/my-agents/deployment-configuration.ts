import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import { getDeploymentConfigurationV2 } from "../../pilot/generated-v2/sdk.gen.js";
import type {
	DeploymentConfigurationProjectionV2,
	GetDeploymentConfigurationV2Errors,
	GetDeploymentConfigurationV2Responses,
} from "../../pilot/generated-v2/types.gen.js";

export type DeploymentConfigurationState =
	| {
			kind: "ready";
			configuration: DeploymentConfigurationProjectionV2;
	  }
	| {
			kind: "unavailable";
			retryable: boolean;
	  };

function unavailable(error: { retryable?: boolean } | undefined) {
	return {
		kind: "unavailable" as const,
		retryable: error?.retryable !== false,
	};
}

export const unavailableDeploymentConfiguration: DeploymentConfigurationProjectionV2 =
	{
		modelCatalog: {
			endpoints: [],
			revision: null,
			status: "unavailable",
		},
		schemaVersion: 2,
		status: "unavailable",
		templates: [],
	};

export async function loadDeploymentConfiguration(
	client?: Client,
): Promise<DeploymentConfigurationState> {
	const result: Awaited<
		RequestResult<
			GetDeploymentConfigurationV2Responses,
			GetDeploymentConfigurationV2Errors,
			false
		>
	> = await getDeploymentConfigurationV2({
		client,
		responseStyle: "fields",
		throwOnError: false,
	});
	if (!result.data) return unavailable(result.error);
	return { kind: "ready", configuration: result.data };
}
