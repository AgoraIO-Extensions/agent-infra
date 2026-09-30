import type { PlatformApiAssemblyInput } from "../../apps/platform-api/src/assembly.js";

type DirectoryMode =
	| "active"
	| "disabled"
	| "missing"
	| "mismatched"
	| "malformed"
	| "error"
	| "revision_changed"
	| "finally_disabled";

export const state: {
	databaseUrl: string;
	directoryMode: DirectoryMode;
	directoryCalls: number;
} = { databaseUrl: "", directoryMode: "active", directoryCalls: 0 };

const unused = async (): Promise<never> => {
	throw new Error("Unused personal credential test dependency");
};

// Only current identity facts are controlled; all business and persistence
// adapters are created by the production deployment loader and assembly.
export function createPlatformApiAssemblyInput(): PlatformApiAssemblyInput {
	if (!state.databaseUrl) throw new Error("Test database is not configured");
	return {
		databaseUrl: state.databaseUrl,
		identity: {
			async resolve(request) {
				const cookie = request.headers.get("Cookie");
				const userId =
					cookie === "__Host-platform-session=session_alice"
						? "user_alice"
						: cookie === "__Host-platform-session=session_bob"
							? "user_bob"
							: cookie === "__Host-platform-session=session_admin"
								? "user_admin"
								: null;
				if (userId === null) return null;
				return {
					schemaVersion: 1,
					userId,
					displayName: userId,
					accountStatus: "active",
					organizationIds: ["org_1"],
					roles: userId === "user_admin" ? ["system_admin"] : ["employee"],
					authorizationRevision: "revision_1",
				};
			},
			async resolveUser(userId) {
				state.directoryCalls++;
				if (state.directoryMode === "error")
					throw new Error("PRIVATE_DIRECTORY_SENTINEL");
				if (state.directoryMode === "missing") return null;
				const finalRead = state.directoryCalls % 2 === 0;
				return {
					schemaVersion: state.directoryMode === "malformed" ? 2 : 1,
					userId: state.directoryMode === "mismatched" ? "user_other" : userId,
					accountStatus:
						state.directoryMode === "disabled" ||
						(state.directoryMode === "finally_disabled" && finalRead)
							? "disabled"
							: "active",
					organizationIds: ["org_1"],
					authorizationRevision:
						state.directoryMode === "revision_changed" && finalRead
							? "revision_2"
							: "revision_1",
				};
			},
			async hydrateUsers(userIds) {
				return userIds.map((userId) => ({
					userId,
					displayName: userId,
					roles: ["employee"],
				}));
			},
		},
		admissions: {
			authorizationAdmission: { authorize: unused },
			imageAdmission: { admitImage: unused },
			modelAdmission: { admitModels: unused },
			secretAdmission: { admitSecrets: unused },
			channelAdmission: { admitChannels: unused },
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: unused,
	};
}
