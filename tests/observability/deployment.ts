import type { PlatformApiAssemblyInput } from "../../apps/platform-api/src/assembly.js";

let databaseUrl: string;
export function configureDatabase(url: string) {
	databaseUrl = url;
}
export function createPlatformApiAssemblyInput(): PlatformApiAssemblyInput {
	if (!databaseUrl) throw new Error("Controlled database is required");
	const unavailable = async (): Promise<never> => {
		throw new Error("Unused controlled admission");
	};
	return {
		// Controlled fixture policy; not a production default.
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
		databaseUrl,
		identity: {
			resolve: async () => ({
				schemaVersion: 1,
				userId: "collector-user",
				displayName: "Collector User",
				accountStatus: "active",
				organizationIds: ["collector-org"],
				roles: ["employee"],
				authorizationRevision: "collector-revision",
			}),
			hydrateUsers: async () => [],
		},
		admissions: {
			authorizationAdmission: { authorize: unavailable },
			imageAdmission: { admitImage: unavailable },
			modelAdmission: { admitModels: unavailable },
			secretAdmission: { admitSecrets: unavailable },
			channelAdmission: { admitChannels: unavailable },
		},
		allocateApplicationIds: unavailable,
		prepareApplicationSecrets: unavailable,
		prepareConfigurationSecrets: unavailable,
		presentAgent: unavailable,
	};
}
