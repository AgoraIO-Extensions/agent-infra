import { createHash, generateKeyPairSync } from "node:crypto";
import { AgentApiCreationResponseV1Schema } from "@agent-infra/contracts/pilot";
import type { AgentDefaultRelayKeyBindingV1 } from "@agent-infra/platform-core";
import { createRelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { applicationFoundationAdmissionDependenciesV1 } from "../../../packages/platform-core/src/application-foundation.conformance.js";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import {
	createClient,
	createConfig,
} from "../../web/src/pilot/generated-v2/client/index.js";
import { createAgentApiV1 } from "../../web/src/pilot/generated-v2/sdk.gen.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof serve>;
let origin: string;
const material = {
	application: `papi_${"A".repeat(43)}`,
	user: `papi_${"U".repeat(43)}`,
};
const modelConfiguration = {
	options: [
		{
			optionId: "model",
			endpointId: "relay",
			modelId: "model-a",
			reasoningLevels: ["low"],
		},
	],
	defaultOptionId: "model",
	defaultReasoningLevel: "low",
};
const body = {
	schemaVersion: 3 as const,
	name: "API Agent",
	description: "Controlled HTTP transaction test",
	source: { kind: "standard" as const, templateId: "template_01" },
	coOwnerIds: [],
	availability: [],
	environment: [],
	secrets: [],
	defaultRelayKey: "controlled-private-default-key",
	modelConfiguration,
};
const resolveUser = vi.fn(async (userId: string) => ({
	schemaVersion: 1,
	userId,
	accountStatus: "active",
	organizationIds: [],
	authorizationRevision: "user-1",
}));
const admissions = applicationFoundationAdmissionDependenciesV1();
const imageAdmission = vi.fn(admissions.imageAdmission.admitImage);
const candidates = vi.fn(async () => modelConfiguration.options);
const encrypt =
	vi.fn<
		(binding: AgentDefaultRelayKeyBindingV1, plaintext: string) => unknown
	>();
const unused = async (): Promise<never> => {
	throw new Error("Unused browser dependency");
};

async function start() {
	assembly = assemblePlatformApi({
		databaseUrl: database.databaseUrl,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 30_000,
		},
		identity: {
			resolve: async () => null,
			hydrateUsers: async () => [],
			resolveUser,
		},
		agentApiCreation: {
			allowedPrincipals: [
				{ kind: "application", id: "same-id" },
				{ kind: "user", id: "same-id" },
			],
			loadAuthorityContext: async () => ({
				schemaVersion: 1,
				users: [
					{ userId: "same-id", accountStatus: "active" },
					{ userId: "human-owner", accountStatus: "active" },
				],
				organizationIds: [],
			}),
			defaultRelayKey: { candidates, encrypt },
		},
		admissions: {
			...admissions,
			imageAdmission: { admitImage: imageAdmission },
			keylessModelAdmission: {
				admitModels: async ({ requested }) =>
					requested ? { ...requested, catalogRevision: "catalog-1" } : null,
			},
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: unused,
	});
	const app = createPlatformApp(assembly.dependencies);
	await new Promise<void>((resolve) => {
		server = serve(
			{ fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
			(address) => {
				origin = `http://127.0.0.1:${address.port}`;
				resolve();
			},
		);
	});
}
async function stop() {
	if (server)
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			if ("closeIdleConnections" in server) server.closeIdleConnections();
		});
	await assembly?.close();
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("agent-api-creation");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 3, onnotice: () => {} });
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const der = publicKey.export({ format: "der", type: "spki" });
	const encryptor = createRelayKeyEncryptorV1({
		encryptionKeys: {
			schemaVersion: 1,
			activeWrappingKeyVersion: "test-key",
			keys: [
				{
					schemaVersion: 1,
					keyVersion: "test-key",
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
					publicKeySpkiDerBase64: der.toString("base64"),
					publicKeyFingerprint: createHash("sha256").update(der).digest("hex"),
					rsaModulusBits: 3072,
					status: "active",
				},
			],
		},
	});
	encrypt.mockImplementation((binding, plaintext) =>
		encryptor.encrypt({ ...binding, plaintext }),
	);
	await start();
}, 120_000);
beforeEach(async () => {
	resolveUser.mockClear();
	imageAdmission
		.mockReset()
		.mockImplementation(admissions.imageAdmission.admitImage);
	candidates.mockReset().mockResolvedValue(modelConfiguration.options);
	encrypt.mockClear();
	await sql`truncate platform.agents, platform.platform_applications, platform.platform_api_credentials, platform.platform_user_disables, platform.relay_key_subjects, platform.relay_key_versions, platform.audit_events, platform.outbox_items, platform.idempotency_records cascade`;
	await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('same-id','Robot','human-owner','app-1')`;
	for (const [kind, token] of Object.entries(material))
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values(${kind},${kind},'same-id',${createHash("sha256").update(token).digest("hex")},'["agent:create","agent:read","agent:manage"]'::jsonb)`;
});
afterEach(async () => {
	await sql`drop trigger if exists creation_fault on platform.audit_events`;
	await sql`drop function if exists platform.creation_fault()`;
});
afterAll(async () => {
	await stop();
	await sql?.end();
	await database?.stop();
});
async function request(
	key = "same-key",
	token = material.application,
	value: unknown = body,
) {
	return fetch(`${origin}/api/v2/agents`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Idempotency-Key": key,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(value),
	});
}
async function effects() {
	return (
		await sql`select (select count(*)::int from platform.agents) agents, (select count(*)::int from platform.agent_principal_grants) grants, (select count(*)::int from platform.relay_key_versions) keys, (select count(*)::int from platform.outbox_items) outbox, (select count(*)::int from platform.idempotency_records) idempotency`
	)[0];
}

describe("Agent creation through formal HTTP/Core/PostgreSQL with controlled admission", () => {
	it("uses the generated client to persist application creator, human Owner, independent grants and ciphertext", async () => {
		const client = createClient(
			createConfig({ baseUrl: origin, auth: material.application }),
		);
		const response = await createAgentApiV1({
			client,
			body,
			headers: { "Idempotency-Key": "client-create" },
		});
		expect(response.response?.status).toBe(201);
		const result = AgentApiCreationResponseV1Schema.parse(response.data);
		expect(result).toMatchObject({
			status: "creating",
			revision: 1,
			replayed: false,
		});
		expect(
			await sql`select creation_channel,creator_principal_type,creator_principal_id,applicant_id,approval_revision from platform.agent_applications`,
		).toEqual([
			{
				creation_channel: "api",
				creator_principal_type: "application",
				creator_principal_id: "same-id",
				applicant_id: "human-owner",
				approval_revision: null,
			},
		]);
		expect(await sql`select owner_id from platform.agent_owners`).toEqual([
			{ owner_id: "human-owner" },
		]);
		const grants =
			await sql`select principal_type,principal_id,grant_type,authorization_revision from platform.agent_principal_grants order by grant_type`;
		expect(grants.map((row) => row.grant_type)).toEqual(["manage", "use"]);
		expect(
			grants.every(
				(row) =>
					row.principal_type === "application" &&
					row.principal_id === "same-id",
			),
		).toBe(true);
		expect(grants[0]?.authorization_revision).not.toBe(
			grants[1]?.authorization_revision,
		);
		expect(await effects()).toEqual({
			agents: 1,
			grants: 2,
			keys: 1,
			outbox: 1,
			idempotency: 1,
		});
		const audit =
			await sql`select action,actor_type,actor_id from platform.audit_events order by action`;
		expect(audit).toEqual([
			{
				action: "api.agent.create.accepted",
				actor_type: "application",
				actor_id: "same-id",
			},
			{
				action: "relay_key.agent_default.replace",
				actor_type: "application",
				actor_id: "same-id",
			},
		]);
		expect(
			JSON.stringify(
				await sql`select * from platform.agent_configuration_revisions`,
			),
		).not.toContain("credential");
		for (const rows of [
			await sql`select * from platform.relay_key_versions`,
			await sql`select * from platform.audit_events`,
			await sql`select * from platform.idempotency_records`,
			response.data,
		]) {
			expect(JSON.stringify(rows)).not.toContain(body.defaultRelayKey);
			expect(JSON.stringify(rows)).not.toContain(material.application);
		}
	});
	it("serializes concurrent requests, survives pool restart and rejects a conflicting digest", async () => {
		const requests = await Promise.all([request(), request()]);
		expect(requests.map((response) => response.status).toSorted()).toEqual([
			200, 201,
		]);
		const results = await Promise.all(
			requests.map(async (response) =>
				AgentApiCreationResponseV1Schema.parse(await response.json()),
			),
		);
		expect(results[0]?.agentId).toBe(results[1]?.agentId);
		await stop();
		await start();
		const replay = await request();
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({
			agentId: results[0]?.agentId,
			replayed: true,
		});
		expect(
			(
				await request("same-key", material.application, {
					...body,
					name: "different",
				})
			).status,
		).toBe(409);
		expect(await effects()).toEqual({
			agents: 1,
			grants: 2,
			keys: 1,
			outbox: 1,
			idempotency: 1,
		});
	});
	it("separates personal and application principals with the same bare ID and lets one app create multiple Agents", async () => {
		const responses = await Promise.all([
			request(),
			request("same-key", material.user),
			request("second-agent"),
		]);
		const results = await Promise.all(
			responses.map(async (response) => {
				expect(response.status).toBe(201);
				return AgentApiCreationResponseV1Schema.parse(await response.json());
			}),
		);
		expect(new Set(results.map((result) => result.agentId)).size).toBe(3);
		expect(
			await sql`select applicant_id,creator_principal_type from platform.agent_applications where creator_principal_type='user'`,
		).toEqual([{ applicant_id: "same-id", creator_principal_type: "user" }]);
	});
	it.each(["scope", "expiry", "revoke", "application", "owner"])(
		"rejects current %s invalidation without creating rows",
		async (kind) => {
			if (kind === "scope")
				await sql`update platform.platform_api_credentials set scopes='["agent:read"]'::jsonb where id='application'`;
			if (kind === "expiry")
				await sql`update platform.platform_api_credentials set expires_at=clock_timestamp()-interval '1 second' where id='application'`;
			if (kind === "revoke")
				await sql`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id='application'`;
			if (kind === "application")
				await sql`update platform.platform_applications set status='disabled'`;
			if (kind === "owner")
				await sql`insert into platform.platform_user_disables(user_id) values('human-owner')`;
			expect((await request()).status).toBeGreaterThanOrEqual(400);
			expect(await effects()).toEqual({
				agents: 0,
				grants: 0,
				keys: 0,
				outbox: 0,
				idempotency: 0,
			});
		},
	);
	it("blocks replay after manage is revoked while use remains granted", async () => {
		expect((await request()).status).toBe(201);
		await sql`update platform.agent_principal_grants set revoked_at=clock_timestamp() where grant_type='manage'`;
		expect((await request()).status).toBe(404);
		expect(await effects()).toEqual({
			agents: 1,
			grants: 2,
			keys: 1,
			outbox: 1,
			idempotency: 1,
		});
	});
	it("requires the application's own deployment create permission", async () => {
		await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('other-app','Other robot','same-id','app-1')`;
		await sql`update platform.platform_api_credentials set principal_id='other-app' where id='application'`;
		expect((await request()).status).toBe(403);
		expect(await effects()).toEqual({
			agents: 0,
			grants: 0,
			keys: 0,
			outbox: 0,
			idempotency: 0,
		});
	});
	it("creates custom Agents without a Relay Key or approval", async () => {
		imageAdmission.mockImplementationOnce(async (input) => ({
			schemaVersion: 1,
			status: "admitted",
			agentId: input.agentId,
			requestId: input.requestId,
			source: {
				kind: "custom",
				imageDigest: `sha256:${"a".repeat(64)}`,
				admissionRevision: "registry-1",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
				connectionEnabled: false,
			},
		}));
		const response = await request("custom", material.application, {
			schemaVersion: 2,
			name: body.name,
			description: body.description,
			source: {
				kind: "custom",
				imageReference: `registry.example/agent@sha256:${"a".repeat(64)}`,
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
			},
			coOwnerIds: [],
			availability: [],
			environment: [],
			secrets: [],
		});
		expect(response.status).toBe(201);
		expect(await effects()).toEqual({
			agents: 1,
			grants: 2,
			keys: 0,
			outbox: 1,
			idempotency: 1,
		});
		expect(candidates).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		"rolls all creation effects back when audit fails (deferred=%s)",
		async (deferred) => {
			await sql`create function platform.creation_fault() returns trigger language plpgsql as $$ begin if NEW.action='api.agent.create.accepted' then raise exception 'private failure'; end if; return NEW; end $$`;
			await sql.unsafe(
				deferred
					? "create constraint trigger creation_fault after insert on platform.audit_events deferrable initially deferred for each row execute function platform.creation_fault()"
					: "create trigger creation_fault before insert on platform.audit_events for each row execute function platform.creation_fault()",
			);
			const response = await request();
			expect(response.status).toBe(503);
			expect(await response.text()).not.toContain("private failure");
			expect(await effects()).toEqual({
				agents: 0,
				grants: 0,
				keys: 0,
				outbox: 0,
				idempotency: 0,
			});
		},
	);
});
