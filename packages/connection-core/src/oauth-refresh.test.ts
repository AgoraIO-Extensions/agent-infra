import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
	type ConnectionOAuthRepository,
	ConnectionOAuthService,
	OAuthProtocolError,
	type OAuthTokenIdentity,
} from "./oauth";

const resource = "https://connection.example/mcp";

async function fixture() {
	let identityReference = "";
	let used = false;
	let revoked = false;
	const token = randomUUID();
	const hash = createHash("sha256").update(token).digest("hex");
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const identity = (): OAuthTokenIdentity => ({
		consumerId: "consumer-test",
		identityReference,
		instanceId: "instance-test",
		lastVerifiedAt: new Date(),
		principalId: "principal-test",
		recoveryGeneration: "1",
		resource,
	});
	const isActive = vi.fn(async () => {
		await gate;
		return true;
	});
	const readRefreshToken = vi.fn(
		async (
			input: Parameters<ConnectionOAuthRepository["readRefreshToken"]>[0],
		) => {
			if (input.clientId !== "client-test" || input.refreshTokenHash !== hash) {
				throw new OAuthProtocolError("invalid_grant", "Invalid binding");
			}
			if (used) {
				revoked = true;
				throw new OAuthProtocolError("invalid_grant", "Token replay");
			}
			return identity();
		},
	);
	const rotateRefreshToken = vi.fn(
		async (
			_input: Parameters<ConnectionOAuthRepository["rotateRefreshToken"]>[0],
		) => {
			if (used) {
				revoked = true;
				throw new OAuthProtocolError("invalid_grant", "Token replay");
			}
			used = true;
			return identity();
		},
	);
	const repository = {
		createBrowserSession: async (
			input: Parameters<ConnectionOAuthRepository["createBrowserSession"]>[0],
		) => {
			identityReference = input.identityReference;
			return { ...input, lastVerifiedAt: new Date(), recoveryGeneration: "1" };
		},
		readRefreshToken,
		rotateRefreshToken,
		touchPrincipalVerification: vi.fn(async () => {}),
	} satisfies Partial<ConnectionOAuthRepository>;
	const service = new ConnectionOAuthService({
		consumer: { id: "consumer-test", name: "Test" },
		directory: {
			authenticate: async () => ({
				displayName: "Test",
				email: null,
				issuer: "urn:test:ldap",
				subject: "test-subject",
			}),
			isActive,
		},
		identityKey: Buffer.alloc(32, 17),
		identityRealm: "urn:test:connection",
		repository: repository as unknown as ConnectionOAuthRepository,
		resource,
	});
	await service.loginBrowserSession({
		username: "test",
		password: randomUUID(),
	});
	return {
		input: { clientId: "client-test", refreshToken: token, resource },
		isActive,
		readRefreshToken,
		release,
		rotateRefreshToken,
		service,
		isRevoked: () => revoked,
	};
}

describe("Direct MCP OAuth refresh concurrency", () => {
	it("rotates once for overlapping requests, but still revokes sequential replay", async () => {
		const f = await fixture();
		const requests = [f.service.refresh(f.input), f.service.refresh(f.input)];
		f.release();
		const [first, second] = await Promise.all(requests);
		expect(first).toEqual(second);
		expect(f.readRefreshToken).toHaveBeenCalledTimes(1);
		expect(f.isActive).toHaveBeenCalledTimes(1);
		expect(f.rotateRefreshToken).toHaveBeenCalledTimes(1);
		expect(f.isRevoked()).toBe(false);
		expect(first?.expires_in).toBe(300);
		expect(
			f.rotateRefreshToken.mock.calls[0]?.[0].refreshTokenExpiresAt.getTime(),
		).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60_000);
		await expect(f.service.refresh(f.input)).rejects.toMatchObject({
			error: "invalid_grant",
		});
		expect(f.readRefreshToken).toHaveBeenCalledTimes(2);
		expect(f.isRevoked()).toBe(true);
	});

	it("clears failed operations so an unchanged token can be retried", async () => {
		const f = await fixture();
		f.readRefreshToken.mockRejectedValueOnce(new Error("store unavailable"));
		await expect(f.service.refresh(f.input)).rejects.toThrow(
			"store unavailable",
		);
		f.release();
		await expect(f.service.refresh(f.input)).resolves.toMatchObject({
			token_type: "Bearer",
		});
		expect(f.readRefreshToken).toHaveBeenCalledTimes(2);
		expect(f.rotateRefreshToken).toHaveBeenCalledTimes(1);
	});

	it("does not share results across client, resource or token bindings", async () => {
		const f = await fixture();
		const pending = f.service.refresh(f.input);
		for (const input of [
			{ ...f.input, clientId: "other-client" },
			{ ...f.input, resource: "https://other.example/mcp" },
			{ ...f.input, refreshToken: randomUUID() },
		]) {
			await expect(f.service.refresh(input)).rejects.toMatchObject({
				error: "invalid_grant",
			});
		}
		f.release();
		await expect(pending).resolves.toMatchObject({ token_type: "Bearer" });
		expect(f.rotateRefreshToken).toHaveBeenCalledTimes(1);
		expect(f.isRevoked()).toBe(false);
	});
});
