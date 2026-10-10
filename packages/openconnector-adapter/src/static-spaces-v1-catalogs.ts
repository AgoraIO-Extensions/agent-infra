import { connectionProviderCatalogs as current } from "./provider-catalogs.ts";
// The archived v1 test binding must not mistake the separately approved pilot for v1 verification.
export const connectionProviderCatalogs = current.filter(
	(catalog): boolean => catalog.provider !== "static-spaces",
);
