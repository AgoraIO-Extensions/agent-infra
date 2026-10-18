import type { PlatformApiAssemblyInput } from "../../apps/platform-api/src/assembly.js";
import { createDeploymentIdentityScope } from "../../apps/platform-api/src/deployment-identity.js";
import { createDeploymentPresentation } from "../../apps/platform-api/src/deployment-presentation.js";
import { createPlatformApiAssemblyInput as createCredentialInput } from "./personal-credential-deployment.ts";

export { state } from "./personal-credential-deployment.ts";

let currentInput: PlatformApiAssemblyInput | undefined;

export function createPlatformApiAssemblyInput(): PlatformApiAssemblyInput {
	const input = createCredentialInput();
	const identityScope = createDeploymentIdentityScope(input.identity);
	currentInput = {
		...input,
		requestScope: identityScope.requestScope,
		presentAgent: {
			create: ({ configurationQuery }) =>
				createDeploymentPresentation({
					identityScope,
					configurationQuery,
					resourceProfile: {
						profileId: "controlled-standard",
						displayName: "Controlled standard",
						estimatedResources: {
							cpuMillicores: 1000,
							memoryMiB: 1024,
							storageGiB: 1,
						},
					},
					imageRepository: "registry.example.test/agents",
				}),
		},
	};
	return currentInput;
}

/** Remove the controlled dependency after issuing through the production app. */
export function removeDirectoryDependency(): void {
	if (!currentInput) throw new Error("Test deployment is not running");
	delete currentInput.identity.resolveUser;
}
