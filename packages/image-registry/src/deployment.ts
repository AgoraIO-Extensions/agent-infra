import { readFile } from "node:fs/promises";
import {
	createOciImageRegistryAdapterV1,
	type StandardTemplateRegistryV1,
} from "./oci-image-registry.ts";

export const standardTemplateRegistryCredentialsFileV1 =
	"/var/run/agent-infra/standard-template-registry/credentials.json";

/** Deployment configuration carries destinations only; Secret bytes are read on each token exchange. */
export function standardTemplateRegistryFromDeploymentV1(
	raw: string | undefined,
	credentialsFile = standardTemplateRegistryCredentialsFileV1,
): StandardTemplateRegistryV1 | undefined {
	if (raw === undefined) return undefined;
	try {
		if (raw.length > 8192) throw new Error();
		const value = JSON.parse(raw);
		if (
			!value ||
			Object.keys(value).sort().join() !==
				"authentication,endpoint,imageReferencePrefix,repositories" ||
			Object.keys(value.authentication ?? {})
				.sort()
				.join() !== "realm,service" ||
			!Array.isArray(value.repositories) ||
			new Set(value.repositories).size !== 4 ||
			value.repositories.length !== 4
		)
			throw new Error();
		const binding: StandardTemplateRegistryV1 = {
			...value,
			authentication: {
				...value.authentication,
				async loadCredentials(signal) {
					try {
						const bytes = await readFile(credentialsFile, { signal });
						if (bytes.length > 65536) return undefined;
						const identity = JSON.parse(bytes.toString("utf8"));
						if (
							!identity ||
							(typeof identity.username === "string" &&
								identity.username.includes(":")) ||
							Object.keys(identity).sort().join() !== "password,username" ||
							[identity.username, identity.password].some(
								(part) =>
									typeof part !== "string" || !part || /[\p{Cc}]/u.test(part),
							)
						)
							return undefined;
						return { username: identity.username, password: identity.password };
					} catch {
						return undefined;
					}
				},
			},
		};
		// Reuse the adapter's destination validation without issuing any requests.
		createOciImageRegistryAdapterV1({
			endpoint: "https://ghcr.io",
			imageReferencePrefix: "ghcr.io",
			standardTemplates: binding,
			policy: { authorize: async () => ({ status: "rejected" }) },
		});
		return binding;
	} catch {
		throw new Error("STANDARD_TEMPLATE_REGISTRY_CONFIGURATION_INVALID");
	}
}

export function bindStandardTemplateRegistryDeploymentV1<
	T extends {
		readonly endpoint: string;
		readonly imageReferencePrefix: string;
		readonly standardTemplates?: StandardTemplateRegistryV1;
	},
>(registry: T, raw: string | undefined): T {
	const standardTemplates = standardTemplateRegistryFromDeploymentV1(raw);
	if (!standardTemplates) return registry;
	if (registry.standardTemplates)
		throw new Error("STANDARD_TEMPLATE_REGISTRY_CONFIGURATION_CONFLICT");
	return { ...registry, standardTemplates };
}
