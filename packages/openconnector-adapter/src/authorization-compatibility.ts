import { bitbucketServerConnectionCatalog as catalog } from "./bitbucket-server.ts";

// Reviewed release evidence is separate from immutable hashed executors.
// Exact literals intentionally prevent a later release inheriting this proof.
export const bitbucketAuthorizationCompatibility = [
	{
		provider: "bitbucket",
		fromReleaseId:
			"bitbucket-server-6.7.2-openconnector-0618e8cdaeaaaa77e2eb23938ac639867d4f03d7-connection-v7",
		toReleaseId:
			"bitbucket-server-6.7.2-openconnector-0618e8cdaeaaaa77e2eb23938ac639867d4f03d7-connection-v8",
		fromExecutorDigest:
			"sha256:2635e70bdf751caa10b6b397b5dd74b301de5813a5ffa6b3baececf61af69fb6",
		toExecutorDigest:
			"sha256:36e421531152628f993691b6e61e4966dc84af4ad4fced71ab4b84f44b025b67",
		rationale:
			"v8 only fixes fixed JSON/XSRF headers for bodyless POST and empty Decline responses; action authorization, endpoints, credential scopes and account identity are unchanged.",
		reviewReference:
			"https://github.com/AgoraIO-Extensions/agent-infra/pull/993",
	},
] as const;

export const bitbucketServerConnectionCatalog = {
	...catalog,
	authorizationCompatibility: bitbucketAuthorizationCompatibility,
} as const;
