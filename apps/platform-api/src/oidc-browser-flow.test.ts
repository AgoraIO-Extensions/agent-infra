import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createOidcBrowserFlow,
	type OidcLoginTransaction,
} from "./oidc-browser-flow.js";

const issuer = "https://identity.example.test";
const origin = "https://platform.example.test";
const clientId = "platform";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = keys.publicKey.export({ format: "jwk" });
const segment = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");

async function journey(fault?: string) {
	let challenge = "";
	let nonce = "";
	const login = vi.fn(
		async () =>
			new Response(null, {
				status: 204,
				headers: {
					"set-cookie": "__Host-platform-session=sample; Secure; Path=/",
				},
			}),
	);
	const http = vi.fn(async (input: string, init: RequestInit) => {
		const url = new URL(input);
		expect(url.origin).toBe(issuer);
		switch (url.pathname) {
			case "/.well-known/openid-configuration":
				return Response.json({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					userinfo_endpoint: `${issuer}/userinfo`,
					jwks_uri: `${issuer}/keys`,
					id_token_signing_alg_values_supported: ["RS256"],
				});
			case "/keys":
				return Response.json({
					keys: [{ ...jwk, kid: "test-key", alg: "RS256" }],
				});
			case "/token": {
				const params = new URLSearchParams(String(init.body));
				expect(params.get("redirect_uri")).toBe(`${origin}/auth/oidc/callback`);
				expect(
					createHash("sha256")
						.update(params.get("code_verifier") ?? "")
						.digest("base64url"),
				).toBe(challenge);
				const now = Math.floor(Date.now() / 1000);
				const payload = {
					iss: fault === "issuer" ? origin : issuer,
					sub: "employee",
					aud: fault === "audience" ? "other" : clientId,
					exp: now + (fault === "expired" ? -600 : 300),
					iat: now,
					nonce: fault === "nonce" ? "other" : nonce,
					email: "owner@example.test",
					email_verified: true,
				};
				const signed = `${segment({ alg: "RS256", kid: "test-key" })}.${segment(payload)}`;
				const signature = sign(
					"RSA-SHA256",
					Buffer.from(fault === "signature" ? "other" : signed),
					keys.privateKey,
				).toString("base64url");
				return Response.json({
					access_token: "sample-token",
					token_type: "Bearer",
					id_token: `${signed}.${signature}`,
				});
			}
			case "/userinfo":
				return Response.json({
					sub: fault === "subject" ? "other" : "employee",
					email:
						fault === "email" ? "other@example.test" : "owner@example.test",
					email_verified: fault !== "unverified",
				});
			default:
				throw new Error("Unexpected OIDC endpoint");
		}
	});
	vi.stubGlobal("fetch", http);
	const tx = new Map<string, OidcLoginTransaction>();
	const flow = createOidcBrowserFlow({
		issuer,
		clientId,
		clientSecret: "fixture",
		publicOrigin: origin,
		login,
		transactions: {
			async put(k, v) {
				tx.set(k, v);
			},
			async take(k) {
				const value = tx.get(k);
				tx.delete(k);
				return value ?? null;
			},
		},
	});
	const start = await flow.handleRequest(
		new Request(`${origin}/auth/oidc/login`),
	);
	expect(start?.status).toBe(303);
	const authorize = new URL(start?.headers.get("Location") ?? "");
	expect(authorize.origin).toBe(issuer);
	expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
	challenge = authorize.searchParams.get("code_challenge") ?? "";
	nonce = authorize.searchParams.get("nonce") ?? "";
	const state = authorize.searchParams.get("state");
	const cookie = start?.headers.get("Set-Cookie")?.split(";")[0] ?? "";
	const callback = (sentCookie = cookie, sentState = state) =>
		flow.handleRequest(
			new Request(
				`${origin}/auth/oidc/callback?code=sample-code&state=${sentState}`,
				{ headers: { cookie: sentCookie } },
			),
		);
	return { callback, login };
}

afterEach(() => vi.unstubAllGlobals());

describe("OIDC browser code flow", () => {
	it("binds a signed response to the initiating browser and issues one session", async () => {
		const { callback, login } = await journey();
		expect((await callback(""))?.status).toBe(400);
		expect((await callback(undefined, "different"))?.status).toBe(400);
		const result = await callback();
		expect(result?.status).toBe(303);
		expect(result?.headers.get("Location")).toBe("/");
		expect(result?.headers.getSetCookie()[0]).toContain(
			"__Host-platform-session=",
		);
		expect(login).toHaveBeenCalledWith({
			issuer,
			subject: "employee",
			email: "owner@example.test",
			emailVerified: true,
		});
		expect((await callback())?.status).toBe(400);
		expect(login).toHaveBeenCalledTimes(1);
	});
	it.each([
		"signature",
		"issuer",
		"audience",
		"expired",
		"nonce",
		"subject",
		"email",
	])("rejects invalid %s", async (fault) => {
		const { callback, login } = await journey(fault);
		expect((await callback())?.status).toBe(401);
		expect(login).not.toHaveBeenCalled();
	});
	it("requires verification from both sources when both provide the email", async () => {
		const { callback, login } = await journey("unverified");
		await callback();
		expect(login).toHaveBeenCalledWith(
			expect.objectContaining({ emailVerified: false }),
		);
	});
});
