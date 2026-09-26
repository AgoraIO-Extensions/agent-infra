import { describe, expect, it } from "vitest";

import {
	type ConnectionOAuthRepository,
	ConnectionOAuthService,
} from "./oauth";

describe("approval employee candidate identity", () => {
	it("returns opaque candidates and rechecks active identity before mapping", async () => {
		let protectedIdentity = "";
		let requestedBy = "";
		let isActive = true;
		let directoryFailure = false;
		const service = new ConnectionOAuthService({
			consumer: { id: "consumer-test", name: "Test" },
			directory: {
				authenticate: async () => {
					throw new Error("not used");
				},
				isActive: async () => {
					if (directoryFailure) throw new Error("directory unavailable");
					return isActive;
				},
				searchEmployees: async () => [
					{
						alias: "alice",
						displayName: "Alice",
						email: "alice@example.invalid",
						issuer: "urn:test:ldap",
						subject: "secret-stable-uid",
					},
				],
			},
			identityKey: Buffer.alloc(32, 17),
			identityRealm: "urn:test:approval",
			repository: {
				storeEmployeeCandidates: async (
					input: Parameters<
						NonNullable<ConnectionOAuthRepository["storeEmployeeCandidates"]>
					>[0],
				) => {
					requestedBy = input.requestedByPrincipalId;
					protectedIdentity = input.candidates[0]?.identityReference ?? "";
				},
				getEmployeeCandidate: async ({
					requestedByPrincipalId,
				}: Parameters<
					NonNullable<ConnectionOAuthRepository["getEmployeeCandidate"]>
				>[0]) =>
					requestedByPrincipalId === requestedBy
						? { identityReference: protectedIdentity }
						: undefined,
				getEmployeePrincipalIdentity: async (principalId: string) =>
					principalId === "principal-alice"
						? {
								identityReference: protectedIdentity,
								displayName: "Alice",
								email: "alice@example.invalid",
							}
						: undefined,
				resolveEmployeeCandidate: async () => ({
					displaySnapshot: {
						displayName: "Alice",
						email: "alice@example.invalid",
					},
					principalId: "principal-alice",
				}),
			} as unknown as ConnectionOAuthRepository,
			resource: "https://connection.example/mcp",
		});
		const candidates = await service.searchEmployeeCandidates("admin", "alice");
		expect(candidates).toMatchObject([
			{
				alias: "alice",
				candidateId: expect.stringMatching(/^employee-candidate-/),
				displayName: "Alice",
				email: "alice@example.invalid",
			},
		]);
		expect(JSON.stringify(candidates)).not.toContain("secret-stable-uid");
		expect(protectedIdentity).not.toContain("secret-stable-uid");
		const candidateId = candidates[0]?.candidateId ?? "";
		await expect(
			service.resolveEmployeeCandidate("other-admin", candidateId),
		).rejects.toMatchObject({ error: "access_denied" });
		isActive = false;
		await expect(
			service.ensureActiveEmployeePrincipal("principal-alice"),
		).rejects.toMatchObject({ error: "access_denied" });
		await expect(
			service.resolveEmployeeCandidate("admin", candidateId),
		).rejects.toMatchObject({ error: "access_denied" });
		isActive = true;
		await expect(
			service.ensureActiveEmployeePrincipal("principal-alice"),
		).resolves.toBeUndefined();
		await expect(
			service.ensureActiveEmployeePrincipal("principal-unknown"),
		).rejects.toMatchObject({ error: "access_denied" });
		directoryFailure = true;
		await expect(
			service.ensureActiveEmployeePrincipal("principal-alice"),
		).rejects.toMatchObject({ status: 503 });
		directoryFailure = false;
		await expect(
			service.resolveEmployeeCandidate("admin", candidateId),
		).resolves.toMatchObject({ principalId: "principal-alice" });
		const restored = await service.prepareEmployeeCandidatesForPrincipals(
			"editing-admin",
			["principal-alice", "principal-alice"],
		);
		expect(restored).toHaveLength(1);
		expect(restored[0]).toMatchObject({
			principalId: "principal-alice",
			displayName: "Alice",
		});
		expect(restored[0]?.candidateId).not.toBe(candidateId);
		expect(requestedBy).toBe("editing-admin");
		await expect(
			service.resolveEmployeeCandidate("admin", restored[0]?.candidateId ?? ""),
		).rejects.toMatchObject({ error: "access_denied" });
		isActive = false;
		await expect(
			service.resolveEmployeeCandidate(
				"editing-admin",
				restored[0]?.candidateId ?? "",
			),
		).rejects.toMatchObject({ error: "access_denied" });
		await expect(
			service.prepareEmployeeCandidatesForPrincipals("editing-admin", [
				"unknown",
			]),
		).rejects.toMatchObject({ error: "access_denied" });
		await expect(
			service.prepareEmployeeCandidatesForPrincipals(
				"editing-admin",
				Array(501).fill("principal-alice"),
			),
		).rejects.toMatchObject({ status: 400 });
	});
});
