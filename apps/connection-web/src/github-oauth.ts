import { useMutation } from "@tanstack/react-query";

import { connectionApi } from "./api";

export function useGithubOAuth() {
	const mutation = useMutation({
		mutationFn: (input: { sharedScopeId?: string; accessRequestId?: string }) =>
			connectionApi.startGithubOAuth(
				input.sharedScopeId,
				input.accessRequestId,
			),
	});
	const begin = (sharedScopeId?: string, accessRequestId?: string) => {
		mutation.mutate(
			{ sharedScopeId, accessRequestId },
			{
				onSuccess: ({ authorizationUrl }) =>
					window.location.assign(authorizationUrl),
			},
		);
	};
	return { ...mutation, begin };
}
