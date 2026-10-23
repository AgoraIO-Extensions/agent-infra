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
/** 带 Agent 默认 Relay Key 的标准 Agent 持久化为 V3：模型选项不含任何凭证（#2430）。 */
function keylessFixture() {
	const model = fixture.modelConfiguration;
	if (!model) throw new Error("fixture model missing");
	return {
		...structuredClone(fixture),
		schemaVersion: 3,
		modelConfiguration: {
			...structuredClone(model),
			options: model.options.map(({ credential: _credential, ...option }) =>
				structuredClone(option),
			),
		},
	};
}
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
let probeStatus = 200;
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
	// 保存时的真实验证请求（ADR-0029）：成功时返回一次完成的工具调用。
	if (String(url).endsWith("/responses"))
		return probeStatus === 200
			? new Response(
					`data: ${JSON.stringify({
						type: "response.completed",
						response: {
							output: [
								{
									type: "function_call",
									name: "agent_infra_conformance",
									arguments: "{}",
									status: "completed",
								},
							],
						},
					})}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				)
			: Response.json({}, { status: probeStatus });
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
		reasoningLevels: ["low"],
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
	probeStatus = 200;
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
	await sql`insert into platform.agent_owners (agent_id, owner_id, created_at) values ('agent_01', 'owner_01', now())`;
	await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at, configuration) values ('agent_01', 7, 'template_01', now(), ${sql.json(fixture as unknown as postgres.JSONValue)})`;
	const keys = createAgentDefaultRelayKeyUseCaseV1({
		transaction: store,
		currentIdentity: async () => ({
			userId: "owner_01",
			accountStatus: identityActive ? "active" : "disabled",
			authorizationRevision: "auth-1",
		}),
		encrypt: (binding, keyValue) =>
			encryptor.encrypt({ ...binding, plaintext: keyValue }),
		...createAgentDefaultRelayKeyCandidatesV1({
			relayEndpointId: "endpoint_01",
			relayBaseUrl: "https://relay.example.test/v1",
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
					// 推理档位是平台固定集合，不取端点或模板配置（ADR-0029）。
					reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
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
	it("verifies every saved pair with the new Key before replacing it", async () => {
		expect((await request("PUT", command())).status).toBe(200);
		const probes = fetcher.mock.calls.filter(([url]) =>
			String(url).endsWith("/responses"),
		);
		// 每个已保存的模型与档位组合都用新 Key 发一次真实验证请求（ADR-0029）。
		expect(
			probes.map(([, init]) => {
				const body = JSON.parse(String(init?.body));
				return { model: body.model, effort: body.reasoning.effort };
			}),
		).toEqual(
			fixture.modelConfiguration?.options.flatMap((option) =>
				option.reasoningLevels.map((effort) => ({
					model: option.modelId,
					effort,
				})),
			),
		);
		expect(
			probes.map(([, init]) => new Headers(init?.headers).get("authorization")),
		).toEqual(probes.map(() => `Bearer ${key}`));
	});
	it.each([
		"stale configuration",
		"template changed",
		"Key rejected",
		"Relay unavailable",
		"identity revoked",
		"nonowner",
		"missing Agent",
		"failed verification",
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
		// 已保存的组合用新 Key 真实验证失败（ADR-0029）。
		if (mode === "failed verification") probeStatus = 400;
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

/** 标准申请产生的 V3 配置与 V2 共用同一套默认 Key 授权与事务（#2430）。 */
describe("keyless (V3) Agent default Relay Key HTTP and PostgreSQL authority", () => {
	beforeEach(async () => {
		// 外层 beforeEach 先写入 V2 夹具；这里把同一修订改写为 V3，其余数据完全相同。
		await sql`update platform.agent_configuration_revisions set configuration = ${sql.json(keylessFixture() as unknown as postgres.JSONValue)} where agent_id = 'agent_01' and revision = 7`;
	});
	it("reads the unset state, previews candidates and persists nothing", async () => {
		const state = await request("GET");
		expect(state.status).toBe(200);
		expect(await state.json()).toEqual({
			schemaVersion: 1,
			isSet: false,
			keyVersion: null,
			configurationRevision: 7,
		});
		const preview = await request(
			"POST",
			{ keyValue: key, configurationRevision: 7 },
			"owner_01",
			"/candidates",
		);
		expect(preview.status).toBe(200);
		expect(await preview.json()).toEqual({
			schemaVersion: 1,
			configurationRevision: 7,
			candidates: [
				{
					endpointId: "endpoint_01",
					modelId: "gpt-5",
					// 推理档位是平台固定集合，不取端点或模板配置（ADR-0029）。
					reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
				},
			],
		});
		expect(await sql`select * from platform.relay_key_versions`).toHaveLength(
			0,
		);
	});
	it("replaces the Key without touching the V3 configuration record", async () => {
		const before =
			await sql`select revision, configuration from platform.agent_configuration_revisions where agent_id = 'agent_01'`;
		expect(before[0]?.configuration.schemaVersion).toBe(3);
		const first = await request("PUT", command());
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			schemaVersion: 1,
			isSet: true,
			keyVersion: 1,
			configurationRevision: 7,
		});
		expect((await request("PUT", command(1, key2))).status).toBe(200);
		// 替换只推进 Key 版本：配置修订、版本与内容都不变，也不含任何 Key 材料。
		const after =
			await sql`select revision, configuration from platform.agent_configuration_revisions where agent_id = 'agent_01'`;
		expect(after).toEqual(before);
		expect(JSON.stringify(after)).not.toContain(key);
		const state = await request("GET");
		expect(await state.json()).toEqual({
			schemaVersion: 1,
			isSet: true,
			keyVersion: 2,
			configurationRevision: 7,
		});
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
	});
	it.each([
		["stale configuration", 409],
		["template changed", 503], // 模板不再有候选绑定：与 V2 一致，按依赖不可用处理
		["nonowner", 404],
		["disabled owner", 404],
		["missing Agent", 404],
		["model not covered by the Key", 400],
	] as const)(
		"rejects %s with %i and leaves the Key unchanged",
		async (mode, status) => {
			if (mode === "stale configuration")
				// 真实的新修订：配置已前进到 8，调用方仍按 7 提交。
				await sql.begin(async (tx) => {
					await tx`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at, configuration) select agent_id, 8, source_reference, now(), jsonb_set(configuration, '{revision}', '8') from platform.agent_configuration_revisions where agent_id = 'agent_01' and revision = 7`;
					await tx`update platform.agents set current_configuration_revision = 8 where id = 'agent_01'`;
				});
			if (mode === "template changed")
				await sql`update platform.agent_configuration_revisions set configuration = jsonb_set(configuration, '{source,templateId}', '"other-template"')`;
			if (mode === "disabled owner")
				await sql`insert into platform.platform_user_disables (user_id) values ('owner_01')`;
			if (mode === "model not covered by the Key") visible = ["outside-policy"];
			const agentId = mode === "missing Agent" ? "absent" : "agent_01";
			const actor = mode === "nonowner" ? "other" : "owner_01";
			const response = await request("PUT", command(), actor, "", agentId);
			expect(response.status).toBe(status);
			expect(await response.text()).not.toContain(key);
			expect(await sql`select * from platform.relay_key_versions`).toHaveLength(
				0,
			);
			// 读取接口对同一调用方同样不可见，不泄露任何状态。
			if (status === 404)
				expect(
					(await request("GET", undefined, actor, "", agentId)).status,
				).toBe(404);
		},
	);
});
