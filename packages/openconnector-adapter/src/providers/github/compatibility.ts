import { githubConnectionCatalog as catalog } from "./versions/github-v10.ts";

// Exact release pins prevent later executors inheriting this repair evidence.
export const githubAuthorizationCompatibility = [
	{
		provider: "github",
		fromReleaseId:
			"github-openconnector-0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674-connection-v9",
		toReleaseId:
			"github-openconnector-0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674-connection-v10",
		fromExecutorDigest:
			"sha256:9deba65c280ec0328d94698154702401e69ce4bfdf60883403f321d2edee5cfa",
		toExecutorDigest:
			"sha256:4f7b8c138a271f489102a8b979e007277a05db59487441c6c4490d4452d9aabd",
		rationale:
			"v10 preserves original GitHub HTTP rejection statuses only; all 143 action names, schemas, effects, scopes, OAuth identity and endpoints remain unchanged. GitHub retains its existing reauthorization requirement.",
		reviewReference:
			"https://github.com/AgoraIO-Extensions/agent-infra/issues/2187",
	},
] as const;

export const githubConnectionCatalog = {
	...catalog,
	authorizationCompatibility: githubAuthorizationCompatibility,
} as const;
