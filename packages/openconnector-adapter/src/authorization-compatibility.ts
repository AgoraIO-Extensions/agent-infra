import { bitbucketServerConnectionCatalog as catalog } from "./bitbucket-server.ts";
import { datalegoV5ConnectionCatalog as datalegoCatalog } from "./datalego-v5.ts";
import { datalegoV6ConnectionCatalog as datalegoV6Catalog } from "./datalego-v6.ts";

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

export const datalegoAuthorizationCompatibility = [
	{
		provider: "datalego",
		fromReleaseId: "datalego-connection-v4",
		toReleaseId: "datalego-connection-v5",
		fromExecutorDigest:
			"sha256:1586729da6ad1b0f26cc8a45d7d3fae4320ab50dd64fdf28df95219fbc0f1c3b",
		toExecutorDigest:
			"sha256:f8489f6315d4133969d20c080d8c455e8ae549d12ea9fe4f95123ba4cfe0c9f2",
		rationale:
			"v5 guards cancellation and preserves uncertain responses; the four action names, input schemas, effects, scopes, personal OAuth identity and fixed origins are unchanged.",
		reviewReference:
			"https://github.com/AgoraIO-Extensions/agent-infra/pull/1228",
	},
] as const;

export const datalegoV5ConnectionCatalog = {
	...datalegoCatalog,
	authorizationCompatibility: datalegoAuthorizationCompatibility,
} as const;

export const datalegoV6AuthorizationCompatibility = [
	{
		provider: "datalego",
		fromReleaseId: "datalego-connection-v5",
		toReleaseId: "datalego-connection-v6",
		fromExecutorDigest:
			"sha256:f8489f6315d4133969d20c080d8c455e8ae549d12ea9fe4f95123ba4cfe0c9f2",
		toExecutorDigest:
			"sha256:46bef6190afb945322091a3599764d3ffb63781bfda87dd54b3d2882d67cb857",
		rationale:
			"v6 delegates the original four Actions and OAuth lifecycle to immutable v5 with unchanged scopes, identity and endpoints. The two new fixed Hive metadata job Actions are excluded from inherited approval and require explicit authorization.",
		reviewReference:
			"https://github.com/AgoraIO-Extensions/agent-infra/issues/1557",
	},
] as const;

export const datalegoV6ConnectionCatalog = {
	...datalegoV6Catalog,
	authorizationCompatibility: datalegoV6AuthorizationCompatibility,
} as const;
