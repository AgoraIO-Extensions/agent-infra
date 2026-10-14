import { describe, expect, it, vi } from "vitest";
import {
	browserAuthorizationRecoveryTarget,
	CompanyOAuthEntry,
} from "./company-oauth-entry";
import {
	type ConnectionOAuthRepository,
	ConnectionOAuthService,
} from "./oauth";

function service(origin = "https://connection.example") {
	return new ConnectionOAuthService({
		consumer: { id: "test", name: "Test" },
		directory: {
			authenticate: async () => {
				throw new Error("not used");
			},
			isActive: async () => true,
		},
		identityKey: Buffer.alloc(32, 17),
		identityRealm: "urn:test:browser",
		repository: {} as ConnectionOAuthRepository,
		resource: `${origin}/mcp`,
	});
}

describe("browser confirmation trust boundaries", () => {
	it("binds proof to cookie, purpose, context and origin and expires without identity access", () => {
		const oauth = service();
		const input = {
			nonce: "A".repeat(43),
			purpose: "oauth-login" as const,
			context: "request-a",
		};
		const { csrfToken } = oauth.createBrowserFormConfirmation(input);
		expect(() =>
			oauth.verifyBrowserFormConfirmation({ ...input, csrfToken }),
		).not.toThrow();
		for (const changed of [
			{ nonce: "B".repeat(43) },
			{ purpose: "browser-api" as const },
			{ context: "request-b" },
			{ nonce: undefined },
			{ csrfToken: `${csrfToken}x` },
		])
			expect(() =>
				oauth.verifyBrowserFormConfirmation({
					...input,
					csrfToken,
					...changed,
				}),
			).toThrow();
		expect(() =>
			service("https://other.example").verifyBrowserFormConfirmation({
				...input,
				csrfToken,
			}),
		).toThrow();
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
		try {
			expect(() =>
				oauth.verifyBrowserFormConfirmation({ ...input, csrfToken }),
			).toThrow();
		} finally {
			vi.restoreAllMocks();
		}
	});
	it("binds company callback proof to the original cookie/state and code", () => {
		const entry = new CompanyOAuthEntry({
			clientId: "test",
			identityKey: Buffer.alloc(32, 17),
			identityRealm: "urn:test",
			publicBaseUrl: "https://connection.example",
			readIdentity: async () => ({}),
			commands: { execute: async (_input, command) => command() },
		});
		const recovery = `/oauth/authorization-requests/${"A".repeat(43)}`;
		const { state } = entry.start(recovery);
		const csrfToken = entry.createCallbackConfirmation(state, state, "code-a");
		expect(() =>
			entry.verifyCallbackConfirmation({
				state,
				cookie: state,
				code: "code-a",
				csrfToken,
			}),
		).not.toThrow();
		for (const changed of [
			{ code: "code-b" },
			{ cookie: undefined },
			{ cookie: entry.start().state },
			{ state: entry.start().state },
			{ csrfToken: `${csrfToken}x` },
		]) {
			expect(() =>
				entry.verifyCallbackConfirmation({
					state,
					cookie: state,
					code: "code-a",
					csrfToken,
					...changed,
				}),
			).toThrow();
		}
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
		try {
			expect(entry.recoveryTarget(state)).toBe(recovery);
			expect(() =>
				entry.verifyCallbackConfirmation({
					state,
					cookie: state,
					code: "code-a",
					csrfToken,
				}),
			).toThrow();
		} finally {
			vi.restoreAllMocks();
		}
	});
	it("recovers only original same-origin GET contexts, never credentials or arbitrary redirects", () => {
		const origin = "https://connection.example";
		const id = "A".repeat(43);
		expect(
			browserAuthorizationRecoveryTarget(
				`/oauth/login?request_id=${id}&password=must-not-copy`,
				origin,
			),
		).toBe(`/oauth/authorization-requests/${id}`);
		expect(
			browserAuthorizationRecoveryTarget(
				`/connection/pat-bindings/confirm?flow=conn_pat_binding_${id}`,
				origin,
			),
		).toBe(`/connection/pat-bindings/conn_pat_binding_${id}`);
		for (const value of [
			`https://evil.example/oauth/login?request_id=${id}`,
			`//evil.example/oauth/login?request_id=${id}`,
			`/oauth/login?request_id=${id}&request_id=${id}`,
			`/oauth/login?request_id=${id}#fragment`,
			"/api/v1/connection/tokens",
			"/oauth/login?request_id=short",
		])
			expect(browserAuthorizationRecoveryTarget(value, origin)).toBeUndefined();
	});
});
