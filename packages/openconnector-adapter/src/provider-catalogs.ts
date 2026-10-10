import upgradePlans from "../provider-upgrade-plans.json" with { type: "json" };
import { bitbucketServerConnectionCatalog } from "./providers/bitbucket/definition.ts";
import { confluenceServerConnectionCatalog } from "./providers/confluence/definition.ts";
import { datalegoV6ConnectionCatalog } from "./providers/datalego/definition.ts";
import { githubConnectionCatalog } from "./providers/github/definition.ts";
import {
	jenkinsCiConnectionCatalog,
	jenkinsReleaseConnectionCatalog,
} from "./providers/jenkins/definition.ts";
import { jiraServerConnectionCatalog } from "./providers/jira/definition.ts";
import { manhattanConnectionCatalog } from "./providers/manhattan/definition.ts";
import { rehoboamV11ConnectionCatalog as rehoboamConnectionCatalog } from "./providers/rehoboam/definition.ts";

import { staticSpacesConnectionCatalog } from "./providers/static-spaces/definition.ts";

const catalogs = [
	githubConnectionCatalog,
	bitbucketServerConnectionCatalog,
	jiraServerConnectionCatalog,
	confluenceServerConnectionCatalog,
	datalegoV6ConnectionCatalog,
	jenkinsCiConnectionCatalog,
	jenkinsReleaseConnectionCatalog,
	manhattanConnectionCatalog,
	rehoboamConnectionCatalog,
	staticSpacesConnectionCatalog,
] as const;

export const connectionProviderCatalogs = catalogs.map((catalog) => ({
	...catalog,
	credentialUpgradeBehavior:
		catalog.provider === "manhattan" || catalog.provider === "github"
			? ("REAUTHORIZE" as const)
			: ("DIRECT" as const),
	upgradePaths: upgradePlans.transitions,
}));
