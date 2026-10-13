import { githubV11ConnectionCatalog as catalog } from "./versions/github-v11.ts";
import { githubV11ExecutorDigest } from "./versions/github-v11-integrity.ts";

// Exact release pins prevent later executors inheriting this repair evidence.
export const githubAuthorizationCompatibility = [
	{
		provider: "github",
		fromReleaseId:
			"github-openconnector-0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674-connection-v9",
		toReleaseId:
			"github-openconnector-0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674-connection-v11",
		fromExecutorDigest:
			"sha256:9deba65c280ec0328d94698154702401e69ce4bfdf60883403f321d2edee5cfa",
		toExecutorDigest: githubV11ExecutorDigest,
		rationale:
			"v9 to v11 combines the v10 HTTP-status repair with the v11 bounded Job log READ. All 143 existing authorization contracts and account identity are unchanged; newly added logs require separate explicit consent. GitHub retains its existing reauthorization requirement.",
		reviewReference:
			"https://github.com/AgoraIO-Extensions/agent-infra/issues/2274",
	},
	{
		provider: "github",
		fromReleaseId:
			"github-openconnector-0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674-connection-v10",
		toReleaseId:
			"github-openconnector-0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674-connection-v11",
		fromExecutorDigest:
			"sha256:4f7b8c138a271f489102a8b979e007277a05db59487441c6c4490d4452d9aabd",
		toExecutorDigest: githubV11ExecutorDigest,
		rationale:
			"v11 delegates all 143 existing actions to immutable v10 with unchanged schema/effect/scopes and OAuth identity. The added repo READ for Job logs requires separate explicit consent and is never added to old grants. GitHub retains its existing reauthorization requirement.",
		reviewReference:
			"https://github.com/AgoraIO-Extensions/agent-infra/issues/2274",
	},
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
