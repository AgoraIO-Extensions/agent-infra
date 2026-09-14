import { useMutation } from "@tanstack/react-query";

import { connectionApi } from "./api";

export function useGithubOAuth() {
	const mutation = useMutation({ mutationFn: connectionApi.startGithubOAuth });
	const begin = (sharedScopeId?: string) => {
		mutation.mutate(sharedScopeId, {
			onSuccess: ({ authorizationUrl }) =>
				window.location.assign(authorizationUrl),
		});
	};
	return { ...mutation, begin };
}
