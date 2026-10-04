import { Buffer } from "node:buffer";
import { once } from "node:events";
import { ConversationPageV1Schema } from "@agent-infra/contracts/pilot";
import type {
	AgentConfigurationRecordV2,
	WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { seedSessionSandboxFixture } from "../../../packages/platform-store/src/session-sandbox.fixture.ts";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import type { IdentityAdapter } from "./http/identity.js";

const generated = await import(
	new URL("../../web/src/pilot/generated-v2/sdk.gen.ts", import.meta.url).href
);
const { createClient } = await import(
	new URL("../../web/src/pilot/generated-v2/client/index.ts", import.meta.url)
		.href
);
let database: PostgresTestDatabase | undefined;
let sql: ReturnType<typeof postgres>;
let query: PostgresConversationQueryV1;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof serve> | undefined;
let origin: string;
let disabled = false;
let directoryFails = false;
let browserFails = false;
let organizations = ["team"];

// Controlled cookie/directory subjects; this suite proves the production read path,
// not a real employee directory or browser-session deployment.
const identity: IdentityAdapter = {
	async resolve(request) {
		if (browserFails) throw new Error("private identity detail");
		const actor = request.headers
			.get("Cookie")
			?.match(/^fixture-session=(owner|other|admin)$/)?.[1];
		if (!actor) return null;
		return {
			schemaVersion: 1,
			userId: actor,
			displayName: actor,
			accountStatus: "active",
			organizationIds: ["team"],
			roles: actor === "admin" ? ["system_admin"] : ["employee"],
			authorizationRevision: "browser-snapshot",
		};
	},
	async resolveUser(userId) {
		if (directoryFails) throw new Error("private directory detail");
		return {
			schemaVersion: 1,
			userId,
			accountStatus: disabled ? "disabled" : "active",
			organizationIds: organizations,
			authorizationRevision: "current-directory",
		};
	},
	async hydrateUsers() {
		return [];
	},
};

function configuration(
	agentId: string,
	custom = false,
	selfManaged = false,
): AgentConfigurationRecordV2 {
	return {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId,
		revision: 2,
		...(custom
			? {
					source: {
						kind: "custom",
						imageDigest: `sha256:${"a".repeat(64)}`,
						admissionRevision: "fixture",
						interactionMode: selfManaged ? "self-managed" : "platform-adapter",
						...(selfManaged
							? { identityResponsibility: "self-managed" as const }
							: {}),
						connectionEnabled: false,
					},
					modelConfiguration: null,
					environment: [],
					secrets: [],
				}
			: {}),
	};
}

async function seedAgent(
	agentId: string,
	status:
		| "creating"
		| "available"
		| "stopped"
		| "creation_failed"
		| "disabled" = "available",
	service: "ready" | "starting" | "updating" | "unavailable" = "ready",
	custom = false,
	selfManaged = false,
) {
	const cfg = configuration(agentId, custom, selfManaged);
	const version = { configuration: cfg, deployment: {} };
	const verified = custom
		? {
				configuration: { ...configuration(agentId, true, false), revision: 1 },
				deployment: {},
			}
		: null;
	const workload: WorkloadReconciliationStateV1 = {
		schemaVersion: 1,
		agentId,
		sourceConfigurationRevision: 2,
		sourceLifecycleRevision: 1,
		revision: 2,
		fence: 1,
		phase: "preflight",
		candidate: version,
		verified,
		verifiedRevision: custom ? 1 : null,
		identity: null,
		rollback: false,
		failureCode: null,
		attempts: 0,
		...(custom ? { capabilities: { supplementaryInstruction: false } } : {}),
	};
	await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision)
    values (${agentId}, 2, 'current-grants')`;
	await sql`insert into platform.agent_applications
    (id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at,
      management_revision, approval_revision, desired_state, workload_revision, fence, service_availability, failure_code)
    values (${`application-${agentId}`}, ${agentId}, 'owner', 'Fixture', 'Fixture', ${status}, 'trace', 'request', now(),
      1, 1, ${status === "stopped" || status === "disabled" ? "stopped" : "running"}, 2, 1,
      ${status === "available" ? service : null}, ${status === "creation_failed" ? "creation_not_ready" : service === "unavailable" ? "workload_unavailable" : null})`;
	await sql`insert into platform.agent_configuration_revisions (agent_id, revision, source_reference, configuration, created_at)
    values (${agentId}, 2, 'fixture', ${sql.json(cfg as unknown as postgres.JSONValue)}, now())`;
	await sql`insert into platform.agent_owners (agent_id, owner_id, created_at) values (${agentId}, 'owner', now())`;
	await sql`insert into platform.agent_availability (agent_id, target_type, target_id) values (${agentId}, 'organization', 'team')`;
	await sql`insert into platform.workload_reconciliations (agent_id, revision, state)
    values (${agentId}, 2, ${sql.json(workload as unknown as postgres.JSONValue)})`;
}

async function seedConversation(
	id: string,
	agentId: string,
	updatedAt: string,
	actor = "owner",
	channel = "web",
) {
	await sql`insert into platform.conversations
    (id, agent_id, actor_id, channel_id, status, session_generation, authorization_revision, created_at, updated_at)
    values (${id}, ${agentId}, ${actor}, ${channel}, 'ready', 1, 'old-grants', '2026-09-01T00:00:00Z', ${updatedAt}::text::timestamptz)`;
	await seedSessionSandboxFixture(sql, id);
}

function client(actor = "owner") {
	return createClient({
		baseUrl: origin,
		headers: { Cookie: `fixture-session=${actor}` },
	});
}
async function page(limit?: number, cursor?: string, actor = "owner") {
	const result = await generated.listRecentPersonalConversationsV2({
		client: client(actor),
		query: {
			...(limit === undefined ? {} : { limit }),
			...(cursor === undefined ? {} : { cursor }),
		},
	});
	expect(
		result.response.status,
		JSON.stringify({ limit: limit ?? 50, cursor, error: result.error }),
	).toBe(200);
	return ConversationPageV1Schema.parse(result.data);
}
async function error(
	url: string,
	status: number,
	code: string,
	headers: Record<string, string> = { Cookie: "fixture-session=owner" },
) {
	const response = await fetch(`${origin}${url}`, { headers });
	expect(response.status).toBe(status);
	const body = await response.json();
	expect(body).toMatchObject({ code });
	expect(JSON.stringify(body)).not.toContain("private");
}
const recentPath = "/api/v2/me/conversations/recent";

beforeAll(async () => {
	database = await startPostgresTestDatabase("1027-personal-recent");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl);
	query = new PostgresConversationQueryV1({
		databaseUrl: database.databaseUrl,
	});
	const unused = async () => {
		throw new Error("unused fixture adapter");
	};
	assembly = assemblePlatformApi({
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
		databaseUrl: database.databaseUrl,
		identity,
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
	server = serve({
		fetch: createPlatformApp(assembly.dependencies).fetch,
		hostname: "127.0.0.1",
		port: 0,
	});
	if (!server.listening) await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Fixture API did not bind");
	origin = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		server ? server.close((err) => (err ? reject(err) : resolve())) : resolve(),
	);
	await assembly?.close();
	await query?.close();
	await sql?.end();
	await database?.stop();
});

beforeEach(async () => {
	disabled = false;
	directoryFails = false;
	browserFails = false;
	organizations = ["team"];
	await sql`truncate platform.agents, platform.conversations cascade`;
	await seedAgent("a");
	await seedAgent("b");
	await seedAgent("c");
});

describe("recent generated client → production assembly/HTTP/Core → PostgreSQL", () => {
	it("hides legacy Conversations without a persistent Sandbox binding", async () => {
		await seedConversation("legacy", "a", "2026-09-06T00:00:00Z");
		await seedConversation("bound", "a", "2026-09-06T00:00:01Z");
		await sql`delete from platform.session_sandbox_allocations where conversation_id='legacy'`;
		expect((await page()).items.map((item) => item.conversationId)).toEqual([
			"bound",
		]);
		expect(
			await query.get({ actorId: "owner", channelId: "web" }, "legacy"),
		).toBeUndefined();
	});

	it("returns global top-N and traverses 132 rows with stable timestamp/ID ties and no per-Agent cap", async () => {
		for (let index = 0; index < 132; index++) {
			await seedConversation(
				`c-${String(index).padStart(3, "0")}`,
				["a", "a", "a", "b", "c"][index % 5] ?? "a",
				`2026-09-06T00:${String(Math.floor((131 - index) / 3)).padStart(2, "0")}:00.000900Z`,
			);
		}
		const expected =
			await sql`select id from platform.conversations order by updated_at desc, id desc`;
		for (const limit of [undefined, 1, 100]) {
			// The first read exercises this fresh Store pool's cold array binding.
			const rows = await query.readRecentPersonalConversations({
				user: {
					schemaVersion: 1,
					userId: "owner",
					accountStatus: "active",
					organizationIds: ["team"],
					authorizationRevision: "current-directory",
				},
				limit: (limit ?? 50) + 1,
			});
			expect(rows.map((row) => row.projection.conversationId)).toEqual(
				expected.slice(0, (limit ?? 50) + 1).map((row) => row.id),
			);
			const result = await page(limit);
			expect(result.items.map((item) => item.conversationId)).toEqual(
				expected.slice(0, limit ?? 50).map((row) => row.id),
			);
			const core = await assembly.dependencies.conversation.recent?.list(
				"owner",
				limit === undefined ? {} : { limit },
			);
			expect(core?.items.map((item) => item.conversationId)).toEqual(
				expected.slice(0, limit ?? 50).map((row) => row.id),
			);
		}
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const result = await page(50, cursor);
			seen.push(...result.items.map((item) => item.conversationId));
			cursor = result.nextCursor ?? undefined;
		} while (cursor);
		expect(seen).toEqual(expected.map((row) => row.id));
		expect(new Set(seen).size).toBe(132);
	});

	it("uses PostgreSQL microseconds across a millisecond boundary instead of the public Date projection", async () => {
		await seedConversation("a-new", "a", "2026-09-06T00:00:00.000900Z");
		await seedConversation("z-old", "b", "2026-09-06T00:00:00.000100Z");
		const parameter = await sql
			.unsafe("select $1::text::timestamptz", ["2026-09-06T00:00:00.000900Z"])
			.describe();
		expect(parameter.types).toEqual([25]);
		const stored = await sql`select id,
			to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as timestamp
			from platform.conversations order by updated_at desc, id desc`;
		expect(stored.map((row) => [row.id, row.timestamp])).toEqual([
			["a-new", "2026-09-06T00:00:00.000900Z"],
			["z-old", "2026-09-06T00:00:00.000100Z"],
		]);
		const first = await page(1);
		const second = await page(1, first.nextCursor ?? undefined);
		expect(first.items[0]?.conversationId).toBe("a-new");
		expect(second.items[0]?.conversationId).toBe("z-old");
		expect(first.items[0]?.updatedAt).toBe(second.items[0]?.updatedAt);
		expect(
			Buffer.from(
				(first.nextCursor ?? "").slice("recent.v1.".length),
				"base64url",
			).toString(),
		).toContain(".000900Z");
		const rows = await query.readRecentPersonalConversations({
			user: {
				schemaVersion: 1,
				userId: "owner",
				accountStatus: "active",
				organizationIds: ["team"],
				authorizationRevision: "now",
			},
			limit: 3,
		});
		expect(rows.map((row) => row.position.updatedAt)).toEqual([
			"2026-09-06T00:00:00.000900Z",
			"2026-09-06T00:00:00.000100Z",
		]);
	});

	it("excludes >250 newer unauthorized/self-managed/foreign-channel rows before the global limit", async () => {
		await seedAgent("unauthorized");
		await seedAgent("self", "available", "updating", true, true);
		await seedAgent("unknown");
		await sql`delete from platform.agent_owners where agent_id in ('unauthorized','unknown')`;
		await sql`delete from platform.agent_availability where agent_id in ('unauthorized','unknown')`;
		await sql`delete from platform.workload_reconciliations where agent_id = 'unknown'`;
		for (let index = 0; index < 260; index++) {
			await seedConversation(
				`excluded-${index}`,
				["unauthorized", "self", "unknown"][index % 3] ?? "self",
				"2026-09-07T00:00:00.000000Z",
			);
		}
		await seedConversation(
			"unknown-other",
			"a",
			"2026-09-08T00:00:00.000000Z",
			"other",
		);
		await seedConversation(
			"wecom",
			"a",
			"2026-09-08T00:00:00.000000Z",
			"owner",
			"wecom",
		);
		await seedConversation(
			"api",
			"a",
			"2026-09-08T00:00:00.000000Z",
			"owner",
			"api",
		);
		for (let index = 0; index < 126; index++)
			await seedConversation(
				`eligible-${String(index).padStart(3, "0")}`,
				["a", "b", "c"][index % 3] ?? "a",
				"2026-09-06T00:00:00.000000Z",
			);
		const first = await page();
		expect(first.items).toHaveLength(50);
		expect(first.items.map((item) => item.conversationId)).toEqual(
			Array.from(
				{ length: 50 },
				(_, i) => `eligible-${String(125 - i).padStart(3, "0")}`,
			),
		);
	});

	it("isolates owner, shared user and administrator histories and rereads grants through old cursors", async () => {
		for (const actor of ["owner", "other", "admin"])
			for (const id of ["a", "z"])
				await seedConversation(
					`${actor}-${id}`,
					"a",
					"2026-09-06T00:00:00.000000Z",
					actor,
				);
		const first = await page(1);
		expect(
			(await page(100, undefined, "other")).items.map(
				(item) => item.conversationId,
			),
		).toEqual(["other-z", "other-a"]);
		expect(
			(await page(100, undefined, "admin")).items.map(
				(item) => item.conversationId,
			),
		).toEqual(["admin-z", "admin-a"]);
		await error(
			`${recentPath}?cursor=${first.nextCursor}`,
			400,
			"INVALID_REQUEST",
			{ Cookie: "fixture-session=other" },
		);
		await sql`delete from platform.agent_owners where agent_id='a'`;
		organizations = [];
		expect((await page(50, first.nextCursor ?? undefined)).items).toEqual([]);
		disabled = true;
		await error(
			`${recentPath}?cursor=${first.nextCursor}`,
			403,
			"AUTHORIZATION_REVOKED",
		);
	});

	it("retains stopped, disabled, creating, updating, starting and faulted histories with the existing send gates", async () => {
		const states = [
			["stopped", "stopped", "ready", false],
			["disabled", "disabled", "ready", false],
			["creating", "creating", "ready", false],
			["failed", "creation_failed", "ready", false],
			["updating", "available", "updating", true],
			["starting", "available", "starting", false],
			["faulted", "available", "unavailable", false],
		] as const;
		for (const [id, status, service, custom] of states) {
			await seedAgent(id, status, service, custom);
			await seedConversation(
				`history-${id}`,
				id,
				"2026-09-06T00:00:00.000000Z",
			);
			const authorization =
				await assembly.dependencies.conversation.authorization.authorize(
					{
						schemaVersion: 1,
						userId: "owner",
						displayName: "Owner",
						accountStatus: "active",
						organizationIds: ["team"],
						roles: ["employee"],
						authorizationRevision: "old",
					},
					{
						schemaVersion: 1,
						operation: "message",
						conversationId: `history-${id}`,
					},
				);
			expect(authorization.outcome).not.toBe("allowed");
		}
		expect((await page()).items.map((item) => item.agentId).sort()).toEqual(
			states.map(([id]) => id).sort(),
		);
	});

	it.each(["missing", "stale", "unverified"])(
		"returns explicit unavailable for authorized %s channel facts without poisoning foreign subjects",
		async (kind) => {
			await seedAgent("bad", "available", "ready", true);
			if (kind === "missing")
				await sql`delete from platform.workload_reconciliations where agent_id='bad'`;
			if (kind === "stale")
				await sql`update platform.workload_reconciliations set state=jsonb_set(state,'{sourceConfigurationRevision}','1') where agent_id='bad'`;
			if (kind === "unverified")
				await sql`update platform.workload_reconciliations set state=state || '{"verified":null,"verifiedRevision":null}'::jsonb where agent_id='bad'`;
			await seedConversation(
				"foreign-bad",
				"bad",
				"2026-09-06T00:00:00.000000Z",
				"other",
			);
			expect((await page()).items).toEqual([]);
			await seedConversation("own-bad", "bad", "2026-09-06T00:00:00.000000Z");
			await error(recentPath, 503, "DEPENDENCY_UNAVAILABLE");
		},
	);

	it("refreshes the first page after an update and returns dependency failures as errors", async () => {
		await seedConversation("new", "a", "2026-09-06T00:01:00.000000Z");
		await seedConversation("old", "b", "2026-09-06T00:00:00.000000Z");
		expect((await page(1)).items[0]?.conversationId).toBe("new");
		await sql`update platform.conversations set updated_at='2026-09-08T00:00:00.000000Z' where id='old'`;
		expect((await page(1)).items[0]?.conversationId).toBe("old");
		directoryFails = true;
		await error(recentPath, 503, "DEPENDENCY_UNAVAILABLE");
		directoryFails = false;
		browserFails = true;
		await error(recentPath, 503, "DEPENDENCY_UNAVAILABLE");
		browserFails = false;
		await sql`alter table platform.conversations rename to unavailable_conversations`;
		try {
			await error(recentPath, 503, "DEPENDENCY_UNAVAILABLE");
		} finally {
			await sql`alter table platform.unavailable_conversations rename to conversations`;
		}
	});

	it("keeps original multi-Execution history and exposes metadata without bodies or internal facts", async () => {
		await seedConversation("history", "a", "2026-09-06T00:00:00.000000Z");
		for (const index of [1, 2]) {
			await sql`insert into platform.conversation_executions (execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,created_at,updated_at)
        values (${`execution-${index}`},'history','a','owner','web',${`turn-${index}`},'completed',1,1,'old',now(),now())`;
			await sql`update platform.conversation_executions e set sandbox_id=s.sandbox_id from platform.session_sandbox_allocations s where e.execution_id=${`execution-${index}`} and s.conversation_id=e.conversation_id`;
			await sql`insert into platform.conversation_messages (message_id,conversation_id,actor_id,role,text,execution_id,status,created_at,updated_at)
        values (${`message-${index}`},'history','owner','user',${`private-body-${index}`},${`execution-${index}`},'submitted',now(),now())`;
			await sql`insert into platform.conversation_events
				(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source)
				values (${`event-${index}`},'history',${`execution-${index}`},${`adapter-${index}`},1,${index},'text.delta',
				${sql.json({ type: "text.delta", text: `private-result-${index}` })},${String(index).repeat(64)},${`runtime-${index}`},now(),'runtime')`;
		}
		await sql`update platform.conversations set last_conversation_cursor=2 where id='history'`;
		const before = await query.get(
			{ actorId: "owner", channelId: "web" },
			"history",
		);
		const result = await page();
		expect(JSON.stringify(result)).not.toMatch(
			/private-body|execution-1|sourceConfiguration|imageDigest|ownerIds/,
		);
		expect(result.items[0]?.conversationId).toBe("history");
		expect(
			await query.get({ actorId: "owner", channelId: "web" }, "history"),
		).toEqual(before);
		expect(before?.executions.map((item) => item.executionId).sort()).toEqual([
			"execution-1",
			"execution-2",
		]);
		expect(before?.events.map((item) => item.executionId)).toEqual([
			"execution-1",
			"execution-2",
		]);
		for (const index of [1, 2]) {
			const detail = await query.getExecution(
				{ actorId: "owner", channelId: "web" },
				"history",
				`execution-${index}`,
			);
			expect(detail?.events.map((item) => item.executionId)).toEqual([
				`execution-${index}`,
			]);
		}
	});

	it.each([
		"actorId=other",
		"channelId=wecom",
		"agentIds=a",
		"scope=all",
		"order=id.asc",
		"limit=0",
		"limit=101",
		"limit=1&limit=2",
		"cursor=x&cursor=y",
		"cursor=v1.b2xk",
		"cursor=recent.v2.eA",
		"limit=1.5",
	])("rejects strict query override/malformed input %s", async (search) => {
		await error(`${recentPath}?${search}`, 400, "INVALID_REQUEST");
	});

	it.each([
		[0, "foreign-query"],
		[1, "other"],
		[2, "wecom"],
		[3, "id.asc"],
		[4, "2026-09-06T00:00:00.000Z"],
		[4, "0000-01-01T00:00:00.000000Z"],
		[4, "2026-02-30T00:00:00.000900Z"],
	])(
		"rejects modified cursor binding/timestamp at HTTP (%s, %s)",
		async (index, value) => {
			await seedConversation("first", "a", "2026-09-07T00:00:00.000000Z");
			await seedConversation("last", "a", "2026-09-06T00:00:00.000000Z");
			const result = await page(1);
			const data = JSON.parse(
				Buffer.from(
					(result.nextCursor ?? "").slice("recent.v1.".length),
					"base64url",
				).toString(),
			);
			data[index] = value;
			const cursor = `recent.v1.${Buffer.from(JSON.stringify(data)).toString("base64url")}`;
			await error(`${recentPath}?cursor=${cursor}`, 400, "INVALID_REQUEST");
		},
	);

	it("requires the browser cookie and ignores forged identity headers", async () => {
		await error(recentPath, 401, "AUTHENTICATION_REQUIRED", {
			Authorization: "Bearer forged",
			"x-user-id": "owner",
		});
	});
});
