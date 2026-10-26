import { createHash, generateKeyPairSync } from "node:crypto";
import { createAgentDefaultRelayKeyUseCaseV1 } from "@agent-infra/platform-core";
import { createRelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import { createRelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
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
import { PostgresAgentDefaultRelayKeyStoreV1 } from "../../../packages/platform-store/src/agent-default-relay-key.js";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createProductionSavedKeyCandidatesReaderV1 } from "./saved-key-candidates-production.js";

// ADR-0029：已保存 Key 的模型更新只把新增组合交给 Worker，用解密后的 Key 真实验证。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
const key = "SYNTHETIC_SAVED_DEFAULT_KEY";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 3072,
});
const publicDer = publicKey.export({ format: "der", type: "spki" });
const encryptor = createRelayKeyEncryptorV1({
	encryptionKeys: {
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
	},
});
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
// 带默认 Key 的标准 Agent 配置（V3）：模型选项不含任何凭证。
const source = {
	kind: "standard" as const,
	templateId: "template_01",
	imageDigest: `sha256:${"a".repeat(64)}`,
	admissionRevision: "image_policy_7",
	allowedEnvironmentKeys: ["LOG_LEVEL"],
	allowedSecretKeys: ["BOT_TOKEN"],
	platformManagedKeys: [],
	connectionEnabled: true,
};
const savedModel = "gpt-5";
const configuration = {
	schemaVersion: 3,
	agentId: "agent_01",
	revision: 7,
	source,
	modelConfiguration: {
		catalogRevision: "catalog_3",
		options: [
			{
				optionId: "model_primary",
				endpointId: "endpoint_01",
				modelId: savedModel,
				reasoningLevels: ["low"],
			},
		],
		defaultOptionId: "model_primary",
		defaultReasoningLevel: "low",
	},
	environment: [{ name: "LOG_LEVEL", value: "info" }],
	secrets: [],
	channels: [],
	channelRevision: "channels_1",
};
const completedToolCall = `data: ${JSON.stringify({
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
})}\n\n`;
let probeStatus = 200;
const fetcher = vi.fn<typeof fetch>(async (url) => {
	if (String(url).endsWith("/billing"))
		return Response.json({
			object: "sub2api.key_billing",
			schema_version: 1,
			billing_scope: "token",
		});
	if (String(url).endsWith("/responses"))
		return probeStatus === 200
			? new Response(completedToolCall, {
					headers: { "content-type": "text/event-stream" },
				})
			: Response.json({}, { status: probeStatus });
	return Response.json({ data: [{ id: savedModel }] });
});
const relay = {
	relayEndpointId: "endpoint_01",
	relayBaseUrl: "https://relay.example.test/v1",
	modelCatalog: {
		revision: "catalog_3",
		load: async () => ({
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
					// 端点登记的档位兼容保留但不再约束候选或验证（ADR-0029）。
					capabilities: {
						streaming: true,
						tools: true,
						reasoningLevels: ["low"],
					},
					allowedModels: null,
					available: true,
				},
			],
		}),
	},
	templateBindings: [
		{
			templateId: source.templateId,
			imageDigest: source.imageDigest,
			driver: "codex" as const,
			protocol: "openai-responses-v1" as const,
		},
	],
	validation: {
		profile: "sub2api-key-billing-v1" as const,
		billingUrl: "https://sub2api.la3.agoralab.co/v1/sub2api/billing",
		fetch: fetcher,
	},
};
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let reader: ReturnType<typeof createProductionSavedKeyCandidatesReaderV1>;

beforeAll(async () => {
	database = await startPostgresTestDatabase("3115-saved-key-verify");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 2 });
	await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision) values ('agent_01', 7, 'auth-1')`;
	await sql`insert into platform.agent_owners (agent_id, owner_id, created_at) values ('agent_01', 'owner_01', now())`;
	await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at, configuration) values ('agent_01', 7, ${source.templateId}, now(), ${sql.json(configuration as unknown as postgres.JSONValue)})`;
	// 通过与 API 相同的用例保存 Key，确保 Worker 读到真实的密文与绑定。
	const store = new PostgresAgentDefaultRelayKeyStoreV1({
		databaseUrl: database.databaseUrl,
	});
	try {
		await createAgentDefaultRelayKeyUseCaseV1({
			transaction: store,
			currentIdentity: async () => ({
				userId: "owner_01",
				accountStatus: "active",
				authorizationRevision: "auth-1",
			}),
			encrypt: (binding, keyValue) =>
				encryptor.encrypt({ ...binding, plaintext: keyValue }),
			candidates: async () =>
				configuration.modelConfiguration.options.map((option) => ({
					endpointId: option.endpointId,
					modelId: option.modelId,
					reasoningLevels: option.reasoningLevels,
				})),
			verify: async () => {},
		}).replace(
			{
				userId: "owner_01",
				agentId: "agent_01",
				traceId: "trace-setup",
				requestId: "request-setup",
			},
			{ keyValue: key, expectedVersion: null, configurationRevision: 7 },
		);
	} finally {
		await store.close();
	}
	reader = createProductionSavedKeyCandidatesReaderV1({
		databaseUrl: database.databaseUrl,
		decryptor,
		...relay,
		fetch: fetcher,
	});
});
afterAll(async () => {
	await reader?.close();
	await sql?.end();
	await database?.stop();
});
beforeEach(() => {
	probeStatus = 200;
	fetcher.mockClear();
});

const request = (verify?: { modelId: string; reasoningLevel: string }[]) => ({
	schemaVersion: 1 as const,
	requestId: "request-saved-key",
	traceId: "trace-saved-key",
	actorId: "owner_01",
	agentId: "agent_01",
	configurationRevision: 7,
	keyVersion: 1,
	...(verify
		? {
				verify: verify.map((combo) => ({
					endpointId: "endpoint_01",
					...combo,
				})),
			}
		: {}),
});
const probes = () =>
	fetcher.mock.calls.filter(([url]) => String(url).endsWith("/responses"));

describe("Worker saved-Key verification (ADR-0029)", () => {
	it("uses the same multi-endpoint policy for saved-Key candidates and verification", async () => {
		const { relayEndpointId, relayBaseUrl, ...policy } = relay;
		const multiReader = createProductionSavedKeyCandidatesReaderV1({
			...policy,
			databaseUrl: database.databaseUrl,
			decryptor,
			fetch: fetcher,
			relayEndpoints: [
				{
					endpointId: "messages",
					baseUrl: "https://relay.example.test",
					protocol: "anthropic-messages-v1",
				},
				{
					endpointId: relayEndpointId,
					baseUrl: relayBaseUrl,
					protocol: "openai-responses-v1",
				},
			],
		});
		try {
			await expect(
				multiReader.read(
					request([{ modelId: savedModel, reasoningLevel: "low" }]),
					AbortSignal.timeout(10000),
				),
			).resolves.toMatchObject({
				candidates: [{ endpointId: relayEndpointId, modelId: savedModel }],
				verification: "verified",
			});
			expect(probes()).toHaveLength(1);
		} finally {
			await multiReader.close();
		}
	});

	it("returns candidates without any model request when nothing is new", async () => {
		const result = await reader.read(request(), AbortSignal.timeout(10_000));
		expect(result).not.toHaveProperty("verification");
		expect(probes()).toHaveLength(0);
	});

	it("verifies each new pair with the decrypted saved Key", async () => {
		const result = await reader.read(
			request([
				{ modelId: savedModel, reasoningLevel: "medium" },
				{ modelId: savedModel, reasoningLevel: "high" },
			]),
			AbortSignal.timeout(10_000),
		);
		expect(result).toMatchObject({ verification: "verified" });
		expect(
			probes().map(([, init]) => {
				const body = JSON.parse(String(init?.body));
				return [body.model, body.reasoning.effort];
			}),
		).toEqual([
			[savedModel, "medium"],
			[savedModel, "high"],
		]);
		expect(
			probes().map(([, init]) =>
				new Headers(init?.headers).get("authorization"),
			),
		).toEqual([`Bearer ${key}`, `Bearer ${key}`]);
		// Key 明文只出现在发给 Relay 的请求头里，不进入返回值。
		expect(JSON.stringify(result)).not.toContain(key);
	});

	it("reports an incompatible pair from the Relay answer", async () => {
		probeStatus = 400;
		await expect(
			reader.read(
				request([{ modelId: savedModel, reasoningLevel: "high" }]),
				AbortSignal.timeout(10_000),
			),
		).resolves.toMatchObject({ verification: "incompatible" });
	});

	it("does not probe a model the saved Key cannot see", async () => {
		const result = await reader.read(
			request([{ modelId: "not-visible", reasoningLevel: "low" }]),
			AbortSignal.timeout(10_000),
		);
		expect(result).not.toHaveProperty("verification");
		expect(probes()).toHaveLength(0);
	});
});
