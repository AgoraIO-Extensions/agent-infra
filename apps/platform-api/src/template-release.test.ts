import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
	migratePlatformDatabase,
	PostgresAgentConfigurationQueryV1,
} from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
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
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import type { IdentityContext } from "./http/identity.js";
import {
	createProductionSingleAgentTemplateReleaseAppV1,
	type ProductionSingleAgentTemplateReleaseInputV1,
} from "./template-release.js";

interface DatabaseReader {
	unsafe(
		query: string,
		parameters?: readonly unknown[],
	): Promise<Record<string, unknown>[]>;
	end(): Promise<void>;
}
const connectDatabase = createRequire(
	import.meta.resolve("@agent-infra/platform-store"),
)("postgres") as (url: string, options: { max: number }) => DatabaseReader;
const original = {
	...structuredClone(agentConfigurationConformanceRecordV1),
	secrets: [
		{
			name: "BOT_TOKEN",
			secretId: "existing_bot_secret",
			version: 4,
			isSet: true as const,
		},
	],
	channels: [
		{ kind: "wecom_bot" as const, bindingReference: "existing_binding" },
	],
};
const digest = (value: string) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;
const config = JSON.stringify({
	os: "linux",
	architecture: "amd64",
	config: {
		Entrypoint: ["node"],
		Cmd: ["host.mjs"],
		WorkingDir: "/workspace",
		User: "10001",
		Env: [],
		Labels: {
			"io.agora.agent.runtime.manifest": JSON.stringify({
				schemaVersion: 1,
				interactionMode: "platform-adapter",
				protocol: "acp",
				service: { port: 8080 },
				health: { path: "/healthz" },
				capabilities: { modelSelection: true, connection: true },
			}),
		},
	},
});
const configDigest = digest(config);
const manifest = JSON.stringify({
	schemaVersion: 2,
	mediaType: "application/vnd.oci.image.manifest.v1+json",
	config: {
		mediaType: "application/vnd.oci.image.config.v1+json",
		digest: configDigest,
		size: Buffer.byteLength(config),
	},
	layers: [],
});
const target = {
	schemaVersion: 1 as const,
	releaseId: "release_01",
	agentId: original.agentId,
	templateId: "template_01",
	expectedConfigurationRevision: 7,
	expectedImageDigest: original.source.imageDigest,
	targetImageDigest: digest(manifest),
};
const administrator: IdentityContext = {
	schemaVersion: 1,
	userId: "administrator",
	displayName: "Test operator",
	accountStatus: "active",
	organizationIds: [],
	roles: ["system_admin"],
	authorizationRevision: "identity_1",
};
let actor:
	| (Omit<IdentityContext, "accountStatus"> & {
			accountStatus: "active" | "disabled";
	  })
	| null = administrator;
let operators: readonly string[] = [administrator.userId];
let bindingTarget = target;
let registryHook: () => Promise<void> = async () => {};
let registryMode: "normal" | "unavailable" | "wrong_manifest" | "denied" =
	"normal";
let db: DatabaseReader;
let testDatabase: PostgresTestDatabase;
let input: ProductionSingleAgentTemplateReleaseInputV1;
let running: ReturnType<typeof createProductionSingleAgentTemplateReleaseAppV1>;
let server: ReturnType<typeof serve>;
let origin: string;
const seenRequests: Request[] = [];
async function start(
	override: Partial<ProductionSingleAgentTemplateReleaseInputV1> = {},
) {
	running = createProductionSingleAgentTemplateReleaseAppV1({
		...input,
		...override,
	});
	server = serve({ fetch: running.app.fetch, hostname: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stop() {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	await running.close();
}
async function apply(
	body: unknown = { schemaVersion: 1 },
	key = "release_key",
	path = `/internal/ops/standard-template-releases/${target.releaseId}/apply`,
) {
	return fetch(`${origin}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": key },
		body: JSON.stringify(body),
	});
}
async function snapshot() {
	const [agent] = await db.unsafe(
		"select current_configuration_revision, authorization_revision from platform.agents where id=$1",
		[original.agentId],
	);
	const revisions = await db.unsafe(
		"select configuration from platform.agent_configuration_revisions order by revision",
	);
	const outbox = await db.unsafe(
		"select operation,payload from platform.outbox_items",
	);
	const audit = await db.unsafe(
		"select actor_id,action,details from platform.audit_events",
	);
	const keys = await db.unsafe(
		"select actor_id,request_digest,result from platform.idempotency_records",
	);
	const owners = await db.unsafe(
		"select owner_id from platform.agent_owners order by owner_id",
	);
	return { agent, revisions, outbox, audit, keys, owners };
}

// Controlled identity and Registry transport qualify production assembly behavior, not real account acceptance.
describe("production single-Agent template release over real HTTP and PostgreSQL", () => {
	beforeAll(async () => {
		testDatabase = await startPostgresTestDatabase("template-release-536");
		await migratePlatformDatabase({ databaseUrl: testDatabase.databaseUrl });
		db = connectDatabase(testDatabase.databaseUrl, { max: 2 });
		input = {
			databaseUrl: testDatabase.databaseUrl,
			imageRepository: "registry.example.test/agents/codex",
			identity: {
				async resolve(request) {
					seenRequests.push(request);
					return actor;
				},
				async hydrateUsers() {
					return [];
				},
			},
			target,
			loadReleaseBinding: async () => ({
				schemaVersion: 1,
				revision: "deployment_1",
				target: bindingTarget,
				operatorIds: operators,
			}),
			loadAuthorityContext: async () => ({
				schemaVersion: 1,
				users: [],
				organizationIds: [],
			}),
			registry: {
				endpoint: "https://registry.example.test",
				imageReferencePrefix: "registry.example.test/agents",
				admissionPolicyRef: "policy_1",
				fetch: async (request) => {
					await registryHook();
					if (registryMode === "unavailable")
						throw new Error("synthetic registry unavailable");
					const url = new URL(
						request instanceof Request ? request.url : request.toString(),
					);
					if (
						decodeURIComponent(url.pathname) ===
						`/v2/codex/manifests/${target.targetImageDigest}`
					)
						return new Response(
							registryMode === "wrong_manifest" ? "{}" : manifest,
							{
								headers: {
									"content-type": "application/vnd.oci.image.manifest.v1+json",
									"docker-content-digest": target.targetImageDigest,
								},
							},
						);
					if (
						decodeURIComponent(url.pathname) ===
						`/v2/codex/blobs/${configDigest}`
					)
						return new Response(config, {
							headers: {
								"content-type": "application/vnd.oci.image.config.v1+json",
							},
						});
					return new Response(null, { status: 404 });
				},
				policy: {
					authorize: async () =>
						registryMode === "denied"
							? ({ status: "rejected", reason: "policy_denied" } as never)
							: {
									status: "admitted",
									decisionRef: "decision_1",
									evaluatedAt: "2026-09-15T00:00:00Z",
								},
				},
			},
			templates: [
				{
					allowedEnvironmentKeys: ["LOG_LEVEL"],
					allowedSecretKeys: ["BOT_TOKEN", "MODEL_API_KEY"],
					platformManagedKeys: ["MODEL_API_KEY"],
					connectionEnabled: true,
					templateId: target.templateId,
					imageDigest: target.targetImageDigest,
					imageReference: `registry.example.test/agents/codex@${target.targetImageDigest}`,
				},
			],
			modelCatalog: {
				revision: "catalog_1",
				load: async () => {
					throw new Error("Publication must not resolve models");
				},
			},
			channelPolicy: { revision: "channels_1", bindings: [] },
		};
		await start();
	}, 60_000);
	beforeEach(async () => {
		actor = administrator;
		operators = [administrator.userId];
		bindingTarget = target;
		registryHook = async () => {};
		registryMode = "normal";
		seenRequests.length = 0;
		await db.unsafe(
			"truncate platform.audit_events,platform.outbox_items,platform.idempotency_records,platform.agent_management_history,platform.agent_availability,platform.agent_owners,platform.agent_configuration_revisions,platform.agent_applications,platform.agents cascade",
		);
		await db.unsafe(
			"insert into platform.agents(id,current_configuration_revision,authorization_revision,created_at) values($1,7,'authorization_9',now())",
			[original.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values('application_01',$1,'owner_01','Agent','Synthetic publication test','available','trace_seed','request_seed',now(),11,1,'ready','running',1,1)",
			[original.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values($1,7,$2,now(),$3::text::jsonb)",
			[original.agentId, target.templateId, JSON.stringify(original)],
		);
		await db.unsafe(
			"insert into platform.agent_owners(agent_id,owner_id,created_at) values($1,'owner_01',now())",
			[original.agentId],
		);
	});
	afterAll(async () => {
		if (server) await stop();
		await db?.end();
		await testDatabase?.stop();
	});
	it("publishes as a bound non-Owner admin and replays once after closing all assembly clients", async () => {
		const response = await apply();
		expect(response.status).toBe(202);
		const accepted = await response.json();
		expect(accepted).toEqual({
			schemaVersion: 1,
			agentId: original.agentId,
			configurationRevision: 8,
			changedFields: ["source"],
		});
		expect(seenRequests.length).toBeGreaterThanOrEqual(4);
		expect(new Set(seenRequests).size).toBe(1);
		const result = await snapshot();
		expect(result.agent).toEqual({
			current_configuration_revision: "8",
			authorization_revision: "authorization_9",
		});
		expect(result.revisions).toHaveLength(2);
		expect(result.outbox).toHaveLength(1);
		expect(result.audit).toHaveLength(1);
		expect(result.keys).toHaveLength(1);
		expect(result.owners).toEqual([{ owner_id: "owner_01" }]);
		expect(result.audit[0]).toMatchObject({
			actor_id: administrator.userId,
			action: "agent.configuration.revised",
		});
		const next = result.revisions[1]?.configuration as typeof original;
		expect({
			...next,
			source: original.source,
			revision: original.revision,
		}).toEqual(original);
		expect(next.source.imageDigest).toBe(target.targetImageDigest);
		await stop();
		await start();
		expect(await (await apply()).json()).toEqual(accepted);
		expect(await snapshot()).toEqual(result);
		operators = [];
		expect((await apply()).status).toBe(404);
		expect(await snapshot()).toEqual(result);
	});
	it.each(["anonymous", "disabled", "employee", "owner", "unbound_admin"])(
		"rejects %s before writing",
		async (mode) => {
			actor =
				mode === "anonymous"
					? null
					: mode === "disabled"
						? { ...administrator, accountStatus: "disabled" }
						: mode === "employee" || mode === "owner"
							? {
									...administrator,
									userId: mode === "owner" ? "owner_01" : "employee",
									roles: ["employee"],
								}
							: administrator;
			if (mode === "unbound_admin") operators = [];
			expect((await apply()).status).toBe(
				mode === "anonymous" ? 401 : mode === "disabled" ? 403 : 404,
			);
			const result = await snapshot();
			expect(result.revisions).toHaveLength(1);
			expect(result.outbox).toHaveLength(0);
		},
	);
	it.each([
		{ actorId: "administrator" },
		{ role: "system_admin" },
		{ agentId: "other" },
		{ source: { kind: "standard" } },
		{ modelConfiguration: {} },
		{ environment: [] },
		{ secrets: [] },
		{ coOwnerIds: [] },
		{ intent: "standard_template.release_to_agent" },
	])("rejects extra caller-controlled fields %j", async (extra) => {
		expect((await apply({ schemaVersion: 1, ...extra })).status).toBe(400);
		expect((await snapshot()).revisions).toHaveLength(1);
	});
	it("rejects unknown release, target drift and ordinary route access", async () => {
		expect(
			(
				await apply(
					{ schemaVersion: 1 },
					"key",
					"/internal/ops/standard-template-releases/other/apply",
				)
			).status,
		).toBe(404);
		bindingTarget = { ...target, agentId: "other" };
		expect((await apply()).status).toBe(404);
		expect(
			(
				await fetch(
					`${origin}/api/v2/agents/${original.agentId}/configuration`,
					{ method: "PUT" },
				)
			).status,
		).toBe(404);
	});
	it.each(["revoked", "disabled", "identity_revision"])(
		"rejects %s while waiting for Registry",
		async (mode) => {
			registryHook = async () => {
				if (mode === "revoked") operators = [];
				else
					actor = {
						...administrator,
						...(mode === "disabled"
							? { accountStatus: "disabled" as const }
							: { authorizationRevision: "identity_2" }),
					};
			};
			expect((await apply()).status).toBe(404);
			expect((await snapshot()).revisions).toHaveLength(1);
		},
	);
	it.each(["unavailable", "wrong_manifest", "denied"] as const)(
		"rejects Registry %s",
		async (mode) => {
			registryMode = mode;
			expect([409, 503]).toContain((await apply()).status);
			expect((await snapshot()).outbox).toHaveLength(0);
		},
	);
	it("rejects different deployment release content with the same actor/key after restart", async () => {
		expect((await apply()).status).toBe(202);
		const prior = await snapshot();
		const changed = { ...target, releaseId: "release_other" };
		await stop();
		bindingTarget = changed;
		await start({ target: changed });
		try {
			expect(
				(
					await apply(
						{ schemaVersion: 1 },
						"release_key",
						"/internal/ops/standard-template-releases/release_other/apply",
					)
				).status,
			).toBe(409);
			expect(await snapshot()).toEqual(prior);
		} finally {
			await stop();
			bindingTarget = target;
			await start();
		}
	});
	it("does not expose another operator's replay or create a second revision with a fresh key", async () => {
		expect((await apply()).status).toBe(202);
		const previous = await snapshot();
		expect((await apply({ schemaVersion: 1 }, "different_key")).status).toBe(
			409,
		);
		actor = { ...administrator, userId: "second_operator" };
		operators = [administrator.userId, "second_operator"];
		expect((await apply()).status).toBe(409);
		expect(await snapshot()).toEqual(previous);
	});
	it("rejects malformed JSON, wrong version and query-supplied targeting", async () => {
		const malformed = await fetch(
			`${origin}/internal/ops/standard-template-releases/${target.releaseId}/apply`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "malformed",
				},
				body: "{",
			},
		);
		expect(malformed.status).toBe(400);
		expect((await apply({ schemaVersion: 2 })).status).toBe(400);
		expect(
			(
				await apply(
					{ schemaVersion: 1 },
					"query",
					`/internal/ops/standard-template-releases/${target.releaseId}/apply?agentId=other`,
				)
			).status,
		).toBe(400);
		expect((await snapshot()).keys).toHaveLength(0);
	});
	it("rejects Agent authorization competition before commit", async () => {
		registryHook = async () => {
			registryHook = async () => {};
			await db.unsafe(
				"update platform.agents set authorization_revision='authorization_10' where id=$1",
				[original.agentId],
			);
		};
		expect((await apply()).status).toBe(409);
		expect((await snapshot()).keys).toHaveLength(0);
	});
	it("detects config competition with Store CAS after Registry waits", async () => {
		registryHook = async () => {
			registryHook = async () => {};
			await db.unsafe(
				"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values($1,8,$2,now(),$3::text::jsonb)",
				[
					original.agentId,
					target.templateId,
					JSON.stringify({ ...original, revision: 8 }),
				],
			);
			await db.unsafe(
				"update platform.agents set current_configuration_revision=8 where id=$1",
				[original.agentId],
			);
		};
		expect((await apply()).status).toBe(409);
		const result = await snapshot();
		expect(result.revisions).toHaveLength(2);
		expect(result.keys).toHaveLength(0);
		expect(result.outbox).toHaveLength(0);
	});
	it("rolls back configuration, idempotency, audit and outbox together on failure", async () => {
		await db.unsafe(
			"create function platform.fail_release_outbox() returns trigger language plpgsql as $$ begin raise exception 'injected release failure'; end $$",
		);
		await db.unsafe(
			"create trigger fail_release_outbox before insert on platform.outbox_items for each row execute function platform.fail_release_outbox()",
		);
		try {
			expect((await apply()).status).toBe(503);
			const result = await snapshot();
			expect(result.revisions).toHaveLength(1);
			expect(result.keys).toHaveLength(0);
			expect(result.audit).toHaveLength(0);
			expect(result.outbox).toHaveLength(0);
		} finally {
			await db.unsafe(
				"drop trigger fail_release_outbox on platform.outbox_items",
			);
			await db.unsafe("drop function platform.fail_release_outbox()");
		}
	});
	it("keeps ordinary persisted Owner authority unavailable to non-Owner administrators", async () => {
		const query = new PostgresAgentConfigurationQueryV1({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			expect(
				await query.readAuthority({
					agentId: original.agentId,
					actorId: administrator.userId,
					organizationIds: [],
					isAdministrator: true,
				}),
			).toEqual({ outcome: "unavailable" });
			expect(
				await query.readStandardTemplateReleaseAuthority({
					agentId: original.agentId,
					templateId: "wrong",
				}),
			).toEqual({ outcome: "unavailable" });
		} finally {
			await query.close();
		}
	});
});
vi.setConfig({ testTimeout: 30_000 });
