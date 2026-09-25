import { useQuery } from "@tanstack/react-query";

import { loadDeploymentConfiguration } from "./deployment-configuration.js";

export function useDeploymentConfiguration() {
	return useQuery({
		queryKey: ["deployment-configuration"],
		queryFn: () => loadDeploymentConfiguration(),
	});
}
