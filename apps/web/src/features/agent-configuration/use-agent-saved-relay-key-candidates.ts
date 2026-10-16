import { useQuery } from "@tanstack/react-query";

import { loadAgentDefaultRelayKeySavedCandidates } from "./agent-configuration.js";

/**
 * Owner-only read of the saved default Relay Key's model projection. The query
 * is enabled only after the separate Key-state query confirms that a Key is set.
 * It deliberately has no mutation or credential state.
 */
export function useAgentSavedRelayKeyCandidates(
	agentId: string,
	enabled: boolean,
) {
	return useQuery({
		enabled,
		queryFn: () => loadAgentDefaultRelayKeySavedCandidates(agentId),
		queryKey: ["agents", agentId, "default-relay-key", "saved-candidates"],
		retry: false,
	});
}
