import { useMutation, useQueryClient } from "@tanstack/react-query";

import { withdrawMyAgentApplication } from "./my-agent-applications.js";

export function useWithdrawMyAgentApplication(applicationId: string) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: () =>
			withdrawMyAgentApplication(applicationId, crypto.randomUUID()),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["my-agents"] }),
	});
}
