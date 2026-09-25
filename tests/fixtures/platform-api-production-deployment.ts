import {
	createProductionPlatformApiAssemblyInputV1,
	type ProductionPlatformApiInputV1,
} from "../../apps/platform-api/src/index.js";

let configured: ProductionPlatformApiInputV1 | undefined;
/** Controlled deployment inputs only; the loader still constructs the production assembly. */
export function setProductionDeploymentInput(
	input: ProductionPlatformApiInputV1,
) {
	configured = input;
}
export function createPlatformApiAssemblyInput() {
	if (!configured)
		throw new Error("Production deployment fixture is not configured");
	return createProductionPlatformApiAssemblyInputV1(configured);
}
