import { createHash, generateKeyPairSync } from "node:crypto";
import { createAgentDefaultRelayKeyUseCaseV1 } from "@agent-infra/platform-core";
import { createRelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import { createRelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import { Hono } from "hono";
import postgres from "postgres";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import { PostgresAgentDefaultRelayKeyStoreV1 } from "../../../packages/platform-store/src/agent-default-relay-key.ts";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { readRelayKeyVersionInTransaction } from "../../../packages/platform-store/src/relay-key-versions.ts";
import { createAgentDefaultRelayKeyCandidatesV1 } from "./agent-default-relay-key-validation.ts";
import { registerAgentDefaultRelayKeyRoutes } from "./http/agent-default-relay-key-routes.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const fixture = structuredClone(agentConfigurationConformanceRecordV1);
const key = "SYNTHETIC_AGENT_DEFAULT_KEY_ONE";
const key2 = "SYNTHETIC_AGENT_DEFAULT_KEY_TWO";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 3072,
});
const publicDer = publicKey.export({ format: "der", type: "spki" });
const encryptionKeys = {
	schemaVersion: 1,
	activeWrappingKeyVersion: "test-key",
	keys: [
		{
			schemaVersion: 1,
			keyVersion: "test-key",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			publicKeySpkiDerBase64: publicDer.toString("base64"),
			publicKeyFingerprint: createHash("sha256")
				.update(publicDer)
				.digest("hex"),
			rsaModulusBits: 3072,
			status: "active",
		},
	],
};
const encryptor = createRelayKeyEncryptorV1({ encryptionKeys });
const decryptor = createRelayKeyWorkerDecryptorV1({
	keys: [
		{
			keyVersion: "test-key",
			privateKeyPkcs8DerBase64: privateKey
				.export({ format: "der", type: "pkcs8" })
				.toString("base64"),
		},
	],
});
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresAgentDefaultRelayKeyStoreV1;
let app: Hono;
let visible: string[];
let billingStatus = 200;
let modelStatus = 200;
let identityActive = true;
let duringModels: (() => Promise<void>) | undefined;
const fetcher = vi.fn<typeof fetch>(async (url) => {
	if (String(url).endsWith("/billing"))
		return Response.json(
			{
				object: "sub2api.key_billing",
				schema_version: 1,
				billing_scope: "token",
			},
			{ status: billingStatus },
		);
	await duringModels?.();
	return Response.json(
		{ data: visible.map((id) => ({ id })) },
		{ status: modelStatus },
	);
});
const catalog = () => ({
	schemaVersion: 1,
	revision: "catalog_3",
	validUntil: Date.now() + 60_000,
	endpoints: [
		{
			endpointId: "endpoint_01",
			baseUrl: "https://relay.example.test/v1",
			origin: "https://relay.example.test",
			protocol: "openai-responses-v1",
			security: { tls: "verify-peer", redirects: "reject" },
			capabilities: { streaming: true, tools: true, reasoningLevels: ["low"] },
			allowedModels: ["gpt-5", "gpt-other"],
			available: true,
		},
		{
			endpointId: "messages",
			baseUrl: "https://relay.example.test/messages/v1",
			origin: "https://relay.example.test",
			protocol: "anthropic-messages-v1",
			authentication: "api-key",
			security: { tls: "verify-peer", redirects: "reject" },
			capabilities: { streaming: true, tools: true, reasoningLevels: ["low"] },
			allowedModels: ["gpt-5"],
			available: true,
		},
	],
});
const bindings = [
	{
		templateId: "template_01",
		imageDigest: `sha256:${"a".repeat(64)}`,
		driver: "codex" as const,
		protocol: "openai-responses-v1" as const,
	},
];
function request(
	method: string,
	body?: unknown,
	actor = "owner_01",
	suffix = "",
	agentId = "agent_01",
) {
	return app.request(`/api/v2/agents/${agentId}/default-relay-key${suffix}`, {
		method,
		headers: { "Content-Type": "application/json", Cookie: actor },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
const command = (expectedVersion: number | null = null, keyValue = key) => ({
	keyValue,
	expectedVersion,
	configurationRevision: 7,
});

beforeAll(async () => {
	database = await startPostgresTestDatabase("issue-1260");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 4 });
	store = new PostgresAgentDefaultRelayKeyStoreV1({
		databaseUrl: database.databaseUrl,
	});
});
afterAll(async () => {
	await store?.close();
	await sql?.end();
	await database?.stop();
});
beforeEach(async () => {
	visible = ["gpt-5", "outside-policy"];
	billingStatus = 200;
	modelStatus = 200;
	identityActive = true;
	duringModels = undefined;
	fetcher.mockClear();
	await sql`delete from platform.relay_key_versions`;
	await sql`delete from platform.relay_key_subjects`;
	await sql`delete from platform.audit_events`;
	await sql`delete from platform.agent_owners`;
	await sql`delete from platform.agent_configuration_revisions`;
	await sql`delete from platform.agents`;
	await sql`delete from platform.platform_user_disables`;
	await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision) values ('agent_01', 7, 'auth-1')`;
	await sql`insert into platform.agent_owners (agent_id, owner_id) values ('agent_01', 'owner_01')`;
	await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, configuration) values ('agent_01', 7, 'template_01', ${sql.json(fixture as unknown as postgres.JSONValue)})`;
	const keys = createAgentDefaultRelayKeyUseCaseV1({
		transaction: store,
		currentIdentity: async () => ({
			userId: "owner_01",
			accountStatus: identityActive ? "active" : "disabled",
			authorizationRevision: "auth-1",
		}),
		encrypt: (binding, keyValue) =>
			encryptor.encrypt({ ...binding, plaintext: keyValue }),
		candidates: createAgentDefaultRelayKeyCandidatesV1({
			modelCatalog: { revision: "catalog_3", load: async () => catalog() },
			templateBindings: bindings,
			validation: {
				profile: "sub2api-key-billing-v1",
				billingUrl: "https://sub2api.la3.agoralab.co/v1/sub2api/billing",
				fetch: fetcher,
			},
		}),
	});
	app = new Hono();
	registerAgentDefaultRelayKeyRoutes(app, {
		keys,
		identity: {
			resolve: async (req) => ({
				schemaVersion: 1,
				userId: req.headers.get("Cookie") ?? "anonymous",
				displayName: "Test",
				accountStatus: "active",
				organizationIds: [],
				roles: ["employee"],
				authorizationRevision: "auth-1",
			}),
			hydrateUsers: async () => [],
		},
	});
});

describe("existing Agent default Relay Key HTTP and original PostgreSQL authority", () => {
	it("previews the Key/catalog/template intersection without persisting material", async () => {
		const response = await request(
			"POST",
			{ keyValue: key, configurationRevision: 7 },
			"owner_01",
			"/candidates",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			configurationRevision: 7,
			candidates: [
				{
					endpointId: "endpoint_01",
					modelId: "gpt-5",
					reasoningLevels: ["low"],
				},
			],
		});
		expect(await sql`select * from platform.relay_key_versions`).toHaveLength(
			0,
		);
		expect(fetcher.mock.calls.map(([url]) => url)).not.toContain(
			"https://relay.example.test/messages/v1/models",
		);
	});
	it("replaces one encrypted Agent Key, retains the original version and records versioned audit", async () => {
		const first = await request("PUT", command());
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			schemaVersion: 1,
			isSet: true,
			keyVersion: 1,
			configurationRevision: 7,
		});
		const [original] =
			await sql`select key_id from platform.relay_key_versions where key_version = 1`;
		expect((await request("PUT", command(1, key2))).status).toBe(200);
		const bound = {
			purpose: "agent-default" as const,
			subjectId: "agent_01",
			keyId: String(original?.key_id),
			keyVersion: 1,
		};
		const record = await sql.begin((tx) =>
			readRelayKeyVersionInTransaction(tx, bound),
		);
		expect(record).not.toBeNull();
		const decrypted = await decryptor.decrypt({
			encryptedRecord: record,
			expectedBinding: bound,
		});
		expect(decrypted.outcome).toBe("decrypted");
		if (decrypted.outcome === "decrypted") {
			expect(new TextDecoder().decode(decrypted.plaintext)).toBe(key);
			decrypted.plaintext.fill(0);
		}
		expect(
			await sql`select * from platform.relay_key_versions where purpose = 'personal'`,
		).toHaveLength(0);
		const audits =
			await sql`select details from platform.audit_events where action = 'relay_key.agent_default.replace' order by occurred_at`;
		expect(audits.map((row) => row.details)).toEqual([
			{
				schemaVersion: 1,
				configurationRevision: 7,
				previousVersion: null,
				keyVersion: 1,
			},
			{
				schemaVersion: 1,
				configurationRevision: 7,
				previousVersion: 1,
				keyVersion: 2,
			},
		]);
		expect(
			JSON.stringify(await sql`select * from platform.audit_events`),
		).not.toContain(key);
		const state = await request("GET");
		expect(state.headers.get("cache-control")).toBe("no-store");
		expect(await state.text()).not.toContain(key);
	});
	it("does not reuse preview acceptance after Relay visibility changes", async () => {
		expect(
			(
				await request(
					"POST",
					{ keyValue: key, configurationRevision: 7 },
					"owner_01",
					"/candidates",
				)
			).status,
		).toBe(200);
		visible = ["gpt-other"];
		expect((await request("PUT", command())).status).toBe(400);
		expect(await sql`select * from platform.relay_key_versions`).toHaveLength(
			0,
		);
	});
	it.each([
		"stale configuration",
		"template changed",
		"Key rejected",
		"Relay unavailable",
		"identity revoked",
		"nonowner",
		"missing Agent",
		"unsupported reasoning",
	])("rejects %s without changing the Key", async (mode) => {
		if (mode === "stale configuration")
			await sql`update platform.agents set current_configuration_revision = 8 where id = 'agent_01'`;
		if (mode === "template changed")
			await sql`update platform.agent_configuration_revisions set configuration = jsonb_set(configuration, '{source,templateId}', '"other-template"')`;
		if (mode === "Key rejected") billingStatus = 401;
		if (mode === "Relay unavailable") modelStatus = 503;
		if (mode === "identity revoked")
			duringModels = async () => {
				identityActive = false;
			};
		if (mode === "unsupported reasoning")
			await sql`update platform.agent_configuration_revisions set configuration = jsonb_set(jsonb_set(configuration, '{modelConfiguration,options,0,reasoningLevels}', '["high"]'), '{modelConfiguration,defaultReasoningLevel}', '"high"')`;
		const response = await request(
			"PUT",
			command(),
			mode === "nonowner" ? "other" : "owner_01",
			"",
			mode === "missing Agent" ? "absent" : "agent_01",
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(await response.text()).not.toContain(key);
		expect(await sql`select * from platform.relay_key_versions`).toHaveLength(
			0,
		);
	});
	it("serializes two replacements so only one expected version wins", async () => {
		const responses = await Promise.all([
			request("PUT", command()),
			request("PUT", command(null, key2)),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 409,
		]);
		expect(await sql`select * from platform.relay_key_versions`).toHaveLength(
			1,
		);
	});
	it("rolls back encryption and the pointer on audit failure, then retries cleanly", async () => {
		await sql`create function platform.fail_default_key_audit() returns trigger language plpgsql as $$ begin if NEW.action = 'relay_key.agent_default.replace' and NEW.outcome = 'succeeded' then raise exception 'controlled failure'; end if; return NEW; end $$`;
		await sql`create trigger fail_default_key_audit before insert on platform.audit_events for each row execute function platform.fail_default_key_audit()`;
		try {
			expect((await request("PUT", command())).status).toBe(503);
			expect(await sql`select * from platform.relay_key_versions`).toHaveLength(
				0,
			);
		} finally {
			await sql`drop trigger fail_default_key_audit on platform.audit_events`;
			await sql`drop function platform.fail_default_key_audit()`;
		}
		expect((await request("PUT", command())).status).toBe(200);
	});
});
