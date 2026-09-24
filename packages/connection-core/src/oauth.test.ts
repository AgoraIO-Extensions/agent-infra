import { describe, expect, it, vi } from "vitest";
import {
	type AuthorizationCodeRecord,
	hashOAuthSecret,
	OAuthAuthorizationService,
	pkceChallenge,
	type RefreshTokenRecord,
} from "./oauth.js";

function harness() {
	const codes: AuthorizationCodeRecord[] = [];
	const refresh: RefreshTokenRecord[] = [];
	const stores = {
		codes: {
			insert: vi.fn(async (record: AuthorizationCodeRecord) => {
				codes.push(record);
			}),
			findByHash: vi.fn(async (hash: string) =>
				codes.find((record) => record.codeHash === hash),
			),
			consume: vi.fn(async (id: string, at: number) => {
				const record = codes.find((value) => value.id === id);
				if (!record || record.consumedAt !== null) return false;
				record.consumedAt = at;
				return true;
			}),
		},
		refresh: {
			insert: vi.fn(async (record: RefreshTokenRecord) => {
				refresh.push(record);
			}),
			findByHash: vi.fn(async (hash: string) =>
				refresh.find((record) => record.tokenHash === hash),
			),
			consume: vi.fn(async (id: string, at: number) => {
				const record = refresh.find((value) => value.id === id);
				if (!record || record.usedAt !== null) return false;
				record.usedAt = at;
				return true;
			}),
			revokeFamily: vi.fn(async (familyId: string, at: number) => {
				for (const record of refresh)
					if (record.familyId === familyId) record.revokedAt = at;
			}),
		},
	};
	const service = new OAuthAuthorizationService(
		stores.codes,
		stores.refresh,
		() => 1_000,
	);
	return { codes, refresh, service, stores };
}

const verifier = "A".repeat(43);

describe("OAuth code and refresh rotation", () => {
	it("binds a one-time Authorization Code to client, installation, redirect and PKCE", async () => {
		const { service, codes } = harness();
		const issued = await service.issueAuthorizationCode({
			clientId: "client-a",
			principalId: "principal-a",
			consumerId: "consumer-a",
			consumerInstanceId: "instance-a",
			actorId: null,
			redirectUri: "https://client.example/callback",
			codeChallenge: pkceChallenge(verifier),
			audience: "connection-mcp",
			scopes: ["catalog:read"],
			recoveryGeneration: 2,
		});
		expect(codes[0]?.codeHash).toBe(hashOAuthSecret(issued.secret));
		expect(
			await service.redeemAuthorizationCode({
				secret: issued.secret,
				clientId: "client-a",
				redirectUri: "https://wrong.example/callback",
				codeVerifier: verifier,
			}),
		).toBeUndefined();
		const context = await service.redeemAuthorizationCode({
			secret: issued.secret,
			clientId: "client-a",
			redirectUri: "https://client.example/callback",
			codeVerifier: verifier,
		});
		expect(context).toMatchObject({
			principalId: "principal-a",
			consumerInstanceId: "instance-a",
			clientId: "client-a",
		});
		expect(
			await service.redeemAuthorizationCode({
				secret: issued.secret,
				clientId: "client-a",
				redirectUri: "https://client.example/callback",
				codeVerifier: verifier,
			}),
		).toBeUndefined();
	});

	it("rotates refresh tokens and revokes the family on replay", async () => {
		const { service, refresh, stores } = harness();
		const issued = await service.issueRefreshToken({
			principalId: "p",
			consumerId: "c",
			consumerInstanceId: "i",
			actorId: null,
			audience: "connection-mcp",
			scopes: ["action:read"],
			recoveryGeneration: 1,
			tokenId: "t",
			clientId: "client",
			redirectUri: "",
		});
		const rotated = await service.rotateRefreshToken({
			secret: issued.secret,
			context: {
				principalId: "p",
				consumerId: "c",
				consumerInstanceId: "i",
				actorId: null,
				audience: "connection-mcp",
				recoveryGeneration: 1,
			},
		});
		expect(rotated?.record.familyId).toBe(issued.record.familyId);
		expect(refresh).toHaveLength(2);
		await service.rotateRefreshToken({
			secret: issued.secret,
			context: {
				principalId: "p",
				consumerId: "c",
				consumerInstanceId: "i",
				actorId: null,
				audience: "connection-mcp",
				recoveryGeneration: 1,
			},
		});
		expect(stores.refresh.revokeFamily).toHaveBeenCalledWith(
			issued.record.familyId,
			1_000,
		);
	});
});
