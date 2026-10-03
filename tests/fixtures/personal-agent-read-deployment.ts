import type { PlatformApiAssemblyInput } from "../../apps/platform-api/src/assembly.js";
import { createPlatformApiAssemblyInput as createCredentialInput } from "./personal-credential-deployment.ts";

export { state } from "./personal-credential-deployment.ts";

let currentInput: PlatformApiAssemblyInput | undefined;

export function createPlatformApiAssemblyInput(): PlatformApiAssemblyInput {
	currentInput = createCredentialInput();
	return currentInput;
}

/** Remove the controlled dependency after issuing through the production app. */
export function removeDirectoryDependency(): void {
	if (!currentInput) throw new Error("Test deployment is not running");
	delete currentInput.identity.resolveUser;
}
