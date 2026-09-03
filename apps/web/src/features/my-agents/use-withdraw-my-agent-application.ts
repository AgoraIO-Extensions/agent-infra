import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";

import { withdrawMyAgentApplication } from "./my-agent-applications.js";

type WithdrawalAttempt = {
	readonly applicationId: string;
	readonly idempotencyKey: string;
};

export function useWithdrawMyAgentApplication(applicationId: string) {
	const queryClient = useQueryClient();
	const pendingWithdrawal = useRef<{
		applicationId: string;
		idempotencyKey?: string;
	}>({ applicationId });
	const startAttempt = (): WithdrawalAttempt => {
		if (pendingWithdrawal.current.applicationId !== applicationId) {
			pendingWithdrawal.current = { applicationId };
		}
		const idempotencyKey =
			pendingWithdrawal.current.idempotencyKey ?? crypto.randomUUID();
		pendingWithdrawal.current.idempotencyKey = idempotencyKey;
		return { applicationId, idempotencyKey };
	};
	const clearAttempt = (attempt: WithdrawalAttempt) => {
		if (
			pendingWithdrawal.current.applicationId === attempt.applicationId &&
			pendingWithdrawal.current.idempotencyKey === attempt.idempotencyKey
		) {
			pendingWithdrawal.current.idempotencyKey = undefined;
		}
	};

	const withdrawal = useMutation({
		mutationKey: ["my-agents", "withdraw", applicationId],
		mutationFn: (attempt: WithdrawalAttempt) =>
			withdrawMyAgentApplication(attempt.applicationId, attempt.idempotencyKey),
		onSuccess: (_result, attempt) => {
			clearAttempt(attempt);
			return queryClient.invalidateQueries({ queryKey: ["my-agents"] });
		},
		onError: (_error, attempt) => {
			clearAttempt(attempt);
		},
	});

	useLayoutEffect(() => {
		if (pendingWithdrawal.current.applicationId === applicationId) return;
		pendingWithdrawal.current = { applicationId };
		withdrawal.reset();
	}, [applicationId, withdrawal.reset]);

	return {
		...withdrawal,
		mutate: () => withdrawal.mutate(startAttempt()),
		mutateAsync: () => withdrawal.mutateAsync(startAttempt()),
	};
}
