import { describe, expect, it, vi } from "vitest";
import {
	type AccessTokenRecord,
	ConnectionTokenService,
	hashConnectionToken,
	type InstallationBinding,
} from "./tokens.js";

function harness() {
	const installation: InstallationBinding = {
		id: "instance-alice",
		consumerId: "consumer-mcp",
		principalId: "principal-alice",
		actorId: null,
		status: "active",
		recoveryGeneration: 4,
		keyFingerprint: "key-fingerprint",
	};
	const records: AccessTokenRecord[] = [];
	const tokens = {
		insert: vi.fn(async (record: AccessTokenRecord) => {
			records.push(record);
		}),
		findByHash: vi.fn(async (hash: string) =>
			records.find((record) => record.tokenHash === hash),
		),
		revoke: vi.fn(async () => {}),
		revokeFamily: vi.fn(async () => {}),
	};
	const service = new ConnectionTokenService(
		tokens,
		{
			findById: vi.fn(async (id: string) =>
				id === installation.id ? installation : undefined,
			),
		},
		{
			findById: vi.fn(async (id: string) =>
				id === installation.principalId
					? { id, status: "active" as const, recoveryGeneration: 4 }
					: undefined,
			),
		},
		{
			findById: vi.fn(async (id: string) =>
				id === installation.consumerId
					? { id, status: "active" as const }
					: undefined,
			),
		},
		{ verify: vi.fn(async ({ proof }) => proof === "proof") },
		() => 1_000,
	);
	return { installation, records, tokens, service };
}

describe("installation-bound Connection tokens", () => {
	it("stores only a hash and resolves server-owned authority", async () => {
		const { installation, records, service } = harness();
		await expect(
			service.issue({
				kind: "pat",
				installation,
				audience: "connection-mcp",
				scopes: ["catalog:read"],
				recoveryGeneration: 3,
			}),
		).rejects.toThrow(/generation/);
		const issued = await service.issue({
			kind: "pat",
			installation,
			audience: "connection-mcp",
			scopes: ["catalog:read", "action:read"],
			recoveryGeneration: 4,
		});
		expect(records[0]?.tokenHash).toBe(hashConnectionToken(issued.secret));
		expect(records[0]).not.toHaveProperty("secret");
		expect(
			await service.authenticate({
				secret: issued.secret,
				proof: "proof",
				audience: "connection-mcp",
				requiredScope: "catalog:read",
			}),
		).toMatchObject({
			principalId: installation.principalId,
			consumerInstanceId: installation.id,
		});
	});

	it("fails closed for proof, audience, scope, generation and revocation changes", async () => {
		const { installation, records, service, tokens } = harness();
		const issued = await service.issue({
			kind: "oauth_access",
			installation,
			audience: "connection-mcp",
			scopes: ["action:read"],
			recoveryGeneration: 4,
		});
		for (const input of [
			{
				proof: "wrong",
				audience: "connection-mcp",
				requiredScope: "action:read",
			},
			{ proof: "proof", audience: "other", requiredScope: "action:read" },
			{
				proof: "proof",
				audience: "connection-mcp",
				requiredScope: "action:write",
			},
		])
			expect(
				await service.authenticate({ secret: issued.secret, ...input }),
			).toBeUndefined();
		(records[0] as AccessTokenRecord).revokedAt = 2_000;
		expect(
			await service.authenticate({
				secret: issued.secret,
				proof: "proof",
				audience: "connection-mcp",
			}),
		).toBeUndefined();
		await service.revokeFamily(issued.record);
		expect(tokens.revokeFamily).toHaveBeenCalledWith(
			issued.record.familyId,
			1_000,
		);
	});
});
