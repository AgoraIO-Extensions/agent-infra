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
		let searchFailure = false;
		let candidateWrites = 0;
		let candidateResolutions = 0;
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
				searchEmployees: async () => {
					if (searchFailure) throw new Error("LDAP transport failure");
					return [
						{
							alias: "alice",
							displayName: "Alice",
							email: "alice@example.invalid",
							issuer: "urn:test:ldap",
							subject: "secret-stable-uid",
						},
					];
				},
			},
			identityKey: Buffer.alloc(32, 17),
			identityRealm: "urn:test:approval",
			repository: {
				storeEmployeeCandidates: async (
					input: Parameters<
						NonNullable<ConnectionOAuthRepository["storeEmployeeCandidates"]>
					>[0],
				) => {
					candidateWrites++;
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
				resolveEmployeeCandidate: async () => {
					candidateResolutions++;
					return {
						displaySnapshot: {
							displayName: "Alice",
							email: "alice@example.invalid",
						},
						principalId: "principal-alice",
					};
				},
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
		searchFailure = true;
		await expect(
			service.searchEmployeeCandidates("admin", "alice"),
		).rejects.toMatchObject({
			status: 503,
			message: "Employee directory search is unavailable",
		});
		expect(candidateWrites).toBe(1);
		searchFailure = false;
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
		).rejects.toMatchObject({ error: "access_denied", status: 403 });
		expect(candidateResolutions).toBe(0);
		isActive = true;
		await expect(
			service.ensureActiveEmployeePrincipal("principal-alice"),
		).resolves.toBeUndefined();
		await expect(
			service.ensureActiveEmployeePrincipal("principal-unknown"),
		).rejects.toMatchObject({ error: "access_denied" });
		directoryFailure = true;
		await expect(
			service.resolveEmployeeCandidate("admin", candidateId),
		).rejects.toMatchObject({
			status: 503,
			message: "Employee directory verification is unavailable",
		});
		expect(candidateResolutions).toBe(0);
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
