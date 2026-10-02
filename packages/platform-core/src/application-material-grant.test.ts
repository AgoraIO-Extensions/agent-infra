import { describe, expect, it } from "vitest";
import {
	ApplicationMaterialGrantErrorV1,
	type ApplicationMaterialGrantMetadataV1,
	type ApplicationMaterialGrantRequestV1,
	type ApplicationMaterialGrantStoreV1,
	createApplicationMaterialGrantUseCaseV1,
} from "./application-material-grant.js";

function request(
	overrides: Partial<ApplicationMaterialGrantRequestV1> = {},
): ApplicationMaterialGrantRequestV1 {
	return {
		requestId: "req-1",
		traceId: "trace-1",
		applicationId: "app-1",
		principalType: "user",
		principalId: "recipient-1",
		actor: {
			userId: "admin-1",
			accountStatus: "active",
			isSystemAdmin: true,
			authorizationRevision: "auth-1",
		},
		...overrides,
	};
}
function fakeStore(): ApplicationMaterialGrantStoreV1 & {
	row: ApplicationMaterialGrantMetadataV1 | null;
	audits: number;
} {
	const state: {
		row: ApplicationMaterialGrantMetadataV1 | null;
		audits: number;
	} = { row: null, audits: 0 };
	return {
		get row() {
			return state.row;
		},
		set row(value) {
			state.row = value;
		},
		get audits() {
			return state.audits;
		},
		async execute(work) {
			return work({
				lockUserDisabled: async () => false,
				applicationExists: async () => true,
				recipientEligible: async () => true,
				lockGrant: async () => state.row,
				upsertGrant: async (r, revision, createdAt) => {
					state.row = {
						applicationId: r.applicationId,
						principalType: r.principalType,
						principalId: r.principalId,
						authorizationRevision: revision,
						createdAt: createdAt.toISOString(),
						revokedAt: null,
					};
					return state.row;
				},
				revokeGrant: async (_r, revokedAt, revision) => {
					if (!state.row) return null;
					state.row = {
						...state.row,
						authorizationRevision: revision,
						revokedAt: revokedAt.toISOString(),
					};
					return state.row;
				},
				recordAudit: async () => {
					state.audits += 1;
				},
			});
		},
	};
}
describe("application material grant authority", () => {
	it("rejects a manager without system_admin writer authority", async () => {
		const store = fakeStore();
		const useCase = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		await expect(
			useCase.grant(
				request({ actor: { ...request().actor, isSystemAdmin: false } }),
			),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(store.row).toBeNull();
		expect(store.audits).toBe(0);
	});
	it("requires a revision for a concurrent revoke", async () => {
		const store = fakeStore();
		const useCase = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		await useCase.grant(request());
		await expect(
			useCase.revoke(request({ expectedRevision: "stale" })),
		).rejects.toBeInstanceOf(ApplicationMaterialGrantErrorV1);
		expect(store.row?.revokedAt).toBeNull();
	});
	it("rejects an application recipient from another application", async () => {
		const store = fakeStore();
		const useCase = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		await expect(
			useCase.grant(
				request({ principalType: "application", principalId: "app-2" }),
			),
		).rejects.toMatchObject({ code: "not_found" });
		expect(store.row).toBeNull();
	});
	it("keeps material out of the result and records the grant audit", async () => {
		const store = fakeStore();
		const useCase = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		const result = await useCase.grant(request());
		expect(result.metadata).not.toHaveProperty("credential");
		expect(store.audits).toBe(1);
	});
});
