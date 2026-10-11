import { connectionProviderCatalogs as current } from "./provider-catalogs.ts";
import { staticSpacesV3ConnectionCatalog } from "./providers/static-spaces/index.ts";
export const connectionProviderCatalogs = current.map((catalog) =>
	catalog.provider === "static-spaces"
		? staticSpacesV3ConnectionCatalog
		: catalog,
);
