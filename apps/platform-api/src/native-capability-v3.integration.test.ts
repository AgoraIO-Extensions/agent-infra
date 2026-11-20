import { NativeCapabilityInvocationResponseV1Schema } from "@agent-infra/contracts/pilot";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.js";
import {
	openPostgresTestClient,
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { seedSessionSandboxFixture } from "../../../packages/platform-store/src/session-sandbox.fixture.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import type { IdentityContext } from "./http/identity.js";

const conversationId = "v3-conversation";
const agentId = "v3-agent";
const originalExecutionId = "v3-original-execution";
const agentAuthorizationRevision = "agent-auth-1";
const identity: IdentityContext = {
	schemaVersion: 1,
	userId: "v3-owner",
	displayName: "Synthetic V3 owner",
	accountStatus: "active",
	organizationIds: [],
	roles: ["employee"],
	authorizationRevision: "browser-1",
};
const { modelConfiguration } = agentConfigurationConformanceRecordV1;
if (!modelConfiguration) throw new Error("Missing model fixture");
const configuration = {
	...agentConfigurationConformanceRecordV1,
	schemaVersion: 3,
	agentId,
	revision: 1,
	modelConfiguration: {
		...modelConfiguration,
		defaultOptionId: "model-primary",
		defaultReasoningLevel: "high",
		options: modelConfiguration.options.map(
			({ credential: _credential, ...option }) => ({
				...option,
				optionId: "model-primary",
				reasoningLevels: ["high"],
			}),
		),
	},
};
const command = {
	schemaVersion: 2,
	id: "c".repeat(64),
	kind: "command",
	name: "compact",
	description: "Compact the native session",
	source: { name: "codex", version: "0.153.0" },
	parameters: [],
	effect: "state_changing",
	availability: "available",
} as const;
const directoryRevision = "d".repeat(64);
const invocation = {
	schemaVersion: 3,
	capabilityId: command.id,
	directoryRevision,
	parameters: "",
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-primary",
		reasoningLevel: "high",
	},
	idempotencyKey: "v3-key",
	requestId: "v3-request",
	traceId: "v3-trace",
};

let database: PostgresTestDatabase | undefined;
let db: postgres.Sql;
let assembly: PlatformApiAssembly;
let app: ReturnType<typeof createPlatformApp>;
let afterDirectoryRead: () => Promise<void>;
const unused = async (): Promise<never> => {
	throw new Error("Unexpected fixture adapter call");
};

beforeAll(async () => {
	database = await startPostgresTestDatabase("native-capability-v3-api");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	db = openPostgresTestClient(database);
	assembly = assemblePlatformApi({
		databaseUrl: database.databaseUrl,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
		identity: {
			resolve: async () => identity,
			resolveUser: async (userId) => ({
				schemaVersion: 1,
				userId,
				accountStatus: "active",
				organizationIds: [],
				authorizationRevision: "directory-auth-1",
			}),
			hydrateUsers: async () => [],
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
		// Only the external Runtime directory is controlled. HTTP, admission and Store use default assembly.
		nativeMetadata: {
			reader: {
				read: async (
					_identity,
					conversation,
					execution,
					selector,
					_context,
					version,
				) => {
					if (
						conversation !== conversationId ||
						execution !== originalExecutionId ||
						selector !== "commands" ||
						version !== 2
					)
						return null;
					await afterDirectoryRead();
					return {
						schemaVersion: 1,
						projectionVersion: 2,
						selector: "commands",
						revision: directoryRevision,
						capabilities: [{ ...command, parameters: [] }],
					};
				},
			},
		},
	});
	app = createPlatformApp(assembly.dependencies);
}, 120_000);

afterAll(async () => {
	await assembly?.close();
	await db?.end();
	await database?.stop();
});

beforeEach(async () => {
	afterDirectoryRead = async () => {};
	await db`truncate platform.agents, platform.conversations, platform.conversation_executions,
		platform.relay_key_subjects, platform.idempotency_records, platform.outbox_items,
		platform.conversation_audit_events, platform.audit_events cascade`;
	await db`insert into platform.agents(id,current_configuration_revision,authorization_revision)
		values (${agentId},1,${agentAuthorizationRevision})`;
	await db`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,
		trace_id,request_id,submitted_at,management_revision,approval_revision,
		service_availability,desired_state,workload_revision,fence)
		values ('v3-application',${agentId},${identity.userId},'Fixture','Synthetic','available',
		'fixture-trace','fixture-request',now(),1,1,'ready','running',1,1)`;
	await db`insert into platform.agent_owners(agent_id,owner_id,created_at)
		values (${agentId},${identity.userId},now())`;
	await db`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration)
		values (${agentId},1,'fixture',now(),${db.json(configuration as unknown as postgres.JSONValue)})`;
	await db`insert into platform.conversations(id,agent_id,actor_id,principal_type,channel_id,
		status,session_generation,host_session_ref,authorization_revision)
		values (${conversationId},${agentId},${identity.userId},'user','web','ready',1,'v3-host',${agentAuthorizationRevision})`;
	await db`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version)
		values ('personal',${identity.userId},1,1)`;
	await db`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext)
		values ('personal',${identity.userId},1,'v3-key-ref',${db.json({ purpose: "personal", subjectId: identity.userId, keyId: "v3-key-ref", keyVersion: 1 })})`;
	await db`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,
		actor_id,principal_type,channel_id,turn_id,status,session_generation,authorization_revision,
		runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,created_at,updated_at,
		execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version)
		values (${originalExecutionId},${conversationId},${agentId},${identity.userId},'user','web',
		'v3-original-turn','completed',1,${agentAuthorizationRevision},'v4',${"a".repeat(43)},'v3-host',now(),now(),'web','personal',${identity.userId},'v3-key-ref',1)`;
	await seedSessionSandboxFixture(db, conversationId);
});

async function invoke(body = invocation) {
	const response = await app.request(
		`/api/v2/conversations/${conversationId}/native-capability/invoke`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return {
		status: response.status,
		body: NativeCapabilityInvocationResponseV1Schema.parse(
			await response.json(),
		),
	};
}

it("admits an owner's V3 command and replays only the saved Execution", async () => {
	const first = await invoke();
	expect(first).toMatchObject({
		status: 202,
		body: {
			outcome: "accepted",
			result: { conversationId, executionId: expect.any(String) },
		},
	});
	const replay = await invoke();
	expect(replay).toEqual({
		...first,
		body: { ...first.body, outcome: "replayed" },
	});
	expect(await durableCounts()).toEqual({
		executions: 1,
		outbox: 1,
		idempotency: 1,
	});
});

async function durableCounts() {
	const [counts] = await db`select
		(select count(*)::int from platform.conversation_executions where conversation_id=${conversationId} and execution_id<>${originalExecutionId}) as executions,
		(select count(*)::int from platform.outbox_items where operation='conversation.native-capability.invoke.v2') as outbox,
		(select count(*)::int from platform.idempotency_records where command_type='native-capability.invoke.v2') as idempotency`;
	return counts;
}

it("denies a grant revoked after directory discovery without reserving the operation", async () => {
	afterDirectoryRead = async () => {
		await db.begin(async (transaction) => {
			await transaction`update platform.agents set authorization_revision='agent-auth-revoked' where id=${agentId}`;
			await transaction`delete from platform.agent_owners where agent_id=${agentId}`;
		});
	};
	expect(await invoke()).toMatchObject({
		status: 403,
		body: { outcome: "denied" },
	});
	expect(await durableCounts()).toEqual({
		executions: 0,
		outbox: 0,
		idempotency: 0,
	});
});

it.each([
	["submitted", 409, "busy"],
	["waiting", 409, "busy"],
	["unknown", 503, "unknown"],
] as const)(
	"does not add an Execution or outbox item while the conversation has a %s operation",
	async (status, httpStatus, outcome) => {
		const first = await invoke();
		if (first.body.outcome !== "accepted")
			throw new Error("Missing fixture admission");
		await db`update platform.conversation_executions set status=${status},
			task_wait_order=${status === "waiting" ? 1 : null},
			task_wait_deadline=${status === "waiting" ? new Date(Date.now() + 60_000) : null}
			where execution_id=${first.body.result.executionId}`;
		expect(
			await invoke({ ...invocation, idempotencyKey: "another-key" }),
		).toEqual({
			status: httpStatus,
			body: { outcome },
		});
		if (status === "unknown") {
			expect(await invoke()).toEqual({
				...first,
				body: { ...first.body, outcome: "replayed" },
			});
		}
		expect(await durableCounts()).toEqual({
			executions: 1,
			outbox: 1,
			idempotency: 1,
		});
	},
);

it("reports a real PostgreSQL lock timeout as unavailable without exposing the error", async () => {
	const locked = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let blocker: Promise<unknown> | undefined;
	afterDirectoryRead = () => {
		blocker = db.begin(async (transaction) => {
			await transaction`select id from platform.conversations where id=${conversationId} for update`;
			locked.resolve();
			await release.promise;
		});
		return Promise.race([locked.promise, blocker.then(() => {})]);
	};
	try {
		expect(await invoke()).toEqual({
			status: 503,
			body: { outcome: "unavailable" },
		});
	} finally {
		release.resolve();
		await blocker;
	}
	expect(blocker).toBeDefined();
	expect(await durableCounts()).toEqual({
		executions: 0,
		outbox: 0,
		idempotency: 0,
	});
}, 15_000);
