import { capabilityVerificationMatrix } from "../../test-project.ts";
import { staticSpacesConnectionCatalog } from "./versions/static-spaces-v7.ts";

export { staticSpacesOrigins } from "./versions/static-spaces.ts";
export { staticSpacesConnectionCatalog as staticSpacesV2ConnectionCatalog } from "./versions/static-spaces-v2.ts";
export {
	staticSpacesConnectionCatalog as staticSpacesV3ConnectionCatalog,
	staticSpacesPilot,
} from "./versions/static-spaces-v3.ts";
export { staticSpacesConnectionCatalog as staticSpacesV4ConnectionCatalog } from "./versions/static-spaces-v4.ts";
export {
	staticSpacesConnectionCatalog as staticSpacesV5ConnectionCatalog,
	staticSpacesRestrictedApproval,
} from "./versions/static-spaces-v5.ts";
export {
	staticSpacesConnectionCatalog,
	staticSpacesConnectionCatalog as providerDefinition,
	staticSpacesStandardApproval,
} from "./versions/static-spaces-v7.ts";

// Accepted operating risk does not constitute real-provider verification.
export const staticSpacesVerificationMatrix = capabilityVerificationMatrix(
	staticSpacesConnectionCatalog,
	[],
);

export { staticSpacesConnectionCatalog as staticSpacesV6ConnectionCatalog } from "./versions/static-spaces-v6.ts";
