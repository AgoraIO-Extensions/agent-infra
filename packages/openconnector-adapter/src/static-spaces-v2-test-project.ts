import { connectionProviderCatalogs as current } from "./provider-catalogs.ts";
import { staticSpacesConnectionCatalog as archived } from "./providers/static-spaces/versions/static-spaces-v2.ts";

export const connectionProviderCatalogs = current.map((catalog) =>
	catalog.provider === "static-spaces" ? { ...catalog, ...archived } : catalog,
);
