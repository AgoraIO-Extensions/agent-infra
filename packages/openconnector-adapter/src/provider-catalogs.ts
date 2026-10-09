import upgradePlans from "../provider-upgrade-plans.json" with { type: "json" };
import {
	bitbucketServerConnectionCatalog,
	datalegoV6ConnectionCatalog,
} from "./authorization-compatibility.ts";
import { confluenceServerConnectionCatalog } from "./confluence-server.ts";
import {
	githubConnectionCatalog,
	jenkinsCiConnectionCatalog,
	jenkinsReleaseConnectionCatalog,
} from "./index.ts";
import { jiraServerConnectionCatalog } from "./jira-server.ts";
import { manhattanConnectionCatalog } from "./manhattan.ts";
import { rehoboamConnectionCatalog } from "./rehoboam.ts";

import {
	staticSpacesConnectionCatalog,
	staticSpacesVerificationMatrix,
} from "./static-spaces.ts";

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
	...(staticSpacesVerificationMatrix.every(
		(action) => action.status === "LIVE_VERIFIED",
	)
		? [staticSpacesConnectionCatalog]
		: []),
] as const;

export const connectionProviderCatalogs = catalogs.map((catalog) => ({
	...catalog,
	credentialUpgradeBehavior:
		catalog.provider === "manhattan" || catalog.provider === "github"
			? ("REAUTHORIZE" as const)
			: ("DIRECT" as const),
	upgradePaths: upgradePlans.transitions,
}));
