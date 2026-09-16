import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createSecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import postgres from "postgres";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { assembleWecomSetupApiV1 } from "../../../apps/platform-api/src/wecom-setup-assembly.ts";
import { createWecomSetupWorkerV1 } from "../../../apps/platform-worker/src/wecom-setup.ts";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import { PostgresAgentConfigurationQueryV1 } from "./agent-configuration.ts";
import { PostgresPlatformAuditQueryV1 } from "./audit.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import { startPostgresTestDatabase } from "./postgres-test.ts";
import { PostgresWecomSetupV1 } from "./wecom-setup.ts";

it.each(["success", "revoked", "wrong-secret", "stale-config"] as const)(
	"manual onboarding %s uses Worker authentication and the existing configuration authority",
	async (mode) => {
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
		server.on("connection", (socket) =>
			socket.on("message", (raw) => {
				const frame = JSON.parse(raw.toString());
				if (frame.cmd !== "aibot_subscribe") return;
				authFrames++;
				if (mode === "revoked") active = false;
				socket.send(
					JSON.stringify({
						headers: frame.headers,
						errcode: mode === "wrong-secret" ? 40014 : 0,
					}),
				);
			}),
		);
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
		const worker = createWecomSetupWorkerV1({
			...db,
			directory,
			decryptor: createSecretKeyringDecryptorV1({
				keys: [
					{
						keyVersion: "fixture",
						privateKeyPkcs8DerBase64: pair.privateKey
							.export({ format: "der", type: "pkcs8" })
							.toString("base64"),
					},
				],
			}),
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
			await api.setup.submit(
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
			await worker.tick();
			const saved = await store.read(session.sessionId);
			expect(saved?.status).toBe(
				mode === "success"
					? "active"
					: mode === "wrong-secret"
						? "auth_failed"
						: "conflict",
			);
			expect(authFrames).toBe(mode === "stale-config" ? 0 : 1);
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
					bindingReference:
						mode === "success" ? session.sessionId : "old-binding",
				},
			]);
			expect(current.configuration.revision).toBe(mode === "success" ? 2 : 1);
			expect(JSON.stringify(saved)).not.toContain("fixture-secret");
			expect(
				await sql`select secret_id from platform.secret_records`,
			).toHaveLength(0);
			const page = await audits.listAudit(
				{ schemaVersion: 1, kind: "administrator", administratorId: "admin" },
				{ schemaVersion: 1, limit: 100 },
			);
			expect(
				page.items.some((row) => row.action === "wecom.credentials_submitted"),
			).toBe(true);
			if (mode !== "success")
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
