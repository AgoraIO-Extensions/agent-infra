export {
	githubConnectionCatalog as githubV10ConnectionCatalog,
	OpenConnectorGitHubAdapter as GitHubV10Adapter,
} from "./versions/github-v10.ts";
export {
	OpenConnectorGitHubAdapter,
	OpenConnectorGitHubOAuthAdapter,
} from "./versions/github-v11.ts";
export {
	githubConnectionCatalog as legacyGitHubConnectionCatalog,
	OpenConnectorGitHubAdapter as LegacyGitHubAdapter,
} from "./versions/index.ts";
