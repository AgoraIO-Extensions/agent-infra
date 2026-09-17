import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createSecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import postgres from "postgres";
import { expect, it, vi } from "vitest";
import { createPlatformHealthApp } from "../../../apps/platform-api/src/app.ts";
import { registerWecomRoutesV1 } from "../../../apps/platform-api/src/http/wecom-routes.ts";
import { registerWecomSetupRoutesV1 } from "../../../apps/platform-api/src/http/wecom-setup-routes.ts";
import { assembleWecomSetupApiV1 } from "../../../apps/platform-api/src/wecom-setup-assembly.ts";
import { createWecomSetupWorkerV1 } from "../../../apps/platform-worker/src/wecom-setup.ts";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import { createWecomAdapterV1 } from "../../wecom/src/index.ts";
import { wecomCallbackFixtureV1 } from "../../wecom/src/testing.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import { startPostgresTestDatabase } from "./postgres-test.ts";
import { PostgresWecomSetupV1 } from "./wecom-setup.ts";

it.each([
	"success",
	"wrong-secret",
	"revoked",
	"expired",
	"cancelled",
	"conflict",
])(
	"application onboarding %s requires app authentication AND callback verification",
	async (mode) => {
		const db = await startPostgresTestDatabase("wecom-app");
		const sql = postgres(db.databaseUrl);
		const store = new PostgresWecomSetupV1(db);
		let active = true;
		const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
		const der = pair.publicKey.export({ format: "der", type: "spki" });
		const encryptionKeys = {
			schemaVersion: 1,
			activeWrappingKeyVersion: "fixture",
			keys: [
				{
					schemaVersion: 1,
					keyVersion: "fixture",
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
					publicKeySpkiDerBase64: der.toString("base64"),
					publicKeyFingerprint: createHash("sha256").update(der).digest("hex"),
					rsaModulusBits: 3072,
					status: "active",
				},
			],
		};
		const decryptor = createSecretKeyringDecryptorV1({
			keys: [
				{
					keyVersion: "fixture",
					privateKeyPkcs8DerBase64: pair.privateKey
						.export({ format: "der", type: "pkcs8" })
						.toString("base64"),
				},
			],
		});

		const directory = {
			async resolveUser(userId: string) {
				return {
					schemaVersion: 1,
					userId,
					accountStatus: active ? "active" : "disabled",
					organizationIds: [],
					authorizationRevision: "identity",
				};
			},
		};
		const identity = {
			...directory,
			resolve: async () => ({
				schemaVersion: 1,
				userId: "owner",
				displayName: "Owner",
				accountStatus: "active",
				organizationIds: [],
				roles: ["employee"],
				authorizationRevision: "identity",
			}),
			hydrateUsers: async () => [],
		};
		const api = assembleWecomSetupApiV1({
			...db,
			identity,
			encryptionKeys,
			application: {
				publicOrigin: "https://platform.test",
				callbackKeys: {
					activeKeyId: "callback",
					keys: [
						{ id: "callback", keyBase64: randomBytes(32).toString("base64") },
					],
				},
			},
		});
		const applicationFetch = vi.fn<typeof fetch>(async (input) => {
			const url = new URL(String(input));
			if (url.pathname === "/cgi-bin/gettoken")
				return Response.json(
					mode === "wrong-secret"
						? { errcode: 40001 }
						: { errcode: 0, access_token: "fixture-access" },
				);
			if (url.pathname === "/cgi-bin/agent/get") {
				if (mode === "revoked") active = false;
				return Response.json({ errcode: 0, agentid: 7 });
			}
			throw new Error("Unexpected network operation");
		});
		const worker = createWecomSetupWorkerV1({
			...db,
			directory,
			decryptor,
			applicationFetch,
			protectReply: async () => "fixture",
			revealReply: async () => {
				throw new Error("unused");
			},
		});
		try {
			await migratePlatformDatabase(db);
			const configuration = {
				...agentConfigurationConformanceRecordV1,
				agentId: "agent",
				revision: 1,
				channels: [{ kind: "wecom_app", bindingReference: "old-binding" }],
			};
			await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values ('agent',1,'authorization')`;
			await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,desired_state,service_availability,workload_revision,fence) values ('application','agent','owner','Fixture','Fixture','available','trace','request',now(),1,1,'running','ready',1,1)`;
			await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values ('agent','owner',now())`;
			await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values ('agent',1,'template_01',${sql.json(configuration as unknown as postgres.JSONValue)},now())`;

			const app = createPlatformHealthApp();
			registerWecomSetupRoutesV1(app, {
				identity,
				setup: api.setup,
				application: true,
				callbackUrl: api.callbackUrl,
			});
			const receive = vi.fn(async () => ({ outcome: "unavailable" as const }));
			registerWecomRoutesV1(app, {
				resolveBinding: api.resolveApplication,
				adapter: createWecomAdapterV1({ protectReply: async () => "fixture" }),
				verifyCallback: api.verifyCallback,
				acceptMessages: api.isActive,
				channel: { receive },
				receipts: {
					read: async () => null,
					list: async () => ({ items: [], nextCursor: null }),
					abandon: async () => false,
				},
				observe: () => {},
			});
			const begun = await app.request("/api/v1/agents/agent/wecom-app-setup", {
				method: "POST",
			});
			expect(begun.status).toBe(200);
			const session = (await begun.json()) as {
				sessionId: string;
				state: string;
				callbackUrl: string;
			};
			expect(session.callbackUrl).toBe(
				`https://platform.test/callbacks/wecom/${session.sessionId}`,
			);
			const credential = {
				state: session.state,
				corporationId: "corp",
				applicationId: "7",
				secret: "fixture-app-secret",
				token: "fixture-app-token",
				encodingAesKey: randomBytes(32).toString("base64").slice(0, 43),
			};
			const submitted = await app.request(
				`/api/v1/agents/agent/wecom-app-setup/${session.sessionId}/credentials`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(credential),
				},
			);
			expect(submitted.status).toBe(200);
			await expect(
				api.setup.read("agent", "other-owner", session.sessionId),
			).rejects.toThrow("unavailable");
			await expect(
				api.setup.read("other-agent", "owner", session.sessionId),
			).rejects.toThrow("unavailable");
			await worker.tick();
			expect(applicationFetch).not.toHaveBeenCalled();
			expect((await store.read(session.sessionId))?.status).toBe("verifying");
			const callback = await api.resolveApplication(session.sessionId);
			if (!callback) throw new Error("Missing callback configuration");
			const premature = wecomCallbackFixtureV1(
				callback,
				`<xml><ToUserName>corp</ToUserName><FromUserName>sender</FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType>text</MsgType><Content>fixture</Content><MsgId>42</MsgId><AgentID>7</AgentID></xml>`,
				new Date(),
			);
			expect((await app.request(premature)).status).toBe(503);
			expect(receive).not.toHaveBeenCalled();
			const recover = await app.request("/api/v1/agents/agent/wecom-app");
			expect(await recover.json()).toMatchObject({
				status: "verifying",
				sessionId: session.sessionId,
				callbackUrl: session.callbackUrl,
			});

			const envelope = wecomCallbackFixtureV1(
				callback,
				"challenge",
				new Date(),
			);
			const body = await envelope.text();
			const encrypted = body.match(/<Encrypt>(.*?)<\/Encrypt>/)?.[1];
			if (!encrypted) throw new Error("Missing fixture ciphertext");
			const url = new URL(envelope.url);
			url.searchParams.set("echostr", encrypted);
			const invalid = new URL(url);
			invalid.searchParams.set("msg_signature", "wrong");
			expect((await app.request(invalid.href)).status).toBe(400);
			expect(
				(await store.read(session.sessionId))?.callbackVerifiedAt,
			).toBeNull();
			expect((await app.request(url.href)).status).toBe(200);
			const saved = await store.read(session.sessionId);
			expect(saved?.callbackVerifiedAt).toBeTruthy();
			expect(JSON.stringify(saved)).not.toContain(credential.secret);
			expect(JSON.stringify(saved)).not.toContain(credential.token);
			expect(JSON.stringify(saved)).not.toContain(credential.encodingAesKey);

			if (mode === "success") {
				for (let i = 0; i < 25; i++)
					await sql`insert into platform.wecom_setup_sessions (session_id,agent_id,actor_id,configuration_revision,authorization_revision,state_digest,expires_at,status,kind,bot_id) values (${`waiting-${i}`},'agent','owner',1,'authorization','digest',now()+interval '1 minute','verifying','wecom_app',${`waiting-provider-${i}`})`;
			}

			if (mode === "expired")
				await sql`update platform.wecom_setup_sessions set expires_at=now()-interval '1 second' where session_id=${session.sessionId}`;
			if (mode === "cancelled")
				await api.setup.cancel("agent", "owner", session.sessionId);
			if (mode === "conflict")
				await sql`update platform.agents set authorization_revision='new' where id='agent'`;
			await worker.tick();
			const final = await store.read(session.sessionId);
			expect(final?.status).toBe(
				mode === "success"
					? "active"
					: mode === "wrong-secret"
						? "auth_failed"
						: mode === "expired"
							? "expired"
							: mode === "cancelled"
								? "cancelled"
								: "conflict",
			);
			const [current] =
				await sql`select current_configuration_revision as revision from platform.agents where id='agent'`;
			expect(Number(current?.revision)).toBe(mode === "success" ? 2 : 1);
			if (mode !== "success") {
				expect(final?.encryptedCallback).toBeNull();
				expect(final?.encryptedCredential).toBeNull();
				expect(await api.resolveApplication(session.sessionId)).toBeNull();
			}
			expect(receive).not.toHaveBeenCalled();
		} finally {
			await worker.close();
			await api.close();
			await store.close();
			await sql.end();
			await db.stop();
		}
	},
);
