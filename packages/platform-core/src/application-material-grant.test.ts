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
function fakeStore(
	options: { applicationExists?: boolean; recipientEligible?: boolean } = {},
): ApplicationMaterialGrantStoreV1 & {
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
				applicationExists: async () => options.applicationExists ?? true,
				recipientEligible: async () => options.recipientEligible ?? true,
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
	it("requires and preserves the current revision for an active replay", async () => {
		const store = fakeStore();
		store.row = {
			applicationId: "app-1",
			principalType: "user",
			principalId: "recipient-1",
			authorizationRevision: "rev-1",
			createdAt: new Date().toISOString(),
			revokedAt: null,
		};
		const useCase = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		const result = await useCase.grant(request({ expectedRevision: "rev-1" }));
		expect(result.replayed).toBe(true);
		expect(result.metadata.authorizationRevision).toBe("rev-1");
	});
	it("rejects an expected revision when no grant exists", async () => {
		const store = fakeStore();
		const useCase = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		await expect(
			useCase.grant(request({ expectedRevision: "missing" })),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		expect(store.row).toBeNull();
	});
	it("allows revocation after the recipient is disabled", async () => {
		const store = fakeStore({ recipientEligible: false });
		store.row = {
			applicationId: "app-1",
			principalType: "user",
			principalId: "recipient-1",
			authorizationRevision: "rev-1",
			createdAt: new Date().toISOString(),
			revokedAt: null,
		};
		const useCase = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "disabled" }),
		});
		await expect(
			useCase.revoke(request({ expectedRevision: "rev-1" })),
		).resolves.toMatchObject({ metadata: { revokedAt: expect.any(String) } });
	});
	it("allows revocation after an application recipient becomes inactive", async () => {
		const store = fakeStore({
			applicationExists: false,
			recipientEligible: false,
		});
		store.row = {
			applicationId: "app-1",
			principalType: "application",
			principalId: "app-1",
			authorizationRevision: "rev-1",
			createdAt: new Date().toISOString(),
			revokedAt: null,
		};
		const useCase = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		await expect(
			useCase.revoke(
				request({
					principalType: "application",
					principalId: "app-1",
					expectedRevision: "rev-1",
				}),
			),
		).resolves.toMatchObject({ metadata: { revokedAt: expect.any(String) } });
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
