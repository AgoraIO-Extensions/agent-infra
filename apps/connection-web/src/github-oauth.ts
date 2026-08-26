import { useMutation } from "@tanstack/react-query";

import { connectionApi } from "./api";

export function useGithubOAuth() {
	const mutation = useMutation({ mutationFn: connectionApi.startGithubOAuth });
	const begin = (sharedScopeId?: string) => {
		const popup = window.open(
			"about:blank",
			sharedScopeId
				? `connection-github-${sharedScopeId}`
				: "connection-github-oauth",
		);
		if (popup) popup.opener = null;
		mutation.mutate(sharedScopeId, {
			onError: () => popup?.close(),
			onSuccess: ({ authorizationUrl }) => {
				if (popup) popup.location.replace(authorizationUrl);
				else window.location.assign(authorizationUrl);
			},
		});
	};
	return { ...mutation, begin };
}
