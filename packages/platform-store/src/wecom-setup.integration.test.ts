import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createSecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import postgres from "postgres";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { assembleWecomSetupApiV1 } from "../../../apps/platform-api/src/wecom-setup-assembly.ts";
import { createWecomSetupWorkerV1 } from "../../../apps/platform-worker/src/wecom-setup.ts";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import { PostgresAgentConfigurationQueryV1 } from "./agent-configuration.ts";
import { PostgresPlatformAuditQueryV1 } from "./audit.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import { startPostgresTestDatabase } from "./postgres-test.ts";
import { PostgresWecomSetupV1 } from "./wecom-setup.ts";

it.each([
	"success",
	"probe-closed",
	"concurrent-submit",
	"revoked",
	"wrong-secret",
	"stale-config",
	"timeout",
	"activation-unavailable",
	"commit-unavailable",
] as const)(
	"manual onboarding %s uses Worker authentication and the existing configuration authority",
	async (mode) => {
		const recovers = [
			"timeout",
			"activation-unavailable",
			"commit-unavailable",
		].includes(mode);
		const succeeds =
			["success", "probe-closed", "concurrent-submit"].includes(mode) ||
			recovers;
		const db = await startPostgresTestDatabase("wecom-setup");
		const sql = postgres(db.databaseUrl);
		const store = new PostgresWecomSetupV1(db);
		const query = new PostgresAgentConfigurationQueryV1(db);
		const audits = new PostgresPlatformAuditQueryV1(db);
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No address");
		let active = true;
		let authFrames = 0;
		let probeClosed = false;
		let dependencyUnavailable = mode === "activation-unavailable";
		server.on("connection", (socket) => {
			socket.on("close", () => {
				probeClosed = true;
			});
			socket.on("message", (raw) => {
				const frame = JSON.parse(raw.toString());
				if (frame.cmd !== "aibot_subscribe") return;
				authFrames++;
				if (mode === "timeout" && authFrames === 1) return;
				if (mode === "revoked") active = false;
				socket.send(
					JSON.stringify({
						headers: frame.headers,
						errcode: mode === "wrong-secret" ? 40014 : 0,
					}),
				);
			});
		});
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
		const directory = {
			async resolveUser(userId: string) {
				if (mode === "probe-closed" && authFrames > 0)
					await expect.poll(() => probeClosed, { timeout: 1000 }).toBe(true);
				if (dependencyUnavailable && authFrames > 0)
					throw new Error("Identity dependency unavailable");
				return {
					schemaVersion: 1,
					userId,
					accountStatus: active ? "active" : "disabled",
					organizationIds: [],
					authorizationRevision: "identity",
				};
			},
		};
		const api = assembleWecomSetupApiV1({
			...db,
			encryptionKeys,
			identity: {
				...directory,
				resolve: async () => null,
				hydrateUsers: async () => [],
			},
		});
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
		const decrypt = vi.fn(decryptor.decrypt);
		const worker = createWecomSetupWorkerV1({
			...db,
			directory,
			decryptor: { decrypt },
			endpoint: `ws://127.0.0.1:${address.port}`,
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
				channels: [{ kind: "wecom_bot", bindingReference: "old-binding" }],
			};
			await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values ('agent',1,'authorization')`;
			await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,desired_state,service_availability,workload_revision,fence) values ('application','agent','owner','Fixture','Fixture','available','trace','request',now(),1,1,'running','ready',1,1)`;
			await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values ('agent','owner',now())`;
			await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values ('agent',1,'template_01',${sql.json(configuration as unknown as postgres.JSONValue)},now())`;
			const session = await api.setup.begin("agent", "owner");
			const submit = () =>
				api.setup.submit(
					{
						agentId: "agent",
						sessionId: session.sessionId,
						state: session.state,
						botId: "fixture-bot",
						secret: "fixture-secret",
						takeoverConfirmed: true,
					},
					"owner",
				);
			if (mode === "concurrent-submit") {
				const results = await Promise.allSettled([submit(), submit()]);
				expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
				expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
			} else await submit();
			await expect(
				api.setup.submit(
					{
						agentId: "agent",
						sessionId: session.sessionId,
						state: session.state,
						botId: "fixture-bot",
						secret: "fixture-secret",
						takeoverConfirmed: true,
					},
					"owner",
				),
			).rejects.toThrow("unavailable");
			if (mode === "stale-config")
				await sql`update platform.agents set authorization_revision='updated' where id='agent'`;
			if (mode === "commit-unavailable")
				await sql`alter table platform.agent_configuration_revisions add constraint fixture_commit_unavailable check (revision < 2)`;
			if (recovers) {
				if (mode !== "timeout") await expect(worker.tick()).rejects.toThrow();
				else await worker.tick();
				const pending = await store.read(session.sessionId);
				expect(pending?.status).toBe("verifying");
				expect(pending?.encryptedCredential).toBeTruthy();
				dependencyUnavailable = false;
				if (mode === "commit-unavailable")
					await sql`alter table platform.agent_configuration_revisions drop constraint fixture_commit_unavailable`;
			}
			await worker.tick();
			const saved = await store.read(session.sessionId);
			expect(saved?.status).toBe(
				succeeds
					? "active"
					: mode === "wrong-secret"
						? "auth_failed"
						: "conflict",
			);
			expect(authFrames).toBe(mode === "stale-config" ? 0 : recovers ? 2 : 1);
			const current = await query.readAuthority({
				agentId: "agent",
				actorId: "owner",
				organizationIds: [],
				isAdministrator: false,
			});
			if (current.outcome !== "found")
				throw new Error("Missing current configuration");
			expect(current.configuration.channels).toEqual([
				{
					kind: "wecom_bot",
					bindingReference: succeeds ? session.sessionId : "old-binding",
				},
			]);
			expect(current.configuration.revision).toBe(succeeds ? 2 : 1);
			expect(JSON.stringify(saved)).not.toContain("fixture-secret");
			expect(
				await sql`select secret_id from platform.secret_records`,
			).toHaveLength(0);
			const page = await audits.listAudit(
				{ schemaVersion: 1, kind: "administrator", administratorId: "admin" },
				{ schemaVersion: 1, limit: 100 },
			);
			expect(
				page.items.filter(
					(row) => row.action === "wecom.credentials_submitted",
				),
			).toHaveLength(1);
			if (mode === "success") {
				const before = decrypt.mock.calls.length;
				expect(await worker.bindings()).toHaveLength(1);
				expect(await worker.bindings()).toHaveLength(1);
				expect(decrypt).toHaveBeenCalledTimes(before + 1);
				await sql`update platform.agent_configuration_revisions set configuration=jsonb_set(configuration,'{channels}','[]'::jsonb) where agent_id='agent' and revision=2`;
				expect(await worker.bindings()).toHaveLength(0);
				await sql`update platform.agent_configuration_revisions set configuration=jsonb_set(configuration,'{channels}',${sql.json([{ kind: "wecom_bot", bindingReference: session.sessionId }])}::jsonb) where agent_id='agent' and revision=2`;
				expect(await worker.bindings()).toHaveLength(1);
				expect(decrypt).toHaveBeenCalledTimes(before + 2);
				await sql`update platform.wecom_setup_sessions set encrypted_credential='{}'::jsonb where session_id=${session.sessionId}`;
				expect(await worker.bindings()).toHaveLength(0);
				await sql`update platform.wecom_setup_sessions set encrypted_credential=${sql.json(saved?.encryptedCredential as postgres.JSONValue)} where session_id=${session.sessionId}`;
				expect(await worker.bindings()).toHaveLength(1);
				expect(decrypt).toHaveBeenCalledTimes(before + 3);
			}

			if (!succeeds)
				expect(
					page.items.some((row) => row.action === "wecom.setup_failed"),
				).toBe(true);
		} finally {
			await worker.close();
			await api.close();
			await audits.close();
			await query.close();
			await store.close();
			await sql.end();
			for (const socket of server.clients) socket.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await db.stop();
		}
	},
	30000,
);

it("returns all current active bindings beyond the former 100-row limit", async () => {
	const db = await startPostgresTestDatabase("wecom-bindings");
	const sql = postgres(db.databaseUrl);
	const store = new PostgresWecomSetupV1(db);
	try {
		await migratePlatformDatabase(db);
		await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) select 'agent-'||i,1,'authorization' from generate_series(1,101) i`;
		await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) select 'agent-'||i,1,'template',jsonb_build_object('schemaVersion',2,'agentId','agent-'||i,'revision',1,'channels',jsonb_build_array(jsonb_build_object('kind','wecom_bot','bindingReference','session-'||i))),now() from generate_series(1,101) i`;
		await sql`insert into platform.wecom_setup_sessions (session_id,agent_id,actor_id,configuration_revision,authorization_revision,state_digest,expires_at,status,bot_id) select 'session-'||i,'agent-'||i,'owner',1,'authorization','digest',now(),'active','bot-'||i from generate_series(1,101) i`;
		const bindings = await store.bindings();
		expect(bindings).toHaveLength(101);
		expect(new Set(bindings.map((binding) => binding.agentId)).size).toBe(101);
		await sql`update platform.agent_configuration_revisions set configuration=jsonb_set(configuration,'{channels}','[]'::jsonb) where agent_id='agent-101'`;
		expect(await store.bindings()).toHaveLength(100);
	} finally {
		await store.close();
		await sql.end();
		await db.stop();
	}
});

it("selects unattempted setups before a released timeout and skips live probes", async () => {
	const db = await startPostgresTestDatabase("wecom-fairness");
	const sql = postgres(db.databaseUrl);
	const store = new PostgresWecomSetupV1(db);
	try {
		await migratePlatformDatabase(db);
		await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) select 'agent-'||i,1,'auth' from generate_series(1,2) i`;
		await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) select 'agent-'||i,'owner',now() from generate_series(1,2) i`;
		await sql`insert into platform.wecom_setup_sessions (session_id,agent_id,actor_id,configuration_revision,authorization_revision,state_digest,expires_at,status,bot_id) select 'session-'||i,'agent-'||i,'owner',1,'auth','digest',now()+i*interval '1 minute','verifying','bot-'||i from generate_series(1,2) i`;
		await sql`insert into platform.wecom_connections (bot_id,agent_id,binding_reference,holder_id,fence,lease_until,status) values ('bot-1','agent-1','session-1','worker',1,now()-interval '1 second','disconnected')`;
		expect((await store.candidates()).map((s) => s.sessionId)).toEqual([
			"session-2",
			"session-1",
		]);
		await sql`update platform.wecom_connections set lease_until=now()+interval '30 seconds' where bot_id='bot-1'`;
		expect((await store.candidates()).map((s) => s.sessionId)).toEqual([
			"session-2",
		]);
	} finally {
		await store.close();
		await sql.end();
		await db.stop();
	}
});
