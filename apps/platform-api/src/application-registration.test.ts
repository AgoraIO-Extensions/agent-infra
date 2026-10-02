import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { ProtocolErrorV1Schema } from "@agent-infra/contracts";
import {
	ApplicationMetadataV1Schema,
	ApplicationRegistrationResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
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
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof serve>;
let baseUrl: string;
const currentUser = (userId: string) => ({
	schemaVersion: 1,
	userId,
	accountStatus: "active",
	organizationIds: [],
	authorizationRevision: "revision_1",
});
const resolveUser = vi.fn(
	async (id: string): Promise<unknown> => currentUser(id),
);
async function start() {
	const unused = async () => {
		throw new Error("Unrelated adapter must not be called");
	};
	const assembled = assemblePlatformApi({
		databaseUrl: database.databaseUrl,
		identity: {
			resolve: async (request) => {
				const id = request.headers
					.get("Cookie")
					?.match(/^browser_test=(alice|bob)$/)?.[1];
				return id
					? { ...currentUser(id), displayName: id, roles: ["employee"] }
					: null;
			},
			hydrateUsers: unused,
			resolveUser,
		},
		admissions: {
			authorizationAdmission: { authorize: unused },
			imageAdmission: { admitImage: unused },
			modelAdmission: { admitModels: unused },
			secretAdmission: { admitSecrets: unused },
			channelAdmission: { admitChannels: unused },
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: unused,
	});
	const listener = serve({
		fetch: createPlatformApp(assembled.dependencies).fetch,
		hostname: "127.0.0.1",
		port: 0,
	});
	await once(listener, "listening");
	const address = listener.address();
	if (!address || typeof address === "string")
		throw new Error("Missing HTTP listener");
	return {
		assembly: assembled,
		server: listener,
		baseUrl: `http://127.0.0.1:${address.port}`,
	};
}
async function stop(process = { server, assembly }) {
	await new Promise<void>((resolve, reject) =>
		process.server.close((error) => (error ? reject(error) : resolve())),
	);
	await process.assembly.close();
}
function post(
	key = "register_1",
	userId = "alice",
	body: unknown = { name: "Service" },
	headers: Record<string, string> = {},
	endpoint = baseUrl,
) {
	return fetch(`${endpoint}/api/v2/applications`, {
		method: "POST",
		headers: {
			Cookie: `browser_test=${userId}`,
			"Idempotency-Key": key,
			"Content-Type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});
}
function get(
	id: string,
	userId = "alice",
	headers: Record<string, string> = {},
) {
	return fetch(`${baseUrl}/api/v2/applications/${id}`, {
		headers: { Cookie: `browser_test=${userId}`, ...headers },
	});
}
async function counts() {
	const [row] =
		await sql`select (select count(*)::int from platform.platform_applications) as applications,
		(select count(*)::int from platform.idempotency_records) as idempotency,
		(select count(*)::int from platform.audit_events where outcome='succeeded') as succeeded`;
	return row;
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("application-registration");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
});
beforeEach(async () => {
	resolveUser.mockReset().mockImplementation(async (id) => currentUser(id));
	await sql`truncate platform.platform_applications, platform.idempotency_records, platform.audit_events, platform.platform_user_disables cascade`;
	({ assembly, server, baseUrl } = await start());
});
afterEach(async () => {
	await stop();
	await sql`drop trigger if exists fail_application_audit on platform.audit_events`;
	await sql`drop function if exists platform.fail_application_audit()`;
});
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});

describe("production application HTTP/Core/PostgreSQL chain", () => {
	it("reads persisted own metadata through the generated Client and after assembly restart without grants", async () => {
		const metadata = ApplicationRegistrationResponseV1Schema.parse(
			await (await post()).json(),
		).metadata;
		const { createClient } = await import(
			new URL(
				"../../web/src/pilot/generated-v2/client/index.ts",
				import.meta.url,
			).href
		);
		const { getOwnApplicationV2 } = await import(
			new URL("../../web/src/pilot/generated-v2/index.ts", import.meta.url).href
		);
		const result = await getOwnApplicationV2({
			client: createClient({ baseUrl }),
			path: { applicationId: metadata.applicationId },
			headers: { Cookie: "browser_test=alice" },
		});
		expect(result.response.status).toBe(200);
		expect(result.response.headers.get("Cache-Control")).toBe("no-store");
		expect(result.data).toEqual(metadata);
		await stop();
		({ assembly, server, baseUrl } = await start());
		expect(
			ApplicationMetadataV1Schema.parse(
				await (await get(metadata.applicationId)).json(),
			),
		).toEqual(metadata);
		const [audit] =
			await sql`select actor_type,actor_id,target_id from platform.audit_events where action='application.metadata.read'`;
		expect(audit).toMatchObject({
			actor_type: "user",
			actor_id: "alice",
			target_id: metadata.applicationId,
		});
		const [effects] =
			await sql`select (select count(*)::int from platform.platform_api_credentials) as credentials,
		(select count(*)::int from platform.api_credential_delivery_grants) as material_grants,
		(select count(*)::int from platform.agent_principal_grants) as agent_grants,
		(select count(*)::int from platform.task_authorization_records) as task_authorizations,
		(select count(*)::int from platform.outbox_items) as outbox`;
		expect(effects).toEqual({
			credentials: 0,
			material_grants: 0,
			agent_grants: 0,
			task_authorizations: 0,
			outbox: 0,
		});
	});
	it("makes foreign and missing reads indistinguishable and rejects typed or forged identities", async () => {
		const own = ApplicationRegistrationResponseV1Schema.parse(
			await (await post()).json(),
		).metadata;
		const foreign = await get(own.applicationId, "bob");
		const missing = await get("absent", "bob");
		expect(foreign.status).toBe(404);
		expect(missing.status).toBe(404);
		const { traceId: foreignTrace, ...foreignError } =
			ProtocolErrorV1Schema.parse(await foreign.json());
		const { traceId: missingTrace, ...missingError } =
			ProtocolErrorV1Schema.parse(await missing.json());
		expect(foreignTrace).toEqual(expect.any(String));
		expect(missingTrace).toEqual(expect.any(String));
		expect(foreignError).toEqual(missingError);
		await sql`insert into platform.platform_applications (id,name,responsible_user_id,authorization_revision) values ('alice','Foreign','bob','revision')`;
		expect((await get("alice")).status).toBe(404);
		expect((await get("alice", "bob")).status).toBe(200);
		expect((await get(own.applicationId, "application")).status).toBe(401);
		expect(
			(await get(own.applicationId, "alice", { Authorization: "Bearer alice" }))
				.status,
		).toBe(401);
		expect((await get(`${own.applicationId}?userId=bob`)).status).toBe(400);
	});
	it.each(["length", "chunked"] as const)(
		"rejects GET body framing %s at the real HTTP adapter",
		async (framing) => {
			const own = ApplicationRegistrationResponseV1Schema.parse(
				await (await post()).json(),
			).metadata;
			const body = JSON.stringify({ userId: "bob" });
			const status = await new Promise<number | undefined>(
				(resolve, reject) => {
					const request = httpRequest(
						`${baseUrl}/api/v2/applications/${own.applicationId}`,
						{
							method: "GET",
							headers: {
								Cookie: "browser_test=alice",
								...(framing === "length"
									? { "Content-Length": Buffer.byteLength(body) }
									: { "Transfer-Encoding": "chunked" }),
							},
						},
						(response) => {
							response.on("error", reject);
							response.resume();
							response.once("end", () => resolve(response.statusCode));
						},
					);
					request.on("error", reject);
					request.end(body);
				},
			);
			expect(status).toBe(400);
			expect(await counts()).toEqual({
				applications: 1,
				idempotency: 1,
				succeeded: 1,
			});
		},
	);
	it("rejects disabled, missing and changed current users after the final read audit await", async () => {
		const own = ApplicationRegistrationResponseV1Schema.parse(
			await (await post()).json(),
		).metadata;
		await sql`insert into platform.platform_user_disables (user_id) values ('alice')`;
		expect((await get(own.applicationId)).status).toBe(403);
		await sql`delete from platform.platform_user_disables`;
		resolveUser.mockResolvedValueOnce(null);
		expect((await get(own.applicationId)).status).toBe(403);
		for (const [current, status] of [
			[null, 403],
			[{ ...currentUser("alice"), accountStatus: "disabled" }, 403],
			[{ ...currentUser("alice"), authorizationRevision: "changed" }, 503],
		] as const) {
			resolveUser
				.mockResolvedValueOnce(currentUser("alice"))
				.mockResolvedValueOnce(current);
			expect((await get(own.applicationId)).status).toBe(status);
			expect(await counts()).toEqual({
				applications: 1,
				idempotency: 1,
				succeeded: 1,
			});
		}
	});
	it.each([false, true])(
		"withholds read metadata and rolls back read audit on audit failure deferred=%s",
		async (deferred) => {
			const own = ApplicationRegistrationResponseV1Schema.parse(
				await (await post()).json(),
			).metadata;
			await sql`create function platform.fail_application_audit() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE_SQL_SENTINEL'; end $$`;
			await sql.unsafe(
				deferred
					? "create constraint trigger fail_application_audit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.fail_application_audit()"
					: "create trigger fail_application_audit before insert on platform.audit_events for each row execute function platform.fail_application_audit()",
			);
			const response = await get(own.applicationId);
			expect(response.status).toBe(503);
			expect(await response.text()).not.toContain("PRIVATE_SQL_SENTINEL");
			expect(await counts()).toEqual({
				applications: 1,
				idempotency: 1,
				succeeded: 1,
			});
		},
	);
	it("uses the generated Client for registration and replays original metadata after reopening assembly", async () => {
		const { createClient } = await import(
			new URL(
				"../../web/src/pilot/generated-v2/client/index.ts",
				import.meta.url,
			).href
		);
		const { registerApplicationV2 } = await import(
			new URL("../../web/src/pilot/generated-v2/index.ts", import.meta.url).href
		);
		const response = await registerApplicationV2({
			client: createClient({ baseUrl }),
			body: { name: "Service" },
			headers: {
				Cookie: "browser_test=alice",
				"Idempotency-Key": "register_1",
			},
		});
		expect(response.response.status).toBe(201);
		expect(response.data.metadata).toMatchObject({
			responsibleUserId: "alice",
			status: "active",
		});
		expect(response.response.headers.get("Cache-Control")).toBe("no-store");
		const id = response.data.metadata.applicationId;
		await stop();
		const [connections] =
			await sql`select count(*)::int as active from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()`;
		expect(connections?.active).toBe(0);
		({ assembly, server, baseUrl } = await start());
		const replay = await post();
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({
			metadata: response.data.metadata,
			replayed: true,
		});
		const [row] =
			await sql`select id, responsible_user_id, status, authorization_revision from platform.platform_applications`;
		expect(row).toMatchObject({
			id,
			responsible_user_id: "alice",
			status: "active",
			authorization_revision: response.data.metadata.authorizationRevision,
		});
		const [effects] =
			await sql`select (select count(*)::int from platform.platform_api_credentials) as credentials,
			(select count(*)::int from platform.api_credential_delivery_grants) as material_grants,
			(select count(*)::int from platform.agent_principal_grants) as agent_grants,
			(select count(*)::int from platform.task_authorization_records) as task_authorizations,
			(select count(*)::int from platform.outbox_items) as outbox`;
		expect(effects).toEqual({
			credentials: 0,
			material_grants: 0,
			agent_grants: 0,
			task_authorizations: 0,
			outbox: 0,
		});
	});
	it("serializes same-key requests, conflicts on changed name and isolates the same key by user", async () => {
		const second = await start();
		let pair: Response[];
		try {
			pair = await Promise.all([
				post(),
				post("register_1", "alice", { name: "Service" }, {}, second.baseUrl),
			]);
		} finally {
			await stop(second);
		}
		expect(pair.map((response) => response.status).sort()).toEqual([200, 201]);
		const results = await Promise.all(pair.map((response) => response.json()));
		const firstResult = ApplicationRegistrationResponseV1Schema.parse(
			results[0],
		);
		const secondResult = ApplicationRegistrationResponseV1Schema.parse(
			results[1],
		);
		expect(firstResult.metadata).toEqual(secondResult.metadata);
		expect(await counts()).toEqual({
			applications: 1,
			idempotency: 1,
			succeeded: 2,
		});
		expect(
			(await post("register_1", "alice", { name: "Changed" })).status,
		).toBe(409);
		const bob = await post("register_1", "bob");
		expect(bob.status).toBe(201);
		expect(
			ApplicationRegistrationResponseV1Schema.parse(await bob.json()).metadata
				.applicationId,
		).not.toBe(firstResult.metadata.applicationId);
	});
	it("rejects application or Bearer identities before registration", async () => {
		expect((await post("register_1", "application")).status).toBe(401);
		expect(
			(
				await post(
					"register_1",
					"alice",
					{ name: "Service" },
					{ Authorization: "Bearer alice" },
				)
			).status,
		).toBe(401);
		expect(await counts()).toEqual({
			applications: 0,
			idempotency: 0,
			succeeded: 0,
		});
		const audit =
			await sql`select actor_type,actor_id from platform.audit_events`;
		expect(audit).toHaveLength(2);
		expect(
			audit.every(
				(row) => row.actor_type === "unknown" && row.actor_id === "unknown",
			),
		).toBe(true);
	});

	it.each([
		"responsibleUserId",
		"userId",
		"principalType",
		"status",
		"grant",
		"credential",
	])(
		"rejects caller-controlled %s with a trusted-actor refusal audit",
		async (field) => {
			const response = await post("register_1", "alice", {
				name: "Service",
				[field]: "bob",
			});
			expect(response.status).toBe(400);
			expect(await counts()).toEqual({
				applications: 0,
				idempotency: 0,
				succeeded: 0,
			});
			const [audit] =
				await sql`select actor_type,actor_id,target_id,outcome,details from platform.audit_events`;
			expect(audit).toMatchObject({
				actor_type: "user",
				actor_id: "alice",
				target_id: "unknown",
				outcome: "rejected",
				details: { reason: "invalid_input" },
			});
		},
	);
	it("rejects disabled users and rolls back registration when the final directory check loses the user", async () => {
		await sql`insert into platform.platform_user_disables (user_id) values ('alice')`;
		expect((await post()).status).toBe(403);
		await sql`delete from platform.platform_user_disables`;
		for (const [current, status] of [
			[null, 403],
			[{ ...currentUser("alice"), accountStatus: "disabled" }, 403],
			[{ ...currentUser("alice"), authorizationRevision: "changed" }, 503],
		] as const) {
			resolveUser
				.mockResolvedValueOnce(currentUser("alice"))
				.mockResolvedValueOnce(current);
			expect((await post()).status).toBe(status);
			expect(await counts()).toEqual({
				applications: 0,
				idempotency: 0,
				succeeded: 0,
			});
		}
	});
	it.each([false, true])(
		"withholds success and rolls back on audit failure deferred=%s",
		async (deferred) => {
			await sql`create function platform.fail_application_audit() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE_SQL_SENTINEL'; end $$`;
			await sql.unsafe(
				deferred
					? "create constraint trigger fail_application_audit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.fail_application_audit()"
					: "create trigger fail_application_audit before insert on platform.audit_events for each row execute function platform.fail_application_audit()",
			);
			const response = await post();
			expect(response.status).toBe(503);
			expect(await response.text()).not.toContain("PRIVATE_SQL_SENTINEL");
			expect(await counts()).toEqual({
				applications: 0,
				idempotency: 0,
				succeeded: 0,
			});
		},
	);
});

function disableApplication(
	id: string,
	userId = "alice",
	key = "disable_1",
	body: unknown = { status: "disabled" },
	endpoint = baseUrl,
) {
	return fetch(`${endpoint}/api/v2/applications/${id}`, {
		method: "PATCH",
		headers: {
			Cookie: `browser_test=${userId}`,
			"Idempotency-Key": key,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}
describe("application disable production HTTP/PostgreSQL boundary", () => {
	it("persists one transition across concurrent keys, generated-client replay and assembly restart", async () => {
		const own = ApplicationRegistrationResponseV1Schema.parse(
			await (await post()).json(),
		).metadata;
		const second = await start();
		let responses: Response[];
		try {
			responses = await Promise.all([
				disableApplication(own.applicationId),
				disableApplication(
					own.applicationId,
					"alice",
					"disable_2",
					{ status: "disabled" },
					second.baseUrl,
				),
			]);
		} finally {
			await stop(second);
		}
		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		const results = await Promise.all(
			responses.map(async (r) =>
				ApplicationMetadataV1Schema.parse(await r.json()),
			),
		);
		expect(results[0]).toEqual(results[1]);
		expect(results[0].status).toBe("disabled");
		expect(results[0].authorizationRevision).not.toBe(
			own.authorizationRevision,
		);
		await stop();
		({ assembly, server, baseUrl } = await start());
		const { createClient } = await import(
			new URL(
				"../../web/src/pilot/generated-v2/client/index.ts",
				import.meta.url,
			).href
		);
		const { disableOwnApplicationV2 } = await import(
			new URL("../../web/src/pilot/generated-v2/index.ts", import.meta.url).href
		);
		const replay = await disableOwnApplicationV2({
			client: createClient({ baseUrl }),
			path: { applicationId: own.applicationId },
			headers: { Cookie: "browser_test=alice", "Idempotency-Key": "disable_1" },
			body: { status: "disabled" },
		});
		expect(replay.response.status).toBe(200);
		expect(replay.data).toEqual(results[0]);
		const [effects] =
			await sql`select (select count(*)::int from platform.idempotency_records where command_type='application.disabled') as commands,
		(select count(*)::int from platform.audit_events where action='application.disabled' and outcome='succeeded') as audits`;
		expect(effects).toEqual({ commands: 2, audits: 3 });
	});
	it("does not disclose foreign applications or accept delegated identity fields", async () => {
		const own = ApplicationRegistrationResponseV1Schema.parse(
			await (await post()).json(),
		).metadata;
		const responses = await Promise.all([
			disableApplication(own.applicationId, "bob"),
			disableApplication("missing", "bob"),
		]);
		const bodies = [];
		for (const response of responses) {
			expect(response.status).toBe(404);
			const { traceId, ...body } = ProtocolErrorV1Schema.parse(
				await response.json(),
			);
			expect(traceId).toEqual(expect.any(String));
			bodies.push(body);
		}
		expect(bodies[0]).toEqual(bodies[1]);
		expect(
			(
				await disableApplication(own.applicationId, "alice", "forged", {
					status: "disabled",
					responsibleUserId: "bob",
				})
			).status,
		).toBe(400);
		await sql`insert into platform.platform_user_disables (user_id) values ('alice')`;
		expect((await disableApplication(own.applicationId)).status).toBe(403);
		const [row] =
			await sql`select status,authorization_revision from platform.platform_applications where id=${own.applicationId}`;
		expect(row).toEqual({
			status: "active",
			authorization_revision: own.authorizationRevision,
		});
	});
	it.each([false, true])(
		"rolls back status, revision and idempotency with failed audit deferred=%s",
		async (deferred) => {
			const own = ApplicationRegistrationResponseV1Schema.parse(
				await (await post()).json(),
			).metadata;
			await sql`create function platform.fail_application_audit() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE_SQL_SENTINEL'; end $$`;
			await sql.unsafe(
				deferred
					? "create constraint trigger fail_application_audit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.fail_application_audit()"
					: "create trigger fail_application_audit before insert on platform.audit_events for each row execute function platform.fail_application_audit()",
			);
			const response = await disableApplication(own.applicationId);
			expect(response.status).toBe(503);
			expect(await response.text()).not.toContain("PRIVATE_SQL_SENTINEL");
			const [row] =
				await sql`select status,authorization_revision from platform.platform_applications where id=${own.applicationId}`;
			expect(row).toEqual({
				status: "active",
				authorization_revision: own.authorizationRevision,
			});
			const commands =
				await sql`select id from platform.idempotency_records where command_type='application.disabled'`;
			expect(commands).toHaveLength(0);
		},
	);
});
