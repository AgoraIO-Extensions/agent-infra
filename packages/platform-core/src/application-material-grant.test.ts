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
			ldapStableUid: "ldap-admin-1",
			ldapAdministratorConfigured: true,
			authorizationRevision: "auth-1",
		},
		...overrides,
	};
}
function makeUseCase(options: {
	store: ApplicationMaterialGrantStoreV1;
	resolveUser: (
		userId: string,
	) => Promise<{ readonly accountStatus: "active" | "disabled" } | null>;
}) {
	return createApplicationMaterialGrantUseCaseV1({
		...options,
		resolveCurrentActor: async () => ({
			accountStatus: "active",
			isSystemAdmin: true,
			ldapStableUid: "ldap-admin-1",
			ldapAdministratorConfigured: true,
			authorizationRevision: "auth-1",
		}),
	});
}
function fakeStore(
	options: {
		applicationExists?: boolean;
		recipientEligible?: boolean;
		auditFails?: boolean;
		afterGrantLocked?: () => void;
	} = {},
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
			const before = state.row;
			const auditsBefore = state.audits;
			try {
				return await work({
					lockUserDisabled: async () => false,
					applicationExists: async () => options.applicationExists ?? true,
					recipientEligible: async () => options.recipientEligible ?? true,
					lockGrant: async () => {
						options.afterGrantLocked?.();
						return state.row;
					},
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
						if (options.auditFails) throw new Error("audit unavailable");
						state.audits += 1;
					},
				});
			} catch (error) {
				state.row = before;
				state.audits = auditsBefore;
				throw error;
			}
		},
	};
}
describe("application material grant authority", () => {
	it.each([
		{ operation: "grant", existing: false, revoked: false },
		{ operation: "grant", existing: true, revoked: false },
		{ operation: "revoke", existing: true, revoked: false },
		{ operation: "revoke", existing: true, revoked: true },
		{ operation: "read", existing: true, revoked: false },
	] as const)(
		"rolls back $operation (existing=$existing, revoked=$revoked) when administrator authority is removed while waiting for the grant lock",
		async ({ operation, existing, revoked }) => {
			let administratorConfigured = true;
			const store = fakeStore({
				afterGrantLocked: () => {
					administratorConfigured = false;
				},
			});
			const before: ApplicationMaterialGrantMetadataV1 | null = existing
				? {
						applicationId: "app-1",
						principalType: "user",
						principalId: "recipient-1",
						authorizationRevision: "rev-1",
						createdAt: "2026-10-03T00:00:00.000Z",
						revokedAt: revoked ? "2026-10-03T01:00:00.000Z" : null,
					}
				: null;
			store.row = before;
			const useCase = createApplicationMaterialGrantUseCaseV1({
				store,
				resolveUser: async () => ({ accountStatus: "active" }),
				resolveCurrentActor: async () => ({
					accountStatus: "active",
					isSystemAdmin: true,
					ldapStableUid: "ldap-admin-1",
					ldapAdministratorConfigured: administratorConfigured,
					authorizationRevision: "auth-1",
				}),
			});
			await expect(
				useCase[operation](
					request(existing ? { expectedRevision: "rev-1" } : {}),
				),
			).rejects.toMatchObject({ code: "authentication_required" });
			expect(store.row).toEqual(before);
			expect(store.audits).toBe(0);
		},
	);

	it("fails closed when the actor has no current LDAP administrator proof", async () => {
		const store = fakeStore();
		const useCase = makeUseCase({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		await expect(
			useCase.grant(
				request({
					actor: {
						...request().actor,
						ldapStableUid: undefined,
					},
				}),
			),
		).rejects.toMatchObject({ code: "forbidden" });
	});

	it("rejects a stale disabled actor from the current LDAP resolver", async () => {
		const store = fakeStore();
		const useCase = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
			resolveCurrentActor: async () => ({
				accountStatus: "disabled",
				isSystemAdmin: true,
				ldapStableUid: "ldap-admin-1",
				ldapAdministratorConfigured: true,
				authorizationRevision: "auth-1",
			}),
		});
		await expect(useCase.grant(request())).rejects.toMatchObject({
			code: "authentication_required",
		});
		expect(store.row).toBeNull();
	});

	it("requires an explicit complete self grant", async () => {
		const store = fakeStore();
		const useCase = makeUseCase({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		await expect(
			useCase.grant(request({ principalType: "user", principalId: "admin-1" })),
		).resolves.toMatchObject({
			metadata: { principalId: "admin-1", revokedAt: null },
		});
	});

	it("fails closed when LDAP current resolution is unavailable", async () => {
		const store = fakeStore();
		const useCase = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
			resolveCurrentActor: async () => {
				throw new Error("ldap unavailable");
			},
		});
		await expect(useCase.grant(request())).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(store.row).toBeNull();
	});

	it("rolls back a grant when audit recording fails", async () => {
		const store = fakeStore({ auditFails: true });
		const useCase = makeUseCase({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		await expect(useCase.grant(request())).rejects.toThrow("audit unavailable");
		expect(store.row).toBeNull();
	});

	it("rejects a manager without system_admin writer authority", async () => {
		const store = fakeStore();
		const useCase = makeUseCase({
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
		const useCase = makeUseCase({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		await useCase.grant(request());
		await expect(
			useCase.revoke(request({ expectedRevision: "stale" })),
		).rejects.toBeInstanceOf(ApplicationMaterialGrantErrorV1);
		expect(store.row?.revokedAt).toBeNull();
	});
	it("rejects an unknown user recipient", async () => {
		const store = fakeStore();
		const useCase = makeUseCase({
			store,
			resolveUser: async () => null,
		});
		await expect(useCase.grant(request())).rejects.toMatchObject({
			code: "not_found",
		});
		expect(store.row).toBeNull();
	});

	it("rejects an application recipient from another application", async () => {
		const store = fakeStore();
		const useCase = makeUseCase({
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
		const useCase = makeUseCase({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		const result = await useCase.grant(request({ expectedRevision: "rev-1" }));
		expect(result.replayed).toBe(true);
		expect(result.metadata.authorizationRevision).toBe("rev-1");
	});
	it("rejects an expected revision when no grant exists", async () => {
		const store = fakeStore();
		const useCase = makeUseCase({
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
		const useCase = makeUseCase({
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
		const useCase = makeUseCase({
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
	it("preserves a revoked grant on an idempotent revoke replay", async () => {
		const store = fakeStore();
		const revokedAt = new Date().toISOString();
		store.row = {
			applicationId: "app-1",
			principalType: "user",
			principalId: "recipient-1",
			authorizationRevision: "revoked-revision",
			createdAt: new Date().toISOString(),
			revokedAt,
		};
		const useCase = makeUseCase({
			store,
			resolveUser: async () => ({ accountStatus: "disabled" }),
		});
		await expect(
			useCase.revoke(request({ expectedRevision: "revoked-revision" })),
		).resolves.toEqual({
			metadata: expect.objectContaining({
				authorizationRevision: "revoked-revision",
				revokedAt,
			}),
			replayed: true,
		});
	});
	it("rejects current reads for an inactive recipient", async () => {
		const store = fakeStore({ recipientEligible: false });
		store.row = {
			applicationId: "app-1",
			principalType: "user",
			principalId: "recipient-1",
			authorizationRevision: "rev-1",
			createdAt: new Date().toISOString(),
			revokedAt: null,
		};
		const useCase = makeUseCase({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		await expect(useCase.read(request())).rejects.toMatchObject({
			code: "not_found",
		});
	});

	it("keeps material out of the result and records the grant audit", async () => {
		const store = fakeStore();
		const useCase = makeUseCase({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
		});
		const result = await useCase.grant(request());
		expect(result.metadata).not.toHaveProperty("credential");
		expect(store.audits).toBe(1);
	});
});
