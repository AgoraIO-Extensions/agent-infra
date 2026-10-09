import {
	jenkinsCiConnectionCatalog,
	jenkinsReleaseConnectionCatalog,
} from "./definition.ts";

export const actions = {
	ci: jenkinsCiConnectionCatalog.actions,
	release: jenkinsReleaseConnectionCatalog.actions,
} as const;
