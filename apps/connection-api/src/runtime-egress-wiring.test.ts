import type { GitHubOAuthProvider } from "@agent-infra/connection-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectionRuntime } from "./runtime-app";

const captured = vi.hoisted(() => ({
	oauth: undefined as GitHubOAuthProvider | undefined,
	requests: [] as string[],
	origins: [] as string[][],
}));

vi.mock("@agent-infra/connection-store", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@agent-infra/connection-store")>();
	class Repository {
		async publishProviderCatalog() {}
		async assertProviderRuntimeCoverage(releases: string[]) {
			expect(releases).toContain("rehoboam-connection-v10");
			expect(releases).toContain("datalego-connection-v6");
		}
		async publishConsumerDeclaration() {
			return { declarationId: "synthetic" };
		}
	}
	return {
		...actual,
		PostgresConnectionOAuthRepository: Repository,
		PostgresConnectionPatBindingRepository: Repository,
		PostgresConnectionRepository: Repository,
		PostgresBrowserCommandIdempotency: Repository,
		PostgresConnectionAccessRequestRepository: Repository,
		PostgresConnectionNotificationDispatcher: Repository,
		PostgresConnectionApprovalRepository: Repository,
	};
});

vi.mock("@agent-infra/connection-core", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@agent-infra/connection-core")>();
	return {
		...actual,
		ConnectionApplicationService: class extends actual.ConnectionApplicationService {
			constructor(
				...args: ConstructorParameters<
					typeof actual.ConnectionApplicationService
				>
			) {
				super(...args);
				captured.oauth = args[2];
			}
		},
	};
});

// Exercise the actual startup composition; no LDAP, database or Provider traffic.
vi.mock("@agent-infra/openconnector-adapter/provider-fetch", () => ({
	createPinnedProviderFetch: (options: { origins: string[] }) => {
		captured.origins.push(options.origins);
		return {
			close: async () => {},
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (
					!options.origins.some(
						(origin) => new URL(origin).origin === new URL(url).origin,
					)
				)
					throw new Error("Provider origin is not allowed");
				captured.requests.push(url);
				return init?.method === "POST"
					? Response.json({
							access_token: "synthetic-token",
							token_type: "bearer",
							scope: "read:user",
						})
					: Response.json({ id: 42, login: "synthetic-user" });
			},
		};
	},
}));

const environment = {
	DATABASE_URL: "postgresql://synthetic:synthetic@database.invalid/test",
	CONNECTION_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString("base64"),
	CONNECTION_IDENTITY_KEY: Buffer.alloc(32, 7).toString("base64"),
	CONNECTION_IDENTITY_REALM: "urn:connection:wiring-test",
	CONNECTION_DIRECT_CONSUMER_ID: "consumer-codex",
	CONNECTION_DIRECT_CONSUMER_NAME: "Codex",
	CONNECTION_PUBLIC_BASE_URL: "https://connection.example",
	LDAP_DISPLAY_NAME_ATTRIBUTE: "sn",
	LDAP_EMAIL_ATTRIBUTE: "uid",
	LDAP_ISSUER: "urn:connection:identity:test",
	LDAP_SERVICE_BIND_DN: "cn=synthetic,dc=example",
	LDAP_SERVICE_BIND_PASSWORD: "synthetic-password",
	LDAP_UID_ATTRIBUTE: "uid",
	LDAP_URL: "ldap://directory.invalid:389",
	LDAP_USERNAME_ATTRIBUTE: "cn",
	LDAP_USERS_BASE_DN: "dc=example",
	GITHUB_OAUTH_CLIENT_ID: "synthetic-client",
	GITHUB_OAUTH_CLIENT_SECRET: "synthetic-secret",
	JIRA_TOKEN_CLIENT_ID: "synthetic-client",
	JIRA_TOKEN_CLIENT_SECRET: "synthetic-secret",
	JIRA_TOKEN_PASSWORD: "synthetic-password",
	JIRA_TOKEN_SERVER_URL: "https://oauth.agoralab.co/oauth/token",
	JIRA_TOKEN_USERNAME: "synthetic-user",
	JENKINS_CI_TOKEN_CLIENT_ID: "synthetic-client",
	JENKINS_CI_TOKEN_CLIENT_SECRET: "synthetic-secret",
	JENKINS_CI_TOKEN_PASSWORD: "synthetic-password",
	JENKINS_CI_TOKEN_USERNAME: "synthetic-user",
	MANHATTAN_KONG_API_KEY: "synthetic-key",
	MANHATTAN_OAUTH_CLIENT_ID: "synthetic-client",
	MANHATTAN_OAUTH_CLIENT_SECRET: "synthetic-secret",
	DATALEGO_OAUTH_CLIENT_ID: "synthetic-client",
	DATALEGO_OAUTH_CLIENT_SECRET: "synthetic-secret",
	REHOBOAM_KONG_API_KEY: "synthetic-key",
};

afterEach(() => {
	captured.oauth = undefined;
	captured.requests = [];
	captured.origins = [];
	vi.restoreAllMocks();
});

describe("production GitHub OAuth transport wiring", () => {
	for (const tokenUrl of [
		undefined,
		"https://approved-token.example/oauth/token",
	]) {
		it(`exchanges at the effective ${tokenUrl ? "configured" : "default"} token endpoint without bypassing its origin policy`, async () => {
			vi.spyOn(console, "info").mockImplementation(() => {});
			const runtime = await createConnectionRuntime({
				...environment,
				...(tokenUrl ? { GITHUB_OAUTH_TOKEN_URL: tokenUrl } : {}),
			});
			try {
				if (!captured.oauth) throw new Error("OAuth Adapter was not assembled");
				expect(captured.origins.flat()).not.toContain(
					"https://publish-static-spaces.sh3.agoralab.co",
				);
				expect(captured.origins.flat()).not.toContain(
					"https://auth-static-spaces.sh3.agoralab.co",
				);
				const identity = await captured.oauth.exchangeCode({
					code: "synthetic-code",
					codeVerifier: "synthetic-verifier",
					redirectUri: "https://connection.example/oauth/callback",
				});
				expect(identity.externalAccount).toBe("42");
				expect(captured.requests).toEqual([
					tokenUrl ?? "https://github.com/login/oauth/access_token",
					"https://api.github.com/user",
				]);
			} finally {
				await runtime.closeProviderTransports();
			}
		});
	}
});
