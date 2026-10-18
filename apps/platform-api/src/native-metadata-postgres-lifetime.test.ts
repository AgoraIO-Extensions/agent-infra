import {
	migratePlatformDatabase,
	PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { registerNativeMetadataRoutes } from "./http/native-metadata-routes.js";
import {
	createRuntimeNativeMetadataCurrentCheckerV1,
	createRuntimeNativeMetadataRequestRegistryV1,
} from "./runtime-native-metadata-current.js";
import { createRuntimeNativeMetadataWorkerReaderV1 } from "./runtime-native-metadata-reader.js";
import { createRuntimeNativeMetadataScopeResolverV1 } from "./runtime-native-metadata-scope-resolver.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "pg-metadata-user",
	displayName: "Synthetic PG User",
	accountStatus: "active" as const,
	organizationIds: [],
	roles: ["employee" as const],
	authorizationRevision: "pg-metadata-revision",
};
const path =
	"/api/v2/conversations/pg-metadata-conversation/executions/pg-metadata-execution/native-metadata?selector=status";
const projection = {
	selector: "status" as const,
	status: "idle" as const,
	readAt: "2026-10-18T00:00:00.000Z",
};
let database: PostgresTestDatabase | undefined;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("native-metadata-lifetime");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 2 });
	await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,host_session_ref) values ('pg-metadata-conversation','pg-metadata-agent',${identity.userId},'web','active',1,${identity.authorizationRevision},'pg-original-host')`;
	await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values ('personal',${identity.userId},1,1)`;
	await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values ('personal',${identity.userId},1,'pg-synthetic-key',${sql.json({ purpose: "personal", subjectId: identity.userId, keyId: "pg-synthetic-key", keyVersion: 1 })})`;
	await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version) values ('pg-metadata-execution','pg-metadata-conversation','pg-metadata-agent',${identity.userId},'web','pg-metadata-turn','completed',1,'pg-original-execution-revision',now(),'v4',${"a".repeat(43)},'pg-original-host','web','personal',${identity.userId},'pg-synthetic-key',1)`;
}, 120_000);
afterAll(async () => {
	await sql?.end({ timeout: 1 });
	await database?.stop();
});

async function read(
	options: {
		fault?:
			| "generation"
			| "host"
			| "current host"
			| "final host"
			| "authorization";
		foreignIdentity?: boolean;
	} = {},
) {
	if (!database) throw new Error("Postgres fixture missing");
	const query = new PostgresConversationQueryV1({
		databaseUrl: database.databaseUrl,
	});
	const registry = createRuntimeNativeMetadataRequestRegistryV1();
	const authorize = async () => ({
		outcome: "allowed" as const,
		authority: {
			actorId: identity.userId,
			agentId: "pg-metadata-agent",
			channelId: "web",
			authorizationRevision: "pg-current-agent-policy-revision",
		},
	});
	const checker = createRuntimeNativeMetadataCurrentCheckerV1({
		registry,
		authorize,
	});
	let gatewayCalls = 0;
	const outcomes: string[] = [];
	const reader = createRuntimeNativeMetadataWorkerReaderV1({
		resolveRequest: createRuntimeNativeMetadataScopeResolverV1({
			query,
			authorize,
		}),
		requestRegistry: registry,
		// Identity/Core and Runtime transport are controlled; original scope is actual PostgreSQL.
		gateway: {
			read: async (request, signal) => {
				gatewayCalls++;
				const { apiRequestSourceRef, ...input } = request;
				const binding = { ...input, originalHostScopeRef: "pg-original-host" };
				const check = () =>
					checker.check({
						request: { ...binding, phase: "read_metadata" },
						apiRequestSourceRef,
						signal,
					});
				const before = await check();
				outcomes.push(before.outcome);
				if (before.outcome !== "allowed") return null;
				if (options.fault === "authorization")
					await sql`update platform.conversation_executions set authorization_revision='changed-original-execution-revision' where execution_id='pg-metadata-execution'`;
				if (options.fault === "generation")
					await sql`update platform.conversation_executions set session_generation=2 where execution_id='pg-metadata-execution'`;
				if (options.fault === "host")
					await sql`update platform.conversation_executions set original_submit_host_session_ref='pg-replaced-host' where execution_id='pg-metadata-execution'`;
				if (options.fault === "current host")
					await sql`update platform.conversations set host_session_ref='pg-unrelated-current-host' where id='pg-metadata-conversation'`;
				const after = await check();
				outcomes.push(after.outcome);
				return after.outcome === "allowed" ? { ...binding, projection } : null;
			},
		},
	});
	const app = new Hono();
	registerNativeMetadataRoutes(app, {
		identity: {
			resolve: async () =>
				options.foreignIdentity
					? { ...identity, userId: "foreign-pg-user" }
					: identity,
			hydrateUsers: async () => [],
		},
		reader: {
			async read(...args: Parameters<typeof reader.read>) {
				const value = await reader.read(...args);
				if (options.fault === "final host")
					await sql`update platform.conversation_executions set original_submit_host_session_ref='pg-replaced-host' where execution_id='pg-metadata-execution'`;
				return value;
			},
		},
	});
	try {
		const response = await app.fetch(
			new Request(`http://pg-metadata.invalid${path}`),
		);
		return {
			status: response.status,
			body: await response.json(),
			gatewayCalls,
			outcomes,
		};
	} finally {
		registry.clear();
		await query.close();
		await sql`update platform.conversation_executions set session_generation=1,original_submit_host_session_ref='pg-original-host',authorization_revision='pg-original-execution-revision' where execution_id='pg-metadata-execution'`;
		await sql`update platform.conversations set host_session_ref='pg-original-host' where id='pg-metadata-conversation'`;
	}
}

describe("native metadata actual PostgreSQL original-scope lifetime", () => {
	it("reads the terminal original scope without creating business records", async () => {
		const before =
			await sql`select (select count(*) from platform.conversation_executions)::int as executions,(select count(*) from platform.conversation_events)::int as events,(select count(*) from platform.outbox_items)::int as outbox`;
		const result = await read();
		expect(result.status).toBe(200);
		expect(result.body).toEqual(projection);
		expect(result.outcomes).toEqual(["allowed", "allowed"]);
		const after =
			await sql`select (select count(*) from platform.conversation_executions)::int as executions,(select count(*) from platform.conversation_events)::int as events,(select count(*) from platform.outbox_items)::int as outbox`;
		expect(after).toEqual(before);
	});
	it.each(["generation", "host", "final host", "authorization"] as const)(
		"denies persisted original %s drift before bytes",
		async (fault) => {
			const result = await read({ fault });
			expect(result.status).not.toBe(200);
			expect(result.body).not.toHaveProperty("selector");
			if (fault !== "final host")
				expect(result.outcomes.at(-1)).not.toBe("allowed");
		},
	);
	it("does not replace the original Host with the current Conversation Host", async () => {
		const result = await read({ fault: "current host" });
		expect(result.status).toBe(200);
		expect(result.outcomes).toEqual(["allowed", "allowed"]);
	});
	it("rejects a different principal before calling the gateway", async () => {
		const result = await read({ foreignIdentity: true });
		expect(result.status).not.toBe(200);
		expect(result.gatewayCalls).toBe(0);
	});
});
