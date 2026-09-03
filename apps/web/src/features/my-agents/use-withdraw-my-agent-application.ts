import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { withdrawMyAgentApplication } from "./my-agent-applications.js";

export function useWithdrawMyAgentApplication(applicationId: string) {
	const queryClient = useQueryClient();
	const pendingWithdrawal = useRef<{
		applicationId: string;
		idempotencyKey?: string;
	}>({ applicationId });

	return useMutation({
		mutationFn: () => {
			if (pendingWithdrawal.current.applicationId !== applicationId) {
				pendingWithdrawal.current = { applicationId };
			}
			pendingWithdrawal.current.idempotencyKey ??= crypto.randomUUID();
			return withdrawMyAgentApplication(
				applicationId,
				pendingWithdrawal.current.idempotencyKey,
			);
		},
		onSuccess: () => {
			pendingWithdrawal.current.idempotencyKey = undefined;
			return queryClient.invalidateQueries({ queryKey: ["my-agents"] });
		},
		onError: () => {
			if (pendingWithdrawal.current.applicationId === applicationId) {
				pendingWithdrawal.current.idempotencyKey = undefined;
			}
		},
	});
}
