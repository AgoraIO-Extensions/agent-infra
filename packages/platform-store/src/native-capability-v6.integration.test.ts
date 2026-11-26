import { createHash, generateKeyPairSync } from "node:crypto";
import {
	type CurrentTaskUserV1,
	createConversationDispatchUseCaseV1,
	createConversationEventUseCaseV1,
	createNativeCapabilityAdmissionUseCaseV6,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readCatalogAnchorFixture } from "../../../apps/platform-api/src/native-catalog-anchor.test-support.js";
import { createConversationRuntimeV2 } from "../../../apps/platform-worker/src/conversation-runtime.js";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "../../../apps/platform-worker/src/kubernetes.fixture.ts";
import { workloadResourceConfigurationHashV1 } from "../../../apps/platform-worker/src/workload-runtime.ts";
import { createCompactHostFixture } from "../../agent-runtime/src/compact-host.test-support.js";
import { RuntimeHostError } from "../../agent-runtime/src/errors.js";
import { RuntimeNativeCapabilityRequestV6Schema } from "../../contracts/src/runtime/host-v6.js";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.js";
import { parseClaim } from "../../platform-core/src/conversation-dispatch-input.js";
import { PostgresConversationDispatchStoreV1 } from "./conversation-dispatch.js";
import { PostgresConversationEventTransactionV1 } from "./conversation-events.js";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import { PostgresConversationQueryV1 } from "./conversation-query.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { seedSessionSandboxFixture } from "./session-sandbox.fixture.js";
import { PostgresTaskAuthorizationStoreV1 } from "./task-authorization.js";

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;
let store: PostgresConversationExecutionTransactionV1;
let databaseUrl: string;

function hostErrorResponse(error: unknown, traceId: string) {
	if (!(error instanceof RuntimeHostError)) throw error;
	return Response.json(
		{
			schemaVersion: 1,
			code: error.code,
			message: error.message,
			retryable: error.retryable,
			traceId,
		},
		{ status: error.httpStatus },
	);
}

const authority = {
	conversationId: "native-v6-conversation",
	agentId: "native-v6-agent",
	actorId: "native-v6-user",
	channelId: "web",
	principal: { kind: "user" as const, id: "native-v6-user" },
	executionSource: "web" as const,
	authorizationRevision: "native-v6-auth",
	sessionGeneration: 1,
	hostSessionRef: "native-v6-host",
};
const taskAuthority = {
	schemaVersion: 1 as const,
	actorId: authority.actorId,
	agentId: authority.agentId,
	channelId: authority.channelId,
	authorizationRevision: authority.authorizationRevision,
	supportsSupplementaryInstruction: false,
	taskBoundary: {
		schemaVersion: 1 as const,
		principal: authority.principal,
		agentId: authority.agentId,
		channelId: authority.channelId,
		identityRevision: "identity-v6",
		agentAuthorizationRevision: authority.authorizationRevision,
		accessSources: [{ kind: "user" as const, userId: authority.actorId }],
	},
};
let currentUser: CurrentTaskUserV1;
let authorizationReads = 0;
let revokeOnAuthorizationRead = Number.POSITIVE_INFINITY;
const userDirectory = { resolveUser: async () => currentUser };
const model = agentConfigurationConformanceRecordV1.modelConfiguration;
if (!model) throw new Error("missing model fixture");
const configuration = {
	...agentConfigurationConformanceRecordV1,
	schemaVersion: 3,
	agentId: authority.agentId,
	revision: 1,
	modelConfiguration: {
		...model,
		defaultOptionId: "model-primary",
		defaultReasoningLevel: "high",
		options: model.options.map(({ credential: _credential, ...option }) => ({
			...option,
			optionId: "model-primary",
			reasoningLevels: ["medium", "high"],
		})),
	},
};

const keyBinding = {
	purpose: "personal" as const,
	subjectId: authority.actorId,
	ciphertextRef: "native-v6-key",
	version: 1,
};
function request(executionId = "native-v6-execution") {
	const wireRequest = {
		schemaVersion: 6 as const,
		requestId: "native-v6-request",
		traceId: "native-v6-trace",
		principal: authority.principal,
		executionSource: authority.executionSource,
		channelId: authority.channelId,
		agentId: authority.agentId,
		conversationId: authority.conversationId,
		executionId,
		turnId: `turn-${executionId}`,
		sessionGeneration: 1,
		hostSessionRef: authority.hostSessionRef,
		operation: {
			kind: "execution" as const,
			id: executionId,
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		grant: {
			schemaVersion: 6 as const,
			format: "runtime-execution-jws" as const,
			token: "controlled.test.grant",
		},
		keyBinding,
		capabilityId: "c".repeat(64),
		capabilityKind: "command" as const,
		directoryRevision: "d".repeat(64),
		parameters: "",
		parametersDigest: createHash("sha256").update("").digest("hex"),
		capabilitySourceVersion: "0.153.0",
		selection: {
			schemaVersion: 1 as const,
			modelOptionId: "model-primary",
			reasoningLevel: "high",
		},
		configVersion: "1",
	};
	RuntimeNativeCapabilityRequestV6Schema.parse(wireRequest);
	const { grant: _grant, ...context } = wireRequest;
	return context;
}
type PreparedInput = ReturnType<typeof request>;
function publicInvocation(
	input: PreparedInput = request(),
	idempotencyKey = input.executionId,
) {
	return {
		schemaVersion: 3 as const,
		conversationId: input.conversationId,
		capabilityId: input.capabilityId,
		directoryRevision: input.directoryRevision,
		parameters: input.parameters,
		selection: input.selection,
		idempotencyKey,
		requestId: input.requestId,
		traceId: input.traceId,
	};
}
function useCase(currentKey = keyBinding, modelConfigurationRevision = 1) {
	const internal = createNativeCapabilityAdmissionUseCaseV6({
		authorization: {
			authorize: async () => {
				if (++authorizationReads >= revokeOnAuthorizationRead)
					return { outcome: "denied" as const };
				return {
					outcome: "allowed" as const,
					authority,
					taskAuthority,
					keyBinding: currentKey,
					modelConfigurationRevision,
				};
			},
		},
		transaction: store,
	});
	return {
		admit: (input: PreparedInput, invocation = publicInvocation(input)) =>
			internal.admit(input, invocation),
	};
}
beforeAll(async () => {
	const local = process.env.V6_ADMISSION_TEST_DATABASE_URL;
	if (local) {
		const parsed = new URL(local);
		if (
			!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
			!parsed.pathname.startsWith("/native_v6_")
		)
			throw new Error(
				"V6 admission tests require an isolated local test database",
			);
		databaseUrl = local;
	} else {
		database = await startPostgresTestDatabase("native-v6-admission");
		databaseUrl = database.databaseUrl;
	}
	await migratePlatformDatabase({ databaseUrl });
	client = postgres(databaseUrl, { max: 3 });
	store = new PostgresConversationExecutionTransactionV1({
		databaseUrl,
		userDirectory,
	});
}, 120_000);
afterAll(async () => {
	await store?.close();
	await client?.end({ timeout: 5 });
	await database?.stop();
});
beforeEach(async () => {
	currentUser = {
		schemaVersion: 1,
		userId: authority.actorId,
		accountStatus: "active",
		organizationIds: [],
		authorizationRevision: "identity-v6",
	};
	authorizationReads = 0;
	revokeOnAuthorizationRead = Number.POSITIVE_INFINITY;
	await client`truncate platform.agents, platform.conversations, platform.conversation_executions,
 platform.outbox_items, platform.persisted_events, platform.idempotency_records, platform.conversation_audit_events, platform.relay_key_subjects, platform.platform_user_disables, platform.audit_events cascade`;
	await client`insert into platform.agents (id,current_configuration_revision,authorization_revision)
 values (${authority.agentId},1,${authority.authorizationRevision})`;
	await client`insert into platform.conversations (id,agent_id,actor_id,principal_type,channel_id,status,session_generation,host_session_ref,authorization_revision,last_conversation_cursor)
 values (${authority.conversationId},${authority.agentId},${authority.actorId},'user','web','ready',1,${authority.hostSessionRef},${authority.authorizationRevision},0)`;
	await client`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,configuration)
 values (${authority.agentId},1,'native-v6-fixture',now(),${client.json(configuration as unknown as postgres.JSONValue)})`;
	await seedSessionSandboxFixture(client, authority.conversationId);
	await client`insert into platform.relay_key_subjects (purpose,subject_id,last_version,current_version) values ('personal',${authority.actorId},1,1)`;
	await client`insert into platform.relay_key_versions (purpose,subject_id,key_version,key_id,ciphertext) values ('personal',${authority.actorId},1,${keyBinding.ciphertextRef},${client.json({ purpose: "personal", subjectId: authority.actorId, keyId: keyBinding.ciphertextRef, keyVersion: 1 })})`;
});
async function effects() {
	const [row] = await client`select
 (select count(*)::int from platform.conversation_executions where execution_id <> 'occupied') as executions,
 (select count(*)::int from platform.outbox_items where operation='conversation.native-capability.invoke.v2') as outbox,
 (select count(*)::int from platform.idempotency_records) as idempotency,
 (select count(*)::int from platform.conversation_audit_events) as audit,
 (select count(*)::int from platform.task_authorization_records) as "taskAuthorization",
 (select count(*)::int from platform.audit_events where action='task.authorization.accepted') as "authorizationAudit"`;
	return row;
}
async function settledAdmissions<T>(pending: Promise<T>[]): Promise<T[]> {
	const results = await Promise.allSettled(pending);
	return results.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
}
const noEffects = {
	executions: 0,
	outbox: 0,
	idempotency: 0,
	audit: 0,
	taskAuthorization: 0,
	authorizationAudit: 0,
};
it.each(["waiting", "submitted", "processing", "unknown"] as const)(
	"refuses %s occupancy before all durable writes",
	async (status) => {
		await client`insert into platform.conversation_executions
 (execution_id,conversation_id,sandbox_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,task_wait_order,task_wait_deadline,created_at,updated_at)
 select 'occupied',c.id,s.sandbox_id,c.agent_id,c.actor_id,c.channel_id,'occupied-turn',${status},1,0,c.authorization_revision,
 ${status === "waiting" ? 1 : null},${status === "waiting" ? new Date(Date.now() + 60000) : null},now(),now()
 from platform.conversations c join platform.session_sandbox_allocations s on s.conversation_id=c.id where c.id=${authority.conversationId}`;
		expect(await useCase().admit(request())).toMatchObject({
			outcome: status === "unknown" ? "unknown" : "busy",
		});
		expect(await effects()).toEqual(noEffects);
	},
);
it.each(["active", "unavailable"] as const)(
	"rejects a %s Conversation even without an execution row",
	async (status) => {
		await client`update platform.conversations set status=${status} where id=${authority.conversationId}`;
		expect(await useCase().admit(request())).toMatchObject({
			outcome: "denied",
		});
		expect(await effects()).toEqual(noEffects);
	},
);
it("rejects a stopped Sandbox", async () => {
	await client`update platform.session_sandbox_allocations set desired_state='stopped' where conversation_id=${authority.conversationId}`;
	expect(await useCase().admit(request())).toMatchObject({
		outcome: "unavailable",
	});
	expect(await effects()).toEqual(noEffects);
});
it("checks the current Agent authorization revision", async () => {
	await client`update platform.agents set authorization_revision='revoked' where id=${authority.agentId}`;
	expect(await useCase().admit(request())).toMatchObject({ outcome: "denied" });
	expect(await effects()).toEqual(noEffects);
});
async function rotateKey() {
	const next = { ...keyBinding, ciphertextRef: "native-v6-key-2", version: 2 };
	await client`insert into platform.relay_key_versions (purpose,subject_id,key_version,key_id,ciphertext)
 values ('personal',${authority.actorId},2,${next.ciphertextRef},${client.json({ purpose: "personal", subjectId: authority.actorId, keyId: next.ciphertextRef, keyVersion: 2 })})`;
	await client`update platform.relay_key_subjects set last_version=2,current_version=2 where purpose='personal' and subject_id=${authority.actorId}`;
	return next;
}
it("rejects a new operation when its Key is no longer current", async () => {
	await rotateKey();
	expect(await useCase().admit(request())).toMatchObject({ outcome: "denied" });
	expect(await effects()).toEqual(noEffects);
});
it("reports an absent personal Key before writing a new operation", async () => {
	await client`update platform.relay_key_subjects set current_version=null where purpose='personal' and subject_id=${authority.actorId}`;
	await expect(useCase().admit(request())).rejects.toMatchObject({
		code: "personal_relay_key_unavailable",
	});
	expect(await effects()).toEqual(noEffects);
});
it("accepts and persists the newly authorized current Key after rotation", async () => {
	const next = await rotateKey();
	const result = await useCase(next).admit({ ...request(), keyBinding: next });
	expect(result).toMatchObject({
		outcome: "accepted",
		plan: { keyBinding: next },
	});
	const [execution] =
		await client`select relay_key_id,relay_key_version::int from platform.conversation_executions where execution_id=${request().executionId}`;
	expect(execution).toEqual({
		relay_key_id: next.ciphertextRef,
		relay_key_version: 2,
	});
});
it("replays the frozen accepted Key without following the current alias", async () => {
	const accepted = await useCase().admit(request());
	expect(accepted.outcome).toBe("accepted");
	if (accepted.outcome !== "accepted") throw new Error("expected acceptance");
	const before = await effects();
	await rotateKey();
	expect(await useCase().admit(request())).toEqual({
		outcome: "replayed",
		plan: accepted.plan,
	});
	expect(await effects()).toEqual(before);
});
it("serializes same-key admissions and replays the original plan after reopening the Store", async () => {
	const results = await settledAdmissions([
		useCase().admit(request()),
		useCase().admit(request()),
	]);
	expect(results.map((r) => r.outcome).sort()).toEqual([
		"accepted",
		"replayed",
	]);
	expect(await effects()).toEqual({
		executions: 1,
		outbox: 1,
		idempotency: 1,
		audit: 1,
		taskAuthorization: 1,
		authorizationAudit: 1,
	});
	const accepted = results.find((r) => r.outcome === "accepted");
	if (accepted?.outcome !== "accepted") throw new Error("expected acceptance");
	const [outbox] =
		await client`select payload from platform.outbox_items where id=${accepted.plan.outbox.id}`;
	expect(outbox?.payload).toEqual(accepted.plan.outbox.payload);
	await store.close();
	store = new PostgresConversationExecutionTransactionV1({
		databaseUrl,
		userDirectory,
	});
	expect(
		await useCase().admit({
			...request(),
			requestId: "retry",
			traceId: "retry",
		}),
	).toEqual({ outcome: "replayed", plan: accepted.plan });
});
it("serializes different-key admissions into one Execution", async () => {
	const results = await settledAdmissions([
		useCase().admit(request("one")),
		useCase().admit(request("two")),
	]);
	expect(results.map((r) => r.outcome).sort()).toEqual(["accepted", "busy"]);
	expect(await effects()).toEqual({
		executions: 1,
		outbox: 1,
		idempotency: 1,
		audit: 1,
		taskAuthorization: 1,
		authorizationAudit: 1,
	});
});
const failurePoints = [
	{
		stage: "task authorization",
		table: "platform.task_authorization_records",
		event: "insert",
	},
	{
		stage: "authorization audit",
		table: "platform.audit_events",
		event: "insert",
	},
	{ stage: "outbox", table: "platform.outbox_items", event: "insert" },
	{
		stage: "audit",
		table: "platform.conversation_audit_events",
		event: "insert",
	},
	{
		stage: "idempotency completion",
		table: "platform.idempotency_records",
		event: "update",
	},
];
it.each(failurePoints)(
	"rolls back all writes when $stage fails",
	async ({ table, event }) => {
		await client`create sequence platform.v6_failure_hit`;
		await client`create function platform.fail_v6_write() returns trigger language plpgsql as $$begin perform nextval('platform.v6_failure_hit'); raise exception 'controlled transaction failure'; end$$`;
		// Table and event come only from the fixed test cases above.
		await client.unsafe(
			`create trigger fail_v6_write before ${event} on ${table} for each row execute function platform.fail_v6_write()`,
		);
		try {
			await expect(useCase().admit(request())).rejects.toMatchObject({
				code: "unavailable",
			});
			const [hit] = await client`select is_called from platform.v6_failure_hit`;
			expect(hit?.is_called).toBe(true);
			expect(await effects()).toEqual(noEffects);
		} finally {
			await client.unsafe(`drop trigger fail_v6_write on ${table}`);
			await client`drop function platform.fail_v6_write()`;
			await client`drop sequence platform.v6_failure_hit`;
		}
	},
);
it("denies replay after the Agent authorization revision changes", async () => {
	expect(await useCase().admit(request())).toMatchObject({
		outcome: "accepted",
	});
	const before = await effects();
	await client`update platform.agents set authorization_revision='revoked' where id=${authority.agentId}`;
	expect(await useCase().admit(request())).toMatchObject({
		outcome: "denied",
		reason: "authorization_lost",
	});
	expect(await effects()).toEqual(before);
});

it("serializes one public idempotency key even when retries allocate different operation IDs", async () => {
	const one = request("candidate-one");
	const two = request("candidate-two");
	const results = await settledAdmissions([
		useCase().admit(one, publicInvocation(one, "same-public-key")),
		useCase().admit(two, publicInvocation(two, "same-public-key")),
	]);
	expect(results.map((result) => result.outcome).sort()).toEqual([
		"accepted",
		"replayed",
	]);
	const plans = results.map((result) =>
		"plan" in result ? result.plan : null,
	);
	expect(plans[0]).toEqual(plans[1]);
	expect(await effects()).toEqual({
		executions: 1,
		outbox: 1,
		idempotency: 1,
		audit: 1,
		taskAuthorization: 1,
		authorizationAudit: 1,
	});
});

it("returns the original accepted operation after current Key/config and candidate IDs change", async () => {
	const accepted = await useCase().admit(request());
	if (accepted.outcome !== "accepted") throw new Error("expected acceptance");
	const before = await effects();
	const next = await rotateKey();
	const retry = {
		...request("new-candidate"),
		keyBinding: next,
		configVersion: "2",
	};
	expect(
		await useCase(next).admit(
			retry,
			publicInvocation(retry, request().executionId),
		),
	).toEqual({ outcome: "replayed", plan: accepted.plan });
	expect(await effects()).toEqual(before);
});

it("persists a prepared operation before any transport Grant is created", async () => {
	const prepared = request();
	const result = await useCase().admit(prepared);
	expect(result.outcome).toBe("accepted");
	const [row] =
		await client`select payload from platform.outbox_items where operation='conversation.native-capability.invoke.v2'`;
	expect(row?.payload).not.toHaveProperty("grant");
	expect(JSON.stringify(row?.payload)).not.toContain("controlled.test.grant");
	expect(await effects()).toEqual({
		executions: 1,
		outbox: 1,
		idempotency: 1,
		audit: 1,
		taskAuthorization: 1,
		authorizationAudit: 1,
	});
});

it.each(["disabled identity", "identity revision", "platform disable"])(
	"rejects %s using ordinary Execution authority checks",
	async (change) => {
		if (change === "disabled identity")
			currentUser = { ...currentUser, accountStatus: "disabled" };
		else if (change === "identity revision")
			currentUser = { ...currentUser, authorizationRevision: "changed" };
		else
			await client`insert into platform.platform_user_disables(user_id) values (${authority.actorId})`;
		expect(await useCase().admit(request())).toMatchObject({
			outcome: "denied",
		});
		expect(await effects()).toEqual(noEffects);
	},
);

it.each([2, 3])(
	"rejects authorization revoked on read %s before durable writes",
	async (read) => {
		revokeOnAuthorizationRead = read;
		expect(await useCase().admit(request())).toEqual({
			outcome: "denied",
			reason: "authorization_lost",
		});
		expect(authorizationReads).toBe(read);
		expect(await effects()).toEqual(noEffects);
	},
);

it("persists the exact Task boundary and refuses replay after a fresh authorization rejection", async () => {
	expect((await useCase().admit(request())).outcome).toBe("accepted");
	const [record] =
		await client`select boundary from platform.task_authorization_records where execution_id=${request().executionId}`;
	expect(record?.boundary).toEqual(taskAuthority.taskBoundary);
	const before = await effects();
	revokeOnAuthorizationRead = authorizationReads + 2;
	expect(await useCase().admit(request())).toEqual({
		outcome: "denied",
		reason: "authorization_lost",
	});
	expect(await effects()).toEqual(before);
});

it.each(["model", "reasoning"] as const)(
	"rejects a stale %s choice without falling back to defaults",
	async (kind) => {
		const candidate = {
			...request(),
			selection: {
				...request().selection,
				...(kind === "model"
					? { modelOptionId: "removed-model" }
					: { reasoningLevel: "unsupported-reasoning" }),
			},
		};
		expect(await useCase().admit(candidate)).toEqual({ outcome: "stale" });
		expect(await effects()).toEqual(noEffects);
	},
);

async function advanceModelConfiguration() {
	const next = { ...configuration, revision: 2 };
	await client`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,configuration)
 values (${authority.agentId},2,'native-v6-fixture',now(),${client.json(next as unknown as postgres.JSONValue)})`;
	await client`update platform.agents set current_configuration_revision=2 where id=${authority.agentId}`;
}

it("rejects a configuration revision changed after preparation", async () => {
	await advanceModelConfiguration();
	expect(await useCase().admit(request())).toEqual({ outcome: "stale" });
	expect(await effects()).toEqual(noEffects);
});

it("refuses admission when the current model configuration cannot be read", async () => {
	await client`delete from platform.agent_configuration_revisions where agent_id=${authority.agentId}`;
	expect(await useCase().admit(request())).toEqual({
		outcome: "unavailable",
		reason: "metadata_unavailable",
	});
	expect(await effects()).toEqual(noEffects);
});

it("stores the approved model revision and explicit selection on the Execution", async () => {
	await advanceModelConfiguration();
	const result = await useCase(keyBinding, 2).admit({
		...request(),
		configVersion: "2",
	});
	expect(result).toMatchObject({
		outcome: "accepted",
		plan: { modelConfigurationRevision: 2 },
	});
	const [row] =
		await client`select model_configuration_revision::int,model_option_id,reasoning_level
 from platform.conversation_executions where execution_id=${request().executionId}`;
	expect(row).toEqual({
		model_configuration_revision: 2,
		model_option_id: "model-primary",
		reasoning_level: "high",
	});
});

it("replays the original model snapshot after current model configuration changes", async () => {
	const accepted = await useCase().admit(request());
	if (accepted.outcome !== "accepted") throw new Error("expected acceptance");
	const before = await effects();
	await advanceModelConfiguration();
	const candidate = { ...request("new-candidate"), configVersion: "2" };
	expect(
		await useCase(keyBinding, 2).admit(
			candidate,
			publicInvocation(candidate, request().executionId),
		),
	).toEqual({ outcome: "replayed", plan: accepted.plan });
	expect(await effects()).toEqual(before);
});

it.each(["parameters", "selection"] as const)(
	"rejects changed public %s under the original idempotency key",
	async (field) => {
		expect((await useCase().admit(request())).outcome).toBe("accepted");
		const before = await effects();
		const retry =
			field === "parameters"
				? {
						...request("retry"),
						parameters: "changed",
						parametersDigest: createHash("sha256")
							.update("changed")
							.digest("hex"),
					}
				: {
						...request("retry"),
						selection: { ...request().selection, reasoningLevel: "low" },
					};
		expect(
			await useCase().admit(
				retry,
				publicInvocation(retry, request().executionId),
			),
		).toEqual({ outcome: "conflict", reason: "idempotency_conflict" });
		expect(await effects()).toEqual(before);
	},
);

// Dispatch readiness is measured by the DB clock, independently of the test host clock.
async function admitDispatchFixture() {
	const admitted = await useCase().admit(request());
	if (admitted.outcome === "accepted")
		await client`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${admitted.plan.outbox.id}`;
	return admitted;
}

async function seedDispatchWorkload() {
	const deployment = workloadDesiredFixture(
		1,
		authority.agentId,
		"internal-only",
	);
	const config = {
		...configuration,
		source: { ...configuration.source, imageDigest: deployment.imageDigest },
	};
	const capacity = {
		schemaVersion: 1,
		imageDigest: deployment.imageDigest,
		resourceProfileRef: deployment.resourceProfileRef,
		resourceConfigurationHash:
			workloadResourceConfigurationHashV1(workloadTestPolicy),
		maximumConcurrentExecutions: 8,
		conformanceEvidenceHash: "c".repeat(64),
	};
	const version = {
		configuration: config,
		deployment,
		executionCapacity: capacity,
	};
	const state = {
		schemaVersion: 1,
		agentId: authority.agentId,
		sourceConfigurationRevision: 1,
		sourceLifecycleRevision: 1,
		revision: 1,
		fence: 1,
		phase: "ready",
		candidate: version,
		verified: version,
		verifiedRevision: 1,
		identity: { uid: "v6-workload", generation: 1 },
		rollback: false,
		failureCode: null,
		attempts: 0,
	};
	await client`update platform.agent_configuration_revisions set configuration=${client.json(config as unknown as postgres.JSONValue)} where agent_id=${authority.agentId} and revision=1`;
	await client`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,desired_state,service_availability,workload_revision,fence) values('v6-app',${authority.agentId},${authority.actorId},'fixture','fixture','available','trace','request',now(),1,1,'running','ready',1,1)`;
	await client`insert into platform.agent_availability(agent_id,target_type,target_id) values(${authority.agentId},'user',${authority.actorId})`;
	await client`insert into platform.agent_owners(agent_id,owner_id,created_at) values(${authority.agentId},${authority.actorId},now())`;
	await client`insert into platform.workload_reconciliations(agent_id,revision,state,next_attempt_at) values(${authority.agentId},1,${client.json(state as unknown as postgres.JSONValue)},now())`;
	await client`update platform.session_sandbox_allocations set resource_policy=jsonb_build_object('namespace','fixture-sandboxes','resourceConfigurationHash',${capacity.resourceConfigurationHash}::text,'configurationRevision',1,'workloadRevision',1,'managementFence',1,'imageDigest',${deployment.imageDigest}::text) where conversation_id=${authority.conversationId}`;
}

it("dispatches the admitted V6 operation rather than leaving its outbox pending (#4255)", async () => {
	await seedDispatchWorkload();
	const admitted = await admitDispatchFixture();
	expect(admitted.outcome).toBe("accepted");
	if (admitted.outcome !== "accepted") return;
	const dispatch = new PostgresConversationDispatchStoreV1({
		databaseUrl,
		userDirectory,
	});
	try {
		expect(await dispatch.findDispatchable({ limit: 20 })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ itemId: admitted.plan.outbox.id }),
			]),
		);
		const result = await dispatch.claim({
			schemaVersion: 1,
			itemId: admitted.plan.outbox.id,
			workerId: "v6-dispatch-worker",
			leaseDurationMs: 30000,
		});
		expect(result.outcome).toBe("claimed");
		if (result.outcome !== "claimed") return;
		expect(parseClaim(result.claim)).toMatchObject({
			nativeCapabilityV6: { modelOptionId: admitted.plan.modelOptionId },
		});
		for (const change of [
			{ agentId: "wrong-agent" },
			{ actorId: "wrong-user" },
			{ turnId: "wrong-turn" },
			{ sessionGeneration: 2 },
			{ authorizationRevision: "wrong-auth" },
			{ modelConfigurationRevision: 2 },
			{ modelOptionId: "wrong-model" },
			{ reasoningLevel: "low" },
			{ hostSessionRef: "wrong-host" },
			{ deliveryFence: 0 },
			{ executionDeliveryFence: 2 },
			{ nativeCapabilityV6: undefined },
			{ relayKeyBinding: { ...result.claim.relayKeyBinding, keyVersion: 2 } },
		])
			expect(() => parseClaim({ ...result.claim, ...change })).toThrow();
		const [row] =
			await client`select attempt_count,lease_owner from platform.outbox_items where id=${admitted.plan.outbox.id}`;
		expect(row).toMatchObject({
			attempt_count: 1,
			lease_owner: "v6-dispatch-worker",
		});
		expect(
			await dispatch.readRuntimeState({ claim: result.claim }),
		).toMatchObject({
			originalOperationDigest: Buffer.from(
				admitted.plan.operationDigest,
				"hex",
			).toString("base64url"),
			hostSessionRef: authority.hostSessionRef,
		});
		expect(
			await dispatch.prepareRuntimeDispatch({
				claim: result.claim,
				leaseDurationMs: 30000,
			}),
		).toBe(true);
		expect(
			await dispatch.readRuntimeState({ claim: result.claim }),
		).toMatchObject({
			executionStatus: "unknown",
			runtimeSubmitProtocol: "v4",
			originalOperationDigest: Buffer.from(
				admitted.plan.operationDigest,
				"hex",
			).toString("base64url"),
		});
		expect(
			await dispatch.recordRuntimeResponse({
				claim: result.claim,
				hostSessionRef: authority.hostSessionRef,
				originalOperationAccepted: true,
				transition: {
					executionStatus: "processing",
					conversationStatus: "active",
				},
			}),
		).toBe(true);
		await client`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second'
			where id=${admitted.plan.outbox.id}`;
		const reclaimed = await dispatch.claim({
			schemaVersion: 1,
			itemId: admitted.plan.outbox.id,
			workerId: "v6-recovery-worker",
			leaseDurationMs: 30000,
		});
		expect(reclaimed).toMatchObject({
			outcome: "claimed",
			claim: {
				acceptedOriginalHostSessionRef: authority.hostSessionRef,
				operation: "conversation.native-capability.invoke.v2",
			},
		});
		if (reclaimed.outcome === "claimed") {
			expect(parseClaim(reclaimed.claim).acceptedOriginalHostSessionRef).toBe(
				authority.hostSessionRef,
			);
			expect(() =>
				parseClaim({
					...reclaimed.claim,
					acceptedOriginalHostSessionRef: "other-host",
				}),
			).toThrow();
		}
	} finally {
		await dispatch.close();
	}
});

it.each([
	"normal",
	"reclaimed",
	"lost",
	"unknown-result",
	"late-unsent",
	"codex-medium-high",
	"codex-medium-medium",
	"codex-high-high",
	"codex-config-drift",
	"codex-model-drift",
	"codex-lost",
	"codex-unknown",
	"codex-disconnected",
	"denied",
	"busy",
	"rejected",
])(
	"runs V3 through the default Worker to terminal events (mode=%s, #4255)",
	async (mode) => {
		const loseResponse = mode === "lost" || mode === "codex-lost";
		await seedDispatchWorkload();
		const keys = generateKeyPairSync("ed25519");
		const codex = mode.startsWith("codex-")
			? await createCompactHostFixture(
					authority,
					keys.publicKey,
					mode.startsWith("codex-medium-") ? "medium" : "high",
					mode === "codex-config-drift"
						? "configuration-old"
						: "configuration-1-native-fixture",
					mode === "codex-model-drift" ? "gpt-other" : "gpt-5.3-codex",
					mode === "codex-medium-high",
				)
			: undefined;
		const remainsUnknown =
			mode === "codex-unknown" || mode === "codex-disconnected";
		if (codex && mode === "codex-unknown")
			codex.transport.compactCompletedItemId = "unrelated-item";
		if (codex && mode === "codex-disconnected")
			codex.transport.beforeSend = async (frame) => {
				if (frame.method === "thread/compact/start")
					throw new TypeError("Synthetic compact ACK lost");
			};
		const originalHost = authority.hostSessionRef;
		if (codex) {
			authority.hostSessionRef = codex.hostSessionRef;
			await client`update platform.conversations set host_session_ref=${codex.hostSessionRef} where id=${authority.conversationId}`;
		}
		const input = {
			...request(),
			...(mode === "codex-medium-medium"
				? { selection: { ...request().selection, reasoningLevel: "medium" } }
				: {}),
			...(codex
				? {
						capabilityId: codex.capabilityId,
						directoryRevision: codex.directoryRevision,
						capabilitySourceVersion: codex.capabilitySourceVersion,
						configVersion: "configuration-1-native-fixture",
					}
				: {}),
		};
		const admitted = await useCase().admit(input);
		if (admitted.outcome === "accepted")
			await client`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${admitted.plan.outbox.id}`;
		if (admitted.outcome !== "accepted") throw new Error("expected admission");
		const dispatch = new PostgresConversationDispatchStoreV1({
			databaseUrl,
			userDirectory,
		});
		const authorization = new PostgresTaskAuthorizationStoreV1({ databaseUrl });
		const eventTransaction = new PostgresConversationEventTransactionV1({
			databaseUrl,
		});
		const sent: unknown[] = [];
		const replies: unknown[] = [];
		const httpPaths: string[] = [];
		const runtime = createConversationRuntimeV2({
			workerId: "v6-worker",
			signing: {
				issuer: "platform-worker",
				workerId: "v6-worker",
				keyId: "synthetic",
				privateKey: keys.privateKey,
			},
			directory: userDirectory,
			taskAuthorizationStore: authorization,
			dispatchStore: dispatch,
			channelAuthorizationCurrent: async () => true,
			resolveRuntimeHost: async () => ({
				baseUrl: "http://runtime.test",
				serviceToken: "synthetic-service-token",
				workerId: "v6-worker",
			}),
			executionKeys: {
				readAcceptedExecution: (r) => store.readAcceptedExecution(r),
				readAcceptedExecutionV6: (r) => store.readAcceptedExecutionV6(r),
				readCiphertext: async () => ({ opaque: "synthetic-encrypted-record" }),
			},
			relayKeyDecryptor: {
				decrypt: async () => ({
					outcome: "decrypted",
					plaintext: new TextEncoder().encode("synthetic-test-key"),
				}),
			},
			fetch: async (url, init) => {
				const path = new URL(String(url)).pathname;
				httpPaths.push(path);

				const body = JSON.parse(init?.body as string);
				if (path.endsWith("/native-capability")) {
					const wire = RuntimeNativeCapabilityRequestV6Schema.parse(
						body.businessRequest,
					);
					sent.push(wire);
					if (mode === "late-unsent")
						return Response.json({
							schemaVersion: 6,
							operationId: wire.executionId,
							hostSessionRef: wire.hostSessionRef,
							result: {
								outcome: "unknown",
								code: "RUNTIME_ACCEPTANCE_UNKNOWN",
								message: "Runtime command acceptance could not be confirmed",
							},
						});
					if (codex) {
						try {
							const response = await codex.host.nativeCapabilityV6(body);
							codex.model.release();
							replies.push(response);
							if (loseResponse)
								throw new TypeError("Synthetic accepted response lost");
							return Response.json(response);
						} catch (error) {
							return hostErrorResponse(error, wire.traceId);
						}
					}
					const result =
						mode === "busy"
							? { outcome: "busy" }
							: mode === "rejected"
								? {
										outcome: "rejected",
										code: "RUNTIME_TURN_NOT_ACTIVE",
										message: "Runtime turn is no longer active",
										retryable: false,
									}
								: mode === "unknown-result"
									? { outcome: "unknown" }
									: null;
					if (result)
						return Response.json({
							schemaVersion: 6,
							hostSessionRef: authority.hostSessionRef,
							operationId: wire.executionId,
							result,
						});
					if (loseResponse)
						throw new TypeError("Synthetic accepted response lost");
					return Response.json({
						schemaVersion: 6,
						hostSessionRef: authority.hostSessionRef,
						operationId: wire.executionId,
						result: { outcome: "accepted", status: "running" },
					});
				}
				if (path.endsWith("/authorizations/renew")) {
					if (!codex) {
						expect(body).toMatchObject({
							executionId: admitted.plan.executionId,
							hostSessionRef: authority.hostSessionRef,
						});
						return Response.json({
							schemaVersion: 3,
							executionId: body.executionId,
							expiresAt: Date.now() + 30_000,
						});
					}
					try {
						return Response.json(
							await codex.host.renewAuthorizationV3(
								body,
								codex.verify(body.grant),
							),
						);
					} catch (error) {
						return hostErrorResponse(error, body.traceId);
					}
				}
				if (codex) {
					if (path.endsWith("/events/read"))
						return Response.json(
							await codex.host.readEventsV4(body, codex.verify(body.grant)),
						);
					if (path.endsWith("/events/ack"))
						return Response.json(
							await codex.host.acknowledgeEventsV4(
								body,
								codex.verify(body.grant),
							),
						);
					if (path.endsWith("/status"))
						return Response.json(
							await codex.host.recoverStatusV3(body, codex.verify(body.grant)),
						);
				}
				if (mode === "late-unsent" && path.endsWith("/status")) {
					if (httpPaths.filter((entry) => entry === path).length === 1)
						return Response.json({
							schemaVersion: 3,
							hostSessionRef: authority.hostSessionRef,
							executionId: input.executionId,
							outcome: "found",
							status: "unknown",
						});
					return Response.json(
						{
							schemaVersion: 1,
							traceId: body.traceId,
							code: "RUNTIME_NATIVE_COMMAND_NOT_SUBMITTED",
							message: "Native command was not submitted",
							retryable: false,
						},
						{ status: 409 },
					);
				}
				if (path.endsWith("/status"))
					return Response.json({
						schemaVersion: 3,
						hostSessionRef: authority.hostSessionRef,
						executionId: request().executionId,
						outcome: "found",
						status: "completed",
					});
				if (path.endsWith("/events/read"))
					return Response.json({
						schemaVersion: 4,
						hostSessionRef: authority.hostSessionRef,
						executionId: request().executionId,
						events: [
							{
								schemaVersion: 1,
								type: "completed",
								executionId: request().executionId,
								adapterEventKey: "compact-completed",
								cursor: "compact-completed",
								occurredAt: new Date().toISOString(),
								payload: { status: "completed" },
							},
						],
					});
				if (path.endsWith("/events/ack"))
					return Response.json({
						schemaVersion: 4,
						executionId: request().executionId,
						confirmedCursor: body.confirmedCursor,
					});
				throw new Error(`Unexpected synthetic Host path: ${path}`);
			},
		});
		try {
			const worker = createConversationDispatchUseCaseV1(
				{
					store: dispatch,
					events: createConversationEventUseCaseV1({
						transaction: eventTransaction,
					}),
					runtimeHost: runtime.runtimeHost,
					authorization:
						mode === "denied"
							? { authorize: async () => ({ outcome: "denied" as const }) }
							: runtime.authorization,
				},
				mode === "codex-unknown" ? { recoveryBudgetMs: 1_000 } : {},
			);
			if (mode === "reclaimed") {
				expect(
					await dispatch.claim({
						schemaVersion: 1,
						itemId: admitted.plan.outbox.id,
						workerId: "departed-worker",
						leaseDurationMs: 30000,
					}),
				).toMatchObject({ outcome: "claimed" });
				await client`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second' where id=${admitted.plan.outbox.id}`;
			}
			const decision = await worker.dispatch({
				schemaVersion: 1,
				itemId: admitted.plan.outbox.id,
				workerId: "v6-worker",
			});

			if (mode === "late-unsent") {
				expect(decision.outcome).toBe("unknown");
				const [unknown] =
					await client`select status from platform.conversation_executions where execution_id=${input.executionId}`;
				expect(unknown?.status).toBe("unknown");
				const item = {
					schemaVersion: 1 as const,
					itemId: admitted.plan.outbox.id,
					workerId: "v6-worker",
				};
				for (const expected of ["unknown", "rejected"]) {
					await client`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${item.itemId}`;
					expect((await worker.dispatch(item)).outcome).toBe(expected);
				}
				const [row] =
					await client`select e.status, e.accepted_original_host_session_ref, o.status as outbox_status,
					c.status as conversation_status from platform.conversation_executions e
					join platform.outbox_items o on o.id=${item.itemId} join platform.conversations c on c.id=e.conversation_id
					where e.execution_id=${input.executionId}`;
				expect(row).toMatchObject({
					status: "failed",
					outbox_status: "failed",
					conversation_status: "ready",
					accepted_original_host_session_ref: null,
				});
				expect(sent).toHaveLength(1);
				expect(
					httpPaths.some(
						(path) =>
							path.endsWith("/events/read") ||
							path.endsWith("/authorizations/renew"),
					),
				).toBe(false);
				return;
			}
			if (mode === "codex-high-high")
				expect(codex?.transport.modelStatuses).toEqual([200]);

			if (
				[
					"denied",
					"busy",
					"rejected",
					"codex-medium-high",
					"codex-config-drift",
					"codex-model-drift",
				].includes(mode)
			) {
				expect(decision).toMatchObject({ outcome: "rejected" });
				if (codex)
					expect(replies).toEqual([
						expect.objectContaining({
							operationId: input.executionId,
							result: {
								outcome: "rejected",
								code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
								message: "Runtime model selection is unsupported",
								retryable: false,
							},
						}),
					]);
				if (codex)
					expect(
						codex.transport.requests.filter(
							(r) => r.method === "thread/compact/start",
						),
					).toHaveLength(0);
				const [failed] =
					await client`select e.status,e.delivery_fence::int as fence,o.status as outbox_status,o.attempt_count,o.lease_owner,c.status as conversation_status,(select count(*)::int from platform.conversation_events v where v.execution_id=e.execution_id) as events from platform.conversation_executions e join platform.outbox_items o on o.id=${admitted.plan.outbox.id} join platform.conversations c on c.id=e.conversation_id where e.execution_id=${admitted.plan.executionId}`;
				expect(failed).toMatchObject({
					status: "failed",
					outbox_status: "failed",
					conversation_status: "ready",
					attempt_count: 1,
					lease_owner: null,
					fence: 1,
				});
				expect(failed?.events).toBeGreaterThan(0);
				if (mode === "codex-medium-high" && codex) {
					await client`insert into platform.conversation_executions
						(execution_id,conversation_id,sandbox_id,agent_id,actor_id,channel_id,turn_id,status,
						 session_generation,authorization_revision,created_at,updated_at,
						 runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,
						 accepted_original_host_session_ref,execution_source,relay_key_purpose,
						 relay_key_subject_id,relay_key_id,relay_key_version)
						values ('seed-execution',${authority.conversationId},(select sandbox_id from platform.session_sandbox_allocations where conversation_id=${authority.conversationId}),${authority.agentId},${authority.actorId},
						 'web','seed-turn','completed',1,${authority.authorizationRevision},
						 now()-interval '1 minute',now()-interval '1 minute','v4',${"a".repeat(43)},
						 ${authority.hostSessionRef},${authority.hostSessionRef},'web','personal',
						 ${authority.actorId},${keyBinding.ciphertextRef},1)`;
					const query = new PostgresConversationQueryV1({ databaseUrl });
					try {
						const anchor = await query.readNativeCapabilityCurrentScopeV1({
							scope: {
								actorId: authority.actorId,
								channelId: "web",
								principal: authority.principal,
							},
							agentId: authority.agentId,
							conversationId: authority.conversationId,
						});
						expect(anchor?.executionId).toBe("seed-execution");
						if (!anchor) throw new Error("Missing accepted catalog origin");
						for (let round = 0; round < 2; round++) {
							for (const selector of ["commands", "skills"] as const) {
								const response = await readCatalogAnchorFixture({
									query,
									host: codex.host,
									agentId: authority.agentId,
									conversationId: authority.conversationId,
									executionId: anchor.executionId,
									userId: authority.actorId,
									selector,
									sandboxPolicy: {
										namespace: "fixture-sandboxes",
										resourceConfigurationHash:
											workloadResourceConfigurationHashV1(workloadTestPolicy),
									},
								});
								expect(response.status).toBe(200);
								expect(await response.json()).toMatchObject({ selector });
							}
						}
						const next = {
							...request("medium-after-rejection"),
							capabilityId: codex.capabilityId,
							directoryRevision: codex.directoryRevision,
							capabilitySourceVersion: codex.capabilitySourceVersion,
							configVersion: "configuration-1-native-fixture",
							selection: { ...request().selection, reasoningLevel: "medium" },
						};
						const accepted = await useCase().admit(next);
						expect(accepted.outcome).toBe("accepted");
						if (accepted.outcome !== "accepted")
							throw new Error("missing successor");
						await client`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${accepted.plan.outbox.id}`;
						expect(
							await worker.dispatch({
								schemaVersion: 1,
								itemId: accepted.plan.outbox.id,
								workerId: "v6-worker",
							}),
						).toMatchObject({ outcome: "accepted" });
						const [terminal] =
							await client`select status from platform.conversation_executions where execution_id=${accepted.plan.executionId}`;
						expect(terminal?.status).toBe("completed");
						expect(
							(
								await query.readNativeCapabilityCurrentScopeV1({
									scope: {
										actorId: authority.actorId,
										channelId: "web",
										principal: authority.principal,
									},
									agentId: authority.agentId,
									conversationId: authority.conversationId,
								})
							)?.executionId,
						).toBe(accepted.plan.executionId);
						expect(
							codex.transport.requests.filter(
								(frame) => frame.method === "thread/compact/start",
							),
						).toHaveLength(1);
						expect(await useCase().admit(next)).toMatchObject({
							outcome: "replayed",
						});
					} finally {
						await query.close();
					}
				}
				expect(sent).toHaveLength(
					mode === "denied" ? 0 : mode === "codex-medium-high" ? 2 : 1,
				);
				expect(await useCase().admit(input)).toMatchObject({
					outcome: "replayed",
					plan: admitted.plan,
				});
				if (!codex)
					expect(
						await useCase().admit(request("next-after-failure")),
					).toMatchObject({ outcome: "accepted" });
				return;
			}
			if (loseResponse || mode === "unknown-result" || remainsUnknown) {
				// A malformed completion may arrive after the durable running ACK. Both
				// immediate uncertainty and the later bounded heartbeat path must retain
				// unknown occupancy and never send compact again.
				if (mode === "codex-unknown")
					expect(decision).toMatchObject({
						outcome: expect.stringMatching(/^(unknown|retry)$/),
						errorCode: expect.stringMatching(
							/^(RUNTIME_ACCEPTANCE_UNKNOWN|RUNTIME_HEARTBEAT_INTERRUPTED)$/,
						),
					});
				else
					expect(decision).toMatchObject({
						outcome: remainsUnknown ? "unknown" : "retry",
						errorCode: loseResponse
							? "RUNTIME_UNAVAILABLE"
							: "RUNTIME_ACCEPTANCE_UNKNOWN",
					});
				const [unknown] =
					await client`select status from platform.conversation_executions where execution_id=${admitted.plan.executionId}`;
				expect(unknown?.status).toBe("unknown");
				if (mode === "codex-unknown") {
					// The unmatched completion stays unknown until this execution's recovery budget expires.
					await client`update platform.conversation_executions set unknown_since=clock_timestamp()-interval '2 seconds' where execution_id=${admitted.plan.executionId}`;
				}
				await client`update platform.outbox_items set available_at=clock_timestamp()-interval '1 second' where id=${admitted.plan.outbox.id}`;
				const recovery = await worker.dispatch({
					schemaVersion: 1,
					itemId: admitted.plan.outbox.id,
					workerId: "v6-worker",
				});
				if (mode === "codex-disconnected")
					expect(recovery).toMatchObject({
						outcome: "unknown",
						errorCode: "RUNTIME_ACCEPTANCE_UNKNOWN",
						retryScheduled: true,
					});
				else
					expect(recovery).toMatchObject({
						outcome: mode === "codex-unknown" ? "rejected" : "accepted",
					});
				if (remainsUnknown) {
					expect(sent).toHaveLength(1);
					expect(
						codex?.transport.requests.filter(
							(r) => r.method === "thread/compact/start",
						),
					).toHaveLength(1);
					const [stored] =
						await client`select e.status,o.status as outbox_status,o.attempt_count from platform.conversation_executions e join platform.outbox_items o on o.id=${admitted.plan.outbox.id} where e.execution_id=${input.executionId}`;
					expect(stored).toMatchObject({
						status: mode === "codex-unknown" ? "failed" : "unknown",
						outbox_status:
							mode === "codex-unknown" ? "failed" : "retry_scheduled",
						attempt_count: 2,
					});
					return;
				}
			} else expect(decision).toMatchObject({ outcome: "accepted" });
			if (mode === "normal") {
				const renew = httpPaths.indexOf(
					"/internal/runtime/v3/authorizations/renew",
				);
				expect(renew).toBeGreaterThan(
					httpPaths.indexOf("/internal/runtime/v6/native-capability"),
				);
				expect(
					httpPaths.indexOf("/internal/runtime/v4/events/read"),
				).toBeGreaterThan(renew);
			}
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({
				schemaVersion: 6,
				executionId: admitted.plan.executionId,
				operation: {
					deliveryFence: mode === "reclaimed" ? 2 : 1,
					executionDeliveryFence: mode === "reclaimed" ? 2 : 1,
				},
				selection: input.selection,
			});
			const [terminal] =
				await client`select e.status,o.status as outbox_status,(select count(*)::int from platform.conversation_events v where v.execution_id=e.execution_id) as events from platform.conversation_executions e join platform.outbox_items o on o.id=${admitted.plan.outbox.id} where e.execution_id=${admitted.plan.executionId}`;
			expect(terminal).toMatchObject({
				status: "completed",
				outbox_status: "succeeded",
			});
			expect(terminal?.events).toBeGreaterThan(0);
			expect(await useCase().admit(input)).toMatchObject({
				outcome: "replayed",
				plan: admitted.plan,
			});
			if (codex) {
				expect(replies[0]).toMatchObject({
					result: { outcome: "accepted", status: "running" },
				});
				expect(codex.model.requests).toEqual([
					{ key: "Bearer synthetic-test-key" },
				]);
				expect(codex.transport.modelStatuses).toEqual([200]);
				expect(
					codex.transport.requests.filter(
						(r) => r.method === "thread/compact/start",
					),
				).toHaveLength(1);
				const events =
					await client`select event_type,event_payload from platform.conversation_events where execution_id=${input.executionId}`;
				expect(
					events
						.filter((e) => e.event_type === "execution.operation")
						.map(
							(e) =>
								(e.event_payload as { fact: { phase: string } }).fact.phase,
						),
				).toEqual(["intent", "started", "completed"]);
				expect(JSON.stringify(events)).not.toContain("synthetic-test-key");
				expect(events.map((e) => e.event_type)).toEqual(
					expect.arrayContaining(["execution.status", "text.delta"]),
				);
				expect(events).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							event_type: "execution.status",
							event_payload: expect.objectContaining({ status: "completed" }),
						}),
					]),
				);
			}
		} finally {
			await runtime.close();
			await codex?.close();
			authority.hostSessionRef = originalHost;
			await authorization.close();
			await eventTransaction.close();
			await dispatch.close();
		}
	},
	30_000,
);

it.each([
	["actorId", "other-actor"],
	["agentId", "other-agent"],
	["conversationId", "other-conversation"],
	["sessionGeneration", 2],
	["modelOptionId", "other-model"],
	["modelConfigurationRevision", 2],
	["reasoningLevel", "low"],
	["hostSessionRef", "other-host"],
	["parameters", "changed"],
	["parametersDigest", "0".repeat(64)],
	["directoryRevision", "0".repeat(64)],
	["configVersion", "changed"],
	["operationDigest", "0".repeat(64)],
	["keyBinding", { ...keyBinding, version: 2 }],
	["taskBoundary", { ...taskAuthority.taskBoundary, agentId: "other-agent" }],
	["operation", { ...request().operation, id: "other-execution" }],
] as const)(
	"refuses a V6 %s binding drift before Runtime (#4255)",
	async (field, value) => {
		const admitted = await admitDispatchFixture();
		if (admitted.outcome !== "accepted") throw new Error("expected admission");
		await client`update platform.outbox_items set payload=payload || ${client.json({ [field]: value } as unknown as postgres.JSONValue)} where id=${admitted.plan.outbox.id}`;
		const dispatch = new PostgresConversationDispatchStoreV1({
			databaseUrl,
			userDirectory,
		});
		try {
			const decision = await dispatch.claim({
				schemaVersion: 1,
				itemId: admitted.plan.outbox.id,
				workerId: "drift-worker",
				leaseDurationMs: 30000,
			});
			if (decision.outcome === "claimed")
				expect(
					await dispatch.readRuntimeState({ claim: decision.claim }),
				).toBeNull();
			else expect(decision.outcome).toMatch(/stale|failed/);
		} finally {
			await dispatch.close();
		}
	},
);

it("keeps one claim owner and reclaims unknown work with the original V6 pin (#4255)", async () => {
	await seedDispatchWorkload();
	const admitted = await admitDispatchFixture();
	if (admitted.outcome !== "accepted") throw new Error("expected admission");
	const dispatch = new PostgresConversationDispatchStoreV1({
		databaseUrl,
		userDirectory,
	});
	const claim = (workerId: string) =>
		dispatch.claim({
			schemaVersion: 1,
			itemId: admitted.plan.outbox.id,
			workerId,
			leaseDurationMs: 30000,
		});
	try {
		const decisions = await Promise.all([claim("one"), claim("two")]);
		expect(decisions.map((d) => d.outcome).sort()).toEqual(["busy", "claimed"]);
		const owned = decisions.find((d) => d.outcome === "claimed");
		if (owned?.outcome !== "claimed") throw new Error("missing claim");
		expect(
			await dispatch.prepareRuntimeDispatch({
				claim: owned.claim,
				leaseDurationMs: 30000,
			}),
		).toBe(true);
		await client`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second' where id=${admitted.plan.outbox.id}`;
		const next = await claim("recovery");
		expect(next.outcome).toBe("claimed");
		if (next.outcome !== "claimed") return;
		expect(next.claim).toMatchObject({
			executionStatus: "unknown",
			deliveryFence: 2,
			executionDeliveryFence: 2,
		});
		expect(
			await dispatch.readRuntimeState({ claim: next.claim }),
		).toMatchObject({
			originalOperationDigest: Buffer.from(
				admitted.plan.operationDigest,
				"hex",
			).toString("base64url"),
		});
		expect(await dispatch.readRuntimeState({ claim: owned.claim })).toBeNull();
		expect(await useCase().admit(request())).toMatchObject({
			outcome: "replayed",
			plan: admitted.plan,
		});
	} finally {
		await dispatch.close();
	}
});

it("cancels a stopped V6 operation before transport without a second execution (#4255)", async () => {
	const admitted = await admitDispatchFixture();
	if (admitted.outcome !== "accepted") throw new Error("expected admission");
	await client`insert into platform.conversation_stops(execution_id,stop_request_id,status,created_at,updated_at) values(${admitted.plan.executionId},'v6-stop','submitted',now(),now())`;
	await client`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id,request_id,available_at,created_at,updated_at) values('conversation:stop:v6-stop','conversation',${authority.conversationId},'conversation.turn.stop.v1',${client.json({ schemaVersion: 1, conversationId: authority.conversationId, executionId: admitted.plan.executionId, sessionGeneration: 1, stopRequestId: "v6-stop" })},'trace','request',now(),now(),now())`;
	const dispatch = new PostgresConversationDispatchStoreV1({
		databaseUrl,
		userDirectory,
	});
	try {
		const stop = await dispatch.claim({
			schemaVersion: 1,
			itemId: "conversation:stop:v6-stop",
			workerId: "stop-worker",
			leaseDurationMs: 30000,
		});
		expect(stop.outcome).toBe("claimed");
		if (stop.outcome !== "claimed") return;
		expect(
			await dispatch.readRuntimeState({ claim: stop.claim }),
		).not.toBeNull();
		expect(await dispatch.cancelUnaccepted({ claim: stop.claim })).toBe(true);
		const [row] =
			await client`select status from platform.conversation_executions where execution_id=${admitted.plan.executionId}`;
		expect(row?.status).toBe("cancelled");
		expect(await useCase().admit(request())).toMatchObject({
			outcome: "replayed",
			plan: admitted.plan,
		});
	} finally {
		await dispatch.close();
	}
});

it.each(["v1", "v2"])(
	"settles stopped Agent never-sent native %s without transport (#4316 AC-2)",
	async (version) => {
		await seedDispatchWorkload();
		const admitted = await admitDispatchFixture();
		if (admitted.outcome !== "accepted") throw new Error("fixture admission");
		if (version === "v1") {
			const input = request();
			const payload = {
				schemaVersion: 1,
				conversationId: input.conversationId,
				executionId: input.executionId,
				agentId: input.agentId,
				actorId: authority.actorId,
				channelId: input.channelId,
				turnId: input.turnId,
				sessionGeneration: input.sessionGeneration,
				capabilityId: input.capabilityId,
				capabilityKind: "command",
				directoryRevision: input.directoryRevision,
				capabilitySourceVersion: input.capabilitySourceVersion,
				parameters: input.parameters,
				parametersDigest: input.parametersDigest,
			};
			await client`update platform.outbox_items set operation='conversation.native-capability.invoke.v1',payload=${client.json(payload)} where id=${admitted.plan.outbox.id}`;
			await client`update platform.conversation_executions set model_configuration_revision=null,model_option_id=null,reasoning_level=null where execution_id=${admitted.plan.executionId}`;
		}

		await client`update platform.agent_applications set status='stopped',desired_state='stopped',service_availability=null where agent_id=${authority.agentId}`;
		await client`update platform.session_sandbox_allocations set status='stopped',desired_state='stopped' where conversation_id=${authority.conversationId}`;
		const dispatch = new PostgresConversationDispatchStoreV1({
			databaseUrl,
			userDirectory,
		});
		try {
			expect(await dispatch.findDispatchable({ limit: 20 })).toContainEqual(
				expect.objectContaining({ itemId: admitted.plan.outbox.id }),
			);
			expect(
				await dispatch.claim({
					schemaVersion: 1,
					itemId: admitted.plan.outbox.id,
					workerId: "stopped-native-worker",
					leaseDurationMs: 30000,
				}),
			).toMatchObject({ outcome: "succeeded" });
			const [row] =
				await client`select e.status,e.delivery_fence::int as fence,e.runtime_submit_protocol,e.original_operation_digest,e.last_runtime_cursor,o.status as outbox_status,o.attempt_count,o.lease_owner,(select count(*)::int from platform.conversation_events v where v.execution_id=e.execution_id and v.source='platform' and v.event_type='execution.status' and v.event_payload->>'status'='cancelled') as cancellations from platform.conversation_executions e join platform.outbox_items o on o.id=${admitted.plan.outbox.id} where e.execution_id=${admitted.plan.executionId}`;
			expect(row).toMatchObject({
				status: "cancelled",
				fence: 0,
				runtime_submit_protocol: null,
				original_operation_digest: null,
				last_runtime_cursor: null,
				outbox_status: "succeeded",
				attempt_count: 0,
				lease_owner: null,
				cancellations: 1,
			});
			if (version === "v2")
				expect(await useCase().admit(request())).toMatchObject({
					outcome: "replayed",
					plan: admitted.plan,
				});
		} finally {
			await dispatch.close();
		}
	},
);

it.each([
	"agent-running",
	"agent-starting",
	"sandbox-ready",
	"processing",
	"unknown",
	"prepared-submitted",
	"attempted",
	"wrong-actor",
	"wrong-conversation",
	"wrong-generation",
	"accepted-host",
	"runtime-cursor",
])(
	"does not cancel %s native work when discovering stopped tasks (#4316 AC-2)",
	async (change) => {
		await seedDispatchWorkload();
		const admitted = await admitDispatchFixture();
		if (admitted.outcome !== "accepted") throw new Error("fixture admission");
		const dispatch = new PostgresConversationDispatchStoreV1({
			databaseUrl,
			userDirectory,
		});
		try {
			if (
				[
					"processing",
					"unknown",
					"prepared-submitted",
					"accepted-host",
					"attempted",
				].includes(change)
			) {
				const owned = await dispatch.claim({
					schemaVersion: 1,
					itemId: admitted.plan.outbox.id,
					workerId: "before-stop",
					leaseDurationMs: 30000,
				});
				if (owned.outcome !== "claimed") throw new Error("fixture claim");
				if (change !== "attempted")
					expect(
						await dispatch.prepareRuntimeDispatch({
							claim: owned.claim,
							leaseDurationMs: 30000,
						}),
					).toBe(true);
				if (change !== "attempted")
					await client`update platform.conversation_executions set status=${["prepared-submitted", "accepted-host"].includes(change) ? "submitted" : change} where execution_id=${admitted.plan.executionId}`;
				await client`update platform.outbox_items set status='retry_scheduled',lease_owner=null,lease_expires_at=null,available_at=clock_timestamp()-interval '1 second' where id=${admitted.plan.outbox.id}`;
			}
			if (change !== "agent-running")
				await client`update platform.agent_applications set status=${change === "agent-starting" ? "available" : "stopped"},desired_state=${change === "agent-starting" ? "running" : "stopped"},service_availability=${change === "agent-starting" ? "starting" : null} where agent_id=${authority.agentId}`;
			if (change !== "sandbox-ready")
				await client`update platform.session_sandbox_allocations set status='stopped',desired_state='stopped' where conversation_id=${authority.conversationId}`;
			if (change === "wrong-actor")
				await client`update platform.outbox_items set payload=jsonb_set(payload,'{actorId}','"other-user"') where id=${admitted.plan.outbox.id}`;
			if (change === "wrong-conversation")
				await client`update platform.outbox_items set payload=jsonb_set(payload,'{conversationId}','"other-conversation"') where id=${admitted.plan.outbox.id}`;
			if (change === "wrong-generation")
				await client`update platform.conversation_executions set session_generation=2 where execution_id=${admitted.plan.executionId}`;
			if (change === "accepted-host")
				await client`update platform.conversation_executions set accepted_original_host_session_ref=${authority.hostSessionRef} where execution_id=${admitted.plan.executionId}`;
			if (change === "runtime-cursor")
				await client`update platform.conversation_executions set last_runtime_cursor='already-sent' where execution_id=${admitted.plan.executionId}`;
			const [before] =
				await client`select status,delivery_fence from platform.conversation_executions where execution_id=${admitted.plan.executionId}`;
			const page = await dispatch.findDispatchable({ limit: 20 });
			if (!["processing", "unknown", "sandbox-ready"].includes(change))
				expect(page).not.toContainEqual(
					expect.objectContaining({ itemId: admitted.plan.outbox.id }),
				);
			const decision = await dispatch.claim({
				schemaVersion: 1,
				itemId: admitted.plan.outbox.id,
				workerId: "after-stop",
				leaseDurationMs: 30000,
			});
			expect(decision.outcome).not.toBe("succeeded");
			const [after] =
				await client`select status from platform.conversation_executions where execution_id=${admitted.plan.executionId}`;
			expect(after?.status).toBe(before?.status);
			const [events] =
				await client`select count(*)::int as count from platform.conversation_events where execution_id=${admitted.plan.executionId} and event_type='execution.status' and event_payload->>'status'='cancelled'`;
			expect(events?.count).toBe(0);
		} finally {
			await dispatch.close();
		}
	},
);
