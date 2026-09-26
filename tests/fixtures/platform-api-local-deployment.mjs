import { FakeAgentConfigurationAdmissionsV1 } from "../../packages/platform-core/dist/testing.mjs";
import { platformDatabaseUrlFromEnvironment } from "../../packages/platform-store/dist/index.mjs";

const localAdmin = {
	schemaVersion: 1,
	userId: "local-topology-admin",
	displayName: "Local Topology Admin",
	accountStatus: "active",
	organizationIds: ["local-topology-org"],
	roles: ["employee", "system_admin"],
	authorizationRevision: "local-topology-authorization",
};

const unavailable = async () => {
	throw new Error("Local topology dependency is not configured");
};

const admissions = new FakeAgentConfigurationAdmissionsV1({
	authorizations: [],
	images: [],
	models: [],
	modelCredentials: [],
});

const identity = {
	async resolve() {
		return structuredClone(localAdmin);
	},
	async hydrateUsers(userIds) {
		return userIds.map((userId) => {
			if (userId !== localAdmin.userId) {
				throw new Error("Unknown local topology user");
			}
			return {
				userId: localAdmin.userId,
				displayName: localAdmin.displayName,
				roles: [...localAdmin.roles],
			};
		});
	},
};

export function createPlatformApiAssemblyInput() {
	return {
		databaseUrl: platformDatabaseUrlFromEnvironment(),
		identity,
		admissions: {
			authorizationAdmission: admissions,
			imageAdmission: admissions,
			modelAdmission: admissions,
			secretAdmission: admissions,
			actionAdmission: admissions,
			channelAdmission: admissions,
		},
		deploymentConfiguration: {
			identity,
			read: async () => ({
				schemaVersion: 2,
				status: "empty",
				templates: [],
				modelCatalog: { status: "empty", revision: null, endpoints: [] },
			}),
		},
		allocateApplicationIds: unavailable,
		prepareApplicationSecrets: unavailable,
		prepareConfigurationSecrets: unavailable,
		presentAgent: unavailable,
	};
}
