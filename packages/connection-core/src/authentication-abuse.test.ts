import { expect, it, vi } from "vitest";
import {
	type ConnectionOAuthRepository,
	ConnectionOAuthService,
	OAuthProtocolError,
} from "./oauth";

it("uses private canonical account keys and a common failure delay before returning a generic denial", async () => {
	const consume = vi.fn(async (budgets: { keyHash: string }[]) =>
		budgets.map((b) => ({
			keyHash: b.keyHash,
			windowEndsAt: new Date(Date.now() + 300_000),
		})),
	);
	const authenticate = vi.fn(async (username: string) => {
		throw new Error(
			username === "Alice" ? "Invalid password" : "Unknown directory account",
		);
	});
	const service = new ConnectionOAuthService({
		consumer: { id: "test", name: "Test" },
		directory: { authenticate, isActive: async () => true },
		identityKey: Buffer.alloc(32, 29),
		identityRealm: "urn:test:auth-budget",
		resource: "https://connection.example/mcp",
		repository: {
			consumeAuthenticationBudget: consume,
		} as unknown as ConnectionOAuthRepository,
	});
	for (const username of [" Alice ", "alice", "unknown-user"]) {
		const started = performance.now();
		await expect(
			service.loginBrowserSession({
				username,
				password: "synthetic-wrong-password",
			}),
		).rejects.toMatchObject({
			error: "access_denied",
			status: 401,
			message: "Authentication failed",
		});
		expect(performance.now() - started).toBeGreaterThanOrEqual(280);
	}

	expect(consume.mock.calls[0]?.[0][1]?.keyHash).toBe(
		consume.mock.calls[1]?.[0][1]?.keyHash,
	);
	expect(consume.mock.calls[2]?.[0][1]?.keyHash).not.toBe(
		consume.mock.calls[0]?.[0][1]?.keyHash,
	);
	expect(JSON.stringify(consume.mock.calls)).not.toMatch(
		/Alice|alice|unknown-user|synthetic-wrong-password/,
	);
	consume.mockRejectedValueOnce(
		new OAuthProtocolError("temporarily_unavailable", "throttled", 429, 60),
	);
	await expect(
		service.loginBrowserSession({
			username: "alice",
			password: "synthetic-wrong-password",
		}),
	).rejects.toMatchObject({ status: 429 });
	expect(authenticate).toHaveBeenCalledTimes(3);
});
