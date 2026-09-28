const unavailable = async () => {
	throw new Error("unused smoke dependency");
};

export function createPlatformApiAssemblyInput() {
	return {
		databaseUrl: "postgres://smoke:smoke@127.0.0.1:1/smoke",
		identity: {
			async resolve() {
				return {
					schemaVersion: 1,
					userId: "smoke-user",
					displayName: "Smoke User",
					accountStatus: "active",
					organizationIds: ["smoke-org"],
					roles: ["employee"],
					authorizationRevision: "smoke-authorization",
				};
			},
			async hydrateUsers() {
				return [];
			},
		},
		admissions: {
			authorizationAdmission: { authorize: unavailable },
			imageAdmission: { admitImage: unavailable },
			modelAdmission: { admitModels: unavailable },
			secretAdmission: { admitSecrets: unavailable },
			actionAdmission: { admitActions: unavailable },
			channelAdmission: { admitChannels: unavailable },
		},
		allocateApplicationIds: unavailable,
		prepareApplicationSecrets: unavailable,
		prepareConfigurationSecrets: unavailable,
		presentAgent: unavailable,
	};
}
