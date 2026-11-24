import { afterAll, beforeAll, expect, it } from "vitest";
import { ExternalServiceStore } from "./external-services.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	openPostgresTestClient,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: Awaited<ReturnType<typeof startPostgresTestDatabase>>;
let store: ExternalServiceStore;
beforeAll(async () => {
	database = await startPostgresTestDatabase("external-services");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	store = new ExternalServiceStore(database.databaseUrl);
}, 60000);
afterAll(async () => {
	await store?.close();
	await database?.stop();
});
it("switches only the tested revision, keeps its predecessor addressable and rejects stale activation", async () => {
	const actor = { actorId: "admin", traceId: "trace" };
	const a = await store.candidate(
		"relay",
		0,
		"https://a.example.test",
		() => ({ test: "encrypted-a" }),
		actor,
	);
	expect(await store.tested("relay", a, true, actor)).toBe(true);
	await store.change("relay", a, "enable", actor);
	const b = await store.candidate(
		"relay",
		a,
		"https://b.example.test",
		() => ({ test: "encrypted-b" }),
		actor,
	);
	expect(await store.tested("relay", b, false, actor)).toBe(true);
	await expect(store.change("relay", b, "enable", actor)).rejects.toThrow();
	expect((await store.active("relay"))?.url).toBe("https://a.example.test");
	await store.tested("relay", b, true, actor);
	await store.change("relay", b, "enable", actor);
	expect((await store.active("relay"))?.url).toBe("https://b.example.test");
	expect((await store.version("relay", a))?.url).toBe("https://a.example.test");
	await expect(store.change("relay", a, "enable", actor)).rejects.toThrow();
	await store.change("relay", b, "disable", actor);
	expect(await store.active("relay")).toBeNull();
	expect(JSON.stringify(await store.view())).not.toContain("encrypted-");
});
it("admits only enabled model endpoints and preserves the accepted destination and key", async () => {
	const sql = openPostgresTestClient(database);
	const actor = { actorId: "admin", traceId: "accept-test" };
	const id = "bound-relay";
	const endpoint = "bound-model-endpoint";
	const accept = (
		executionId: string,
		option: string,
	) => sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version,model_configuration_revision,model_option_id,reasoning_level)
 values(${executionId},'conv','agent','user','web',${executionId},'completed',1,'auth',now(),'web','personal','user','key',1,1,${option},'low') returning external_service_id,external_service_revision`;
	try {
		await sql`insert into platform.agents(id) values('agent')`;
		await sql`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values('agent',1,'source',now(),${sql.json(
			{
				schemaVersion: 3,
				agentId: "agent",
				revision: 1,
				modelConfiguration: {
					options: [
						{ optionId: "selected", endpointId: endpoint },
						{ optionId: "other", endpointId: "unrelated" },
					],
				},
			},
		)})`;
		await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values('conv','agent','user','web','active',1,'auth')`;
		await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values('personal','user',1,1)`;
		await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values('personal','user',1,'key','{"purpose":"personal","subjectId":"user","keyId":"key","keyVersion":1}'::jsonb)`;
		await store.candidate(
			id,
			0,
			"https://a.example.test",
			() => ({ ref: "A" }),
			actor,
			endpoint,
		);
		await store.change(id, 1, "disable", actor);
		await expect(
			accept("disabled-before-first-enable", "selected"),
		).rejects.toMatchObject({
			code: "23514",
		});
		expect(
			(await accept("unrelated-before-first-enable", "other"))[0]
				?.external_service_id,
		).toBeNull();
		await store.tested(id, 1, true, actor);
		await store.change(id, 1, "enable", actor);
		expect(
			(await accept("original", "selected"))[0]?.external_service_revision,
		).toBe(1);
		await store.candidate(
			id,
			1,
			"https://b.example.test",
			() => ({ ref: "B" }),
			actor,
			endpoint,
		);
		await store.tested(id, 2, true, actor);
		await store.change(id, 2, "enable", actor);
		expect(
			(await accept("after-switch", "selected"))[0]?.external_service_revision,
		).toBe(2);
		await store.change(id, 2, "disable", actor);
		await expect(accept("after-disable", "selected")).rejects.toMatchObject({
			code: "23514",
		});
		expect(
			(await accept("unrelated", "other"))[0]?.external_service_id,
		).toBeNull();
		const [original] =
			await sql`select v.url,e.relay_key_id,e.relay_key_version from platform.conversation_executions e join platform.external_service_versions v on (v.id,v.revision)=(e.external_service_id,e.external_service_revision) where e.execution_id='original'`;
		expect(original).toMatchObject({
			url: "https://a.example.test",
			relay_key_id: "key",
			relay_key_version: "1",
		});
	} finally {
		await sql.end();
	}
});

it("rejects a queued discovery after the actor is disabled before provider access", async () => {
	const sql = openPostgresTestClient(database);
	const operationId = "disabled-actor-discovery";
	let providerCalls = 0;
	try {
		await sql`insert into platform.external_services(id,revision,active,verified,enabled_once)
			values ('disabled-relay',1,1,1,true)`;
		await sql`insert into platform.external_service_versions(id,revision,url,credential)
			values ('disabled-relay',1,'https://disabled.example.test','{}'::jsonb)`;
		await sql`insert into platform.external_service_queries(operation_id,instance_id,revision,actor_id,action,expires_at)
			values (${operationId},'disabled-relay',1,'disabled-user','discover',clock_timestamp()+interval '15 seconds')`;
		await sql`insert into platform.platform_user_disables(user_id) values ('disabled-user')`;
		await store.processQuery(async () => {
			providerCalls += 1;
			return {
				revision: 1,
				discovery: {
					schemaVersion: 1,
					instanceId: "disabled-relay",
					subjectId: "disabled-user",
					items: [],
				},
			};
		});
		const [row] = await sql<{ receipt: unknown }[]>`
			select receipt from platform.external_service_queries where operation_id=${operationId}`;
		expect(providerCalls).toBe(0);
		expect(row?.receipt).toEqual({ failed: true });
	} finally {
		await sql`delete from platform.platform_user_disables where user_id='disabled-user'`;
		await sql`delete from platform.external_service_queries where operation_id=${operationId}`;
		await sql`delete from platform.external_service_versions where id='disabled-relay'`;
		await sql`delete from platform.external_services where id='disabled-relay'`;
		await sql.end();
	}
});
