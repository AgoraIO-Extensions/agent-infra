import {
	createHash,
	generateKeyPairSync,
	randomBytes,
	sign,
} from "node:crypto";
import { request as httpRequest } from "node:http";
import { createSnapshot } from "@agent-infra/enterprise-directory";
import {
	migratePlatformDatabase,
	oidcBrowserSessionUidPrefix,
	PostgresLdapSessionStoreV1 as PostgresBrowserSessionStoreV1,
	PostgresOidcIdentityStore,
} from "@agent-infra/platform-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	openPostgresTestClient,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { loadPlatformApiAssembly, startPlatformApi } from "./index.js";
import { createPostgresOidcBrowserDeployment } from "./oidc-browser-deployment.js";
import { createOidcBrowserFlow } from "./oidc-browser-flow.js";
import { createOidcEmployeeDirectory } from "./oidc-employee-directory.js";

const issuer = "https://id.example.test";
const origin = "https://platform.example.test";
const clientId = "agentinfra";
const event = "http://schemas.openid.net/event/backchannel-logout";
const now = Math.floor(Date.now() / 1000);
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
	...keys.publicKey.export({ format: "jwk" }),
	kid: "logout",
	alg: "RS256",
};
const secret = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const enc = (v: unknown) =>
	Buffer.from(JSON.stringify(v)).toString("base64url");
function token(overrides: Record<string, unknown> = {}, badSignature = false) {
	const head = enc({ alg: "RS256", kid: "logout" });
	const body = enc({
		iss: issuer,
		aud: [clientId],
		iat: now,
		jti: "notice",
		sub: "employee",
		events: { [event]: {} },
		...overrides,
	});
	const signed = `${head}.${body}`;
	return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), badSignature ? secret : keys.privateKey).toString("base64url")}`;
}
function stubProvider() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL) => {
			switch (new URL(input).pathname) {
				case "/.well-known/openid-configuration":
					return Response.json({ issuer, jwks_uri: `${issuer}/keys` });
				case "/keys":
					return Response.json({ keys: [jwk] });
				default:
					throw Error();
			}
		}),
	);
}
function receiver() {
	stubProvider();
	const logout = vi.fn(
		async (_event: {
			issuer: string;
			subject: string;
			jti: string;
			issuedAt: number;
		}) => {},
	);
	const flow = createOidcBrowserFlow({
		issuer,
		publicOrigin: origin,
		clientId,
		clientSecret: "fixture",
		transactions: { put: vi.fn(), take: vi.fn() },
		login: vi.fn(),
		logout,
	});
	const request = (body: BodyInit) =>
		flow.handleRequest(
			new Request(`${origin}/auth/oidc/backchannel-logout`, {
				method: "POST",
				body,
				headers: { "content-type": "application/x-www-form-urlencoded" },
			}),
		);
	const deliver = (value: string) =>
		request(new URLSearchParams({ logout_token: value }));
	return { logout, deliver, request };
}
afterEach(() => vi.unstubAllGlobals());
describe("OIDC back-channel logout", () => {
	it("processes a verified subject notification without a browser session", async () => {
		const { logout, deliver } = receiver();
		expect((await deliver(token()))?.status).toBe(200);
		expect(logout).toHaveBeenCalledWith({
			issuer,
			subject: "employee",
			jti: "notice",
			issuedAt: now,
		});
	});
	it.each([
		["issuer", { iss: origin }],
		["audience", { aud: "different" }],
		["old iat", { iat: now - 601 }],
		["future iat", { iat: now + 600 }],
		["expiry", { exp: now - 1 }],
		["missing events", { events: undefined }],
		["invalid event", { events: { [event]: false } }],
		["nonce", { nonce: null }],
		["JTI", { jti: "" }],
		["sid-only", { sub: undefined, sid: "session" }],
	] as const)("rejects %s", async (_, claims) => {
		const { logout, deliver } = receiver();
		expect((await deliver(token(claims)))?.status).toBe(400);
		expect(logout).not.toHaveBeenCalled();
	});
	it("rejects a bad signature, duplicate fields, and oversized input", async () => {
		const { logout, request, deliver } = receiver();
		expect((await deliver(token({}, true)))?.status).toBe(400);
		expect(
			(
				await request(
					new URLSearchParams([
						["logout_token", token()],
						["logout_token", token()],
					]),
				)
			)?.status,
		).toBe(400);
		expect((await deliver("x".repeat(32769)))?.status).toBe(400);
		expect(logout).not.toHaveBeenCalled();
	});
	it("returns a retryable failure when the receipt transaction fails", async () => {
		const { logout, deliver } = receiver();
		logout.mockRejectedValueOnce(Error("storage unavailable"));
		const message = token();
		expect((await deliver(message))?.status).toBe(503);
		expect((await deliver(message))?.status).toBe(200);
	});
});

it("clears both employee cookies over HTTP and retains a later login and other employees", async () => {
	const httpFetch = globalThis.fetch;
	stubProvider();
	const db = await startPostgresTestDatabase("oidc-session-revocation");
	const sql = openPostgresTestClient(db);
	const store = new PostgresOidcIdentityStore(db.databaseUrl);
	const sessions = new PostgresBrowserSessionStoreV1(db.databaseUrl);
	try {
		await migratePlatformDatabase({ databaseUrl: db.databaseUrl });
		const snapshot = createSnapshot({
			rootDepartmentId: 1,
			startedAt: Date.now(),
			completedAt: Date.now(),
			departments: [{ id: 1, name: "Company", parentId: 0 }],
			members: ["employee", "peer"].map((userId) => ({
				userId,
				email: `${userId}@example.test`,
				active: true,
				departmentIds: [1],
			})),
		});
		const config = {
			issuer,
			clientId,
			clientSecret: "fixture",
			allowEmailLink: true,
		};
		const directory = createOidcEmployeeDirectory(config, store, {
			loadCurrent: async () => snapshot,
		});
		const proxyToken = randomBytes(32).toString("base64url");
		const deployment = createPostgresOidcBrowserDeployment({
			databaseUrl: db.databaseUrl,
			directory,
			publicOrigin: origin,
			trustedProxyToken: proxyToken,
			isPlatformDisabled: async () => false,
			organizationIds: async () => ["department"],
			oidc: { ...config, store, verifiedAccount: directory.verifiedAccount },
		});
		const assembly = await loadPlatformApiAssembly(
			new URL(
				"../../../tests/fixtures/platform-api-deployment.mjs",
				import.meta.url,
			).href,
		);
		const server = startPlatformApi({
			port: 0,
			log: () => {},
			dependencies: {
				...assembly.dependencies,
				sessionAudit: {
					...assembly.dependencies.sessionAudit,
					identity: deployment.identity,
				},
			},
			browserAuth: deployment.browserAuth,
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw Error("missing server address");
			const base = `http://127.0.0.1:${address.port}`;
			async function cookie(subject: string) {
				const account = await directory.verifiedAccount({
					issuer,
					subject,
					email: `${subject}@example.test`,
					emailVerified: true,
				});
				if (!account) throw Error("fixture account not bound");
				const value = randomBytes(32).toString("base64url");
				const expires = Date.now() + 60000;
				await sessions.create(
					createHash("sha256").update(value).digest("hex"),
					oidcBrowserSessionUidPrefix(issuer) + account.userId,
					expires,
					expires,
				);
				return `__Host-platform-session=${value}`;
			}
			const status = async (cookie: string) =>
				(await httpFetch(`${base}/api/v1/session`, { headers: { cookie } }))
					.status;
			const deliver = () =>
				new Promise<number | undefined>((resolve, reject) => {
					const req = httpRequest(
						`${base}/auth/oidc/backchannel-logout`,
						{
							method: "POST",
							headers: {
								host: new URL(origin).host,
								"x-forwarded-proto": "https",
								"x-platform-proxy-token": proxyToken,
								"content-type": "application/x-www-form-urlencoded",
							},
						},
						(res) => {
							res.resume();
							res.on("end", () => resolve(res.statusCode));
						},
					);
					req.on("error", reject);
					req.end(
						new URLSearchParams({
							logout_token: token(),
							sub: "peer",
						}).toString(),
					);
				});
			const first = await cookie("employee");
			const second = await cookie("employee");
			const peer = await cookie("peer");
			const actor = await store.findBySubject(issuer, "employee");
			if (!actor) throw Error("fixture owner missing");
			await sql`insert into platform.agents (id,authorization_revision) values ('agent','revision')`;
			await sql`insert into platform.conversations (id,agent_id,actor_id,channel_id,principal_type,status,session_generation,authorization_revision)
				values ('conversation','agent',${actor.userId},'web','user','active',1,'revision')`;
			await sql`insert into platform.conversation_executions (execution_id,conversation_id,agent_id,actor_id,channel_id,principal_type,turn_id,status,session_generation,authorization_revision,created_at)
				values ('run','conversation','agent',${actor.userId},'web','user','turn','processing',1,'revision',now())`;
			expect(await Promise.all([first, second, peer].map(status))).toEqual([
				200, 200, 200,
			]);
			expect(await deliver()).toBe(200);
			expect(await Promise.all([first, second, peer].map(status))).toEqual([
				401, 401, 200,
			]);
			const fresh = await cookie("employee");
			expect(await deliver()).toBe(200);
			expect(await status(fresh)).toBe(200);
			expect(
				await sql`select status from platform.conversation_executions where execution_id='run'`,
			).toEqual([{ status: "processing" }]);
			expect(
				await sql`select execution_id from platform.conversation_stops where execution_id='run'`,
			).toHaveLength(0);
			expect(
				(
					await directory.currentByUserId(
						(await store.findBySubject(issuer, "employee"))?.userId ?? "",
					)
				)?.accountStatus,
			).toBe("active");
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await assembly.close();
			await deployment.browserAuth.close();
		}
	} finally {
		await sql.end();
		await sessions.close();
		await store.close();
		await db.stop();
	}
}, 120000);
