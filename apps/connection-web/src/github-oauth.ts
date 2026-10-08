import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";

import { connectionApi } from "./api";

export function useGithubOAuth() {
	const mutation = useMutation({
		mutationFn: (input: { sharedScopeId?: string; accessRequestId?: string }) =>
			connectionApi.startGithubOAuth(
				input.sharedScopeId,
				input.accessRequestId,
			),
	});
	const begin = useCallback(
		(sharedScopeId?: string, accessRequestId?: string) => {
			mutation.mutate(
				{ sharedScopeId, accessRequestId },
				{
					onSuccess: ({ authorizationUrl }) =>
						window.location.assign(authorizationUrl),
				},
			);
		},
		[mutation.mutate],
	);
	return { ...mutation, begin };
}
