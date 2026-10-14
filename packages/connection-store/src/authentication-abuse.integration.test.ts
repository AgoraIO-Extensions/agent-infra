import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	authenticationAbuseLimits,
	ConnectionOAuthService,
} from "@agent-infra/connection-core";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionOAuthRepository } from "./oauth-repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl)
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
const integrationTest = databaseUrl ? it : it.skip;
const resource = "https://connection.example/mcp";
function service(
	repository: PostgresConnectionOAuthRepository,
	consumerId = `abuse-${randomUUID()}`,
) {
	return new ConnectionOAuthService({
		consumer: { id: consumerId, name: "Abuse test" },
		identityRealm: `urn:test:${consumerId}`,
		identityKey: Buffer.alloc(32, 31),
		repository,
		resource,
		directory: {
			authenticate: async (username) => ({
				issuer: "urn:test:ldap",
				subject: username,
				displayName: username,
				email: `${username}@example.invalid`,
			}),
			isActive: async () => true,
		},
	});
}
async function migrate() {
	if (!databaseUrl) throw new Error("Missing test database");
	await migrateConnectionDatabase(
		databaseUrl,
		resolve(import.meta.dirname, "../../../migrations/connection"),
	);
}

integrationTest(
	"budgets are atomic across repositories, survive reconnect, recover by window and never release into a newer window",
	async () => {
		if (!databaseUrl) return;
		await migrate();
		const first = new PostgresConnectionOAuthRepository(databaseUrl);
		const second = new PostgresConnectionOAuthRepository(databaseUrl);
		const sql = postgres(databaseUrl);
		const keyHash = createHash("sha256").update(randomUUID()).digest("hex");
		const budget = { keyHash, limit: 3, windowMs: 60_000 };
		try {
			const outcomes = await Promise.allSettled(
				Array.from({ length: 12 }, (_, index) =>
					(index % 2 ? first : second).consumeAuthenticationBudget([budget]),
				),
			);
			expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(3);
			expect(outcomes.filter((x) => x.status === "rejected")).toHaveLength(9);
			const accepted = outcomes.find((x) => x.status === "fulfilled");
			if (accepted?.status !== "fulfilled" || !accepted.value[0])
				throw new Error("Missing reservation");
			const reservation = accepted.value[0];
			await expect(
				second.consumeAuthenticationBudget([budget]),
			).rejects.toMatchObject({
				status: 429,
				retryAfterSeconds: expect.any(Number),
			});
			await first.releaseAuthenticationBudget(reservation);
			await second.consumeAuthenticationBudget([budget]);
			await expect(
				first.consumeAuthenticationBudget([budget]),
			).rejects.toMatchObject({ status: 429 });
			await sql`UPDATE connection_authentication_budgets SET window_ends_at = now() - interval '1 second' WHERE key_hash = ${keyHash}`;
			await second.consumeAuthenticationBudget([budget]);
			await first.releaseAuthenticationBudget(reservation);
			const [row] = await sql<
				{ attempts: number }[]
			>`SELECT attempts FROM connection_authentication_budgets WHERE key_hash = ${keyHash}`;
			expect(row?.attempts).toBe(1);
		} finally {
			await first.close();
			await second.close();
			await sql.end();
		}
	},
);

integrationTest(
	"dynamic quota and cleanup cannot remove trusted or previously authorized clients",
	async () => {
		if (!databaseUrl) return;
		await migrate();
		const repository = new PostgresConnectionOAuthRepository(databaseUrl);
		const sql = postgres(databaseUrl);
		const consumerId = `quota-${randomUUID()}`;
		const makeClient = () => ({
			clientId: randomUUID(),
			instanceId: randomUUID(),
			clientName: "Quota test",
			consumerId,
			consumerName: "Quota test",
			redirectUris: ["http://127.0.0.1:58245/callback/quota-test"],
		});
		try {
			const trusted = makeClient();
			await repository.registerClient(trusted);
			const prefix = randomUUID();
			await sql`INSERT INTO connection_consumer_instances (id, consumer_id, kind, auth_subject, status)
   SELECT ${prefix} || '-device-' || n, ${consumerId}, 'DEVICE', ${prefix} || '-subject-' || n, 'ACTIVE' FROM generate_series(1, ${authenticationAbuseLimits.pendingRegistrations}) n`;
			await sql`INSERT INTO connection_oauth_clients (client_id, client_name, consumer_id, instance_id, redirect_uris, status, registration_kind)
   SELECT ${prefix} || '-client-' || n, 'Quota test', ${consumerId}, ${prefix} || '-device-' || n,
    ${sql.json(trusted.redirectUris)}, 'ACTIVE', 'DYNAMIC' FROM generate_series(1, ${authenticationAbuseLimits.pendingRegistrations}) n`;
			await expect(
				repository.registerClient(makeClient(), { dynamic: true }),
			).rejects.toMatchObject({ status: 429 });
			const extraTrusted = makeClient();
			await repository.registerClient(extraTrusted);
			const protectedId = `${prefix}-client-1`;
			const pendingService = service(repository, consumerId);
			const verifier = "x".repeat(43);
			await pendingService.beginAuthorization({
				clientId: protectedId,
				codeChallenge: createHash("sha256")
					.update(verifier)
					.digest("base64url"),
				codeChallengeMethod: "S256",
				redirectUri: trusted.redirectUris[0] ?? "",
				resource,
				responseType: "code",
				scope: "mcp",
				state: "quota-protected-state",
			});
			await sql`UPDATE connection_oauth_clients SET created_at = now() - interval '2 hours' WHERE client_id IN (${trusted.clientId}, ${protectedId}, ${`${prefix}-client-2`})`;
			const replacement = makeClient();
			await repository.registerClient(replacement, { dynamic: true });
			expect(await repository.findClient(trusted.clientId)).toBeDefined();
			expect(await repository.findClient(extraTrusted.clientId)).toBeDefined();
			expect(await repository.findClient(protectedId)).toBeDefined();
			expect(await repository.findClient(`${prefix}-client-2`)).toBeUndefined();
			const [device] = await sql<
				{ count: number }[]
			>`SELECT count(*)::integer AS count FROM connection_consumer_instances WHERE id = ${`${prefix}-device-2`}`;
			expect(device?.count).toBe(0);
			await expect(
				repository.registerClient(makeClient(), { dynamic: true }),
			).rejects.toMatchObject({ status: 429 });
		} finally {
			await repository.close();
			await sql.end();
		}
	},
);

integrationTest(
	"revoking one exact token cannot revoke another user's or the same user's independent client session",
	async () => {
		if (!databaseUrl) return;
		await migrate();
		const repository = new PostgresConnectionOAuthRepository(databaseUrl);
		const oauth = service(repository);
		const sql = postgres(databaseUrl);
		const redirectUri = "http://127.0.0.1:58245/callback/isolation";
		const verifier = "v".repeat(43);
		async function login(username: string) {
			const client = await oauth.registerClient({
				clientName: "Isolation",
				redirectUris: [redirectUri],
			});
			const pending = await oauth.beginAuthorization({
				clientId: client.clientId,
				codeChallenge: createHash("sha256")
					.update(verifier)
					.digest("base64url"),
				codeChallengeMethod: "S256",
				redirectUri,
				resource,
				responseType: "code",
				scope: "mcp",
				state: randomUUID(),
			});
			const approval = await oauth.approveAuthorization({
				username,
				password: "synthetic-password",
				requestId: pending.requestId,
			});
			const tokens = await oauth.exchangeAuthorizationCode({
				clientId: client.clientId,
				code: approval.code,
				codeVerifier: verifier,
				redirectUri,
				resource,
			});
			const identity = await oauth.verifyAccessToken(
				`Bearer ${tokens.access_token}`,
			);
			return { tokens, identity, client };
		}
		try {
			const alice = `alice-${randomUUID()}`;
			const first = await login(alice);
			const independent = await login(alice);
			const bob = await login(`bob-${randomUUID()}`);
			await sql`UPDATE connection_oauth_clients SET created_at = now() - interval '2 hours' WHERE client_id IN (${first.client.clientId}, ${independent.client.clientId}, ${bob.client.clientId})`;
			await oauth.registerClient({
				clientName: "Cleanup trigger",
				redirectUris: [redirectUri],
			});
			const [retained] = await sql<
				{ count: number }[]
			>`SELECT count(*)::integer AS count FROM connection_oauth_clients WHERE client_id IN (${first.client.clientId}, ${independent.client.clientId}, ${bob.client.clientId})`;
			expect(retained?.count).toBe(3);

			await expect(
				oauth.revokeInstance(
					`Bearer ${first.tokens.access_token}`,
					bob.identity.instanceId,
				),
			).rejects.toMatchObject({ error: "invalid_token" });
			await oauth.revokeToken(first.tokens.access_token);
			await expect(
				oauth.verifyAccessToken(`Bearer ${first.tokens.access_token}`),
			).rejects.toMatchObject({ error: "invalid_token" });
			await expect(
				oauth.verifyAccessToken(`Bearer ${independent.tokens.access_token}`),
			).resolves.toMatchObject({ principalId: first.identity.principalId });
			await expect(
				oauth.verifyAccessToken(`Bearer ${bob.tokens.access_token}`),
			).resolves.toMatchObject({ principalId: bob.identity.principalId });
			const aliceBrowser = await oauth.loginBrowserSession({
				username: alice,
				password: "synthetic-password",
			});
			const bobBrowser = await oauth.loginBrowserSession({
				username: `bob-pat-${randomUUID()}`,
				password: "synthetic-password",
			});
			const alicePat = await oauth.issuePersonalAccessToken({
				sessionToken: aliceBrowser.sessionToken,
				name: "Alice private PAT",
			});
			expect(
				await oauth.listPersonalAccessTokens(bobBrowser.sessionToken),
			).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ tokenId: alicePat.tokenId }),
				]),
			);
			await expect(
				oauth.revokePersonalAccessToken({
					sessionToken: bobBrowser.sessionToken,
					tokenId: alicePat.tokenId,
				}),
			).resolves.toBeUndefined();
			await expect(
				oauth.verifyAccessToken(`Bearer ${alicePat.token}`),
			).resolves.toMatchObject({ principalId: first.identity.principalId });
			await oauth.revokeToken("synthetic-unknown-token");
			await expect(
				oauth.verifyAccessToken(`Bearer ${independent.tokens.access_token}`),
			).resolves.toBeDefined();
		} finally {
			await repository.close();
			await sql.end();
		}
	},
);
