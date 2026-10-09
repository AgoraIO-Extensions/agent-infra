// Compatibility entry point for reviewed provider-owned upgrade evidence.
export {
	bitbucketAuthorizationCompatibility,
	bitbucketServerConnectionCatalog,
} from "./providers/bitbucket/compatibility.ts";
export {
	datalegoAuthorizationCompatibility,
	datalegoV5ConnectionCatalog,
	datalegoV6AuthorizationCompatibility,
	datalegoV6ConnectionCatalog,
} from "./providers/datalego/compatibility.ts";
