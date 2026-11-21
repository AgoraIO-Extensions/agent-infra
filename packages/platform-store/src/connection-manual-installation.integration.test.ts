import { randomBytes, randomUUID } from "node:crypto";
import {
	connectionSystemAccessFingerprintV1,
	resolveApprovedConnectionSystemAccessV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import {
	type ConnectionManualConfirmCandidateV1,
	type ConnectionRegistrationReceiptV1,
	type ConnectionRegistrationTemplateV1,
	connectionHostDeploymentIdentityV1,
} from "@agent-infra/contracts/runtime";
import {
	buildConnectionRegistrationTemplateV1,
	connectionInstallCommandDigestV1,
	connectionInstallConfigurationDigestV1,
	connectionManualInstallDescriptorDigestV1,
	connectionRegistrationReceiptDigestV1,
	connectionRegistrationTemplateDigestV1,
} from "@agent-infra/contracts/runtime/connection-install-node";
import { createConnectionInstallationAuthorizationV1 } from "@agent-infra/platform-core";
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
import { PostgresAgentConnectionAssociationStoreV1 } from "./agent-connection-association.js";
import { PostgresConnectionInstallationAuthorizationTransactionV1 } from "./connection-installation.js";
import { PostgresConnectionManualInstallationStoreV1 } from "./connection-manual-installation-store.js";
import { PostgresConnectionPrincipalPinAdministrationV1 } from "./connection-principal-pin-administration.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { seedSessionSandboxFixture } from "./session-sandbox.fixture.js";

const system = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.test",
	mcpPath: "/mcp",
	audience: "mcp",
	egressProfile: { ref: "egress", revision: "r1" },
	issuer: "https://connection.test/",
	oauthCallbackUrl: "https://platform.test/connection/callback",
};
const systemApproval = {
	schemaVersion: 1 as const,
	configFingerprint: connectionSystemAccessFingerprintV1(system),
	egressEnforced: true as const,
	source: { ref: "platform-deployment", revision: "r1" },
};
/** §13.5.1 exception approval bound to the same system access and approval source. */
const dynamic = {
	schemaVersion: 1 as const,
	principalMapping: {
		schemaVersion: 1 as const,
		kind: "consistency-exception-v1" as const,
		policy: { ref: "consistency-exception-v1", revision: "r1" },
		notAfter: "2099-01-01T00:00:00Z",
		maximumPinnedPrincipals: 2,
		verificationWindowHours: 24,
		connectionRelease: "agora-connector-2019ca07",
		systemAccessFingerprint: connectionSystemAccessFingerprintV1(system),
		approvalSource: systemApproval.source,
	},
	readbackContract: { ref: "connection-ep-1060-read", revision: "1" },
	publicationContract: { ref: "connection-mcp-publication", revision: "1" },
};
const policy = {
	systemAccess: system,
	approval: systemApproval,
	clientName: "Agent Infra",
	dynamic,
	// The server-resolved set: no Principal confirmed outside the exception.
	confirmedPrincipals: [],
};
function resolvedAccess(
	systemAccess: typeof system,
	approval: typeof systemApproval,
) {
	const value = resolveApprovedConnectionSystemAccessV1(systemAccess, approval);
	if (value.status !== "available") throw new Error("fixture");
	return value;
}
/** Swapped only while a test drives a second issuer's installation. */
let access = resolvedAccess(system, systemApproval);
let beforeResolveUser: (() => Promise<void>) | undefined;
const directory = {
	resolveUser: async (userId: string) => {
		await beforeResolveUser?.();
		return {
			schemaVersion: 1 as const,
			userId,
			accountStatus: "active" as const,
			organizationIds: ["eng"],
			authorizationRevision: "identity-r1",
		};
	},
};
const deploymentIdentity = connectionHostDeploymentIdentityV1({
	namespace: "fixture-sandboxes",
	workerId: "worker-a",
});

let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
let installations: PostgresConnectionInstallationAuthorizationTransactionV1;
let manual: PostgresConnectionManualInstallationStoreV1;
let associations: PostgresAgentConnectionAssociationStoreV1;
let use: ReturnType<typeof createConnectionInstallationAuthorizationV1>;

async function seedExecution(input: {
	agentId: string;
	user: string;
	suffix: string;
	worker: string;
}) {
	const { agentId, user, suffix, worker } = input;
	await client`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values ('personal',${user},1,1) on conflict do nothing`;
	await client`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values ('personal',${user},1,${`fixture-key-${user}`},${client.json({ purpose: "personal", subjectId: user, keyId: `fixture-key-${user}`, keyVersion: 1 })}) on conflict do nothing`;
	await client`insert into platform.agent_availability(agent_id,target_type,target_id) values (${agentId},'user',${user}) on conflict do nothing`;
	await client`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,host_session_ref) values (${`conversation-${suffix}`},${agentId},${user},'web','active',1,'agent-r1',${`host-${suffix}`})`;
	await client`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version,delivery_fence) values (${`execution-${suffix}`},${`conversation-${suffix}`},${agentId},${user},'web',${`turn-${suffix}`},'processing',1,'agent-r1',now(),'v4',${"a".repeat(43)},${`host-${suffix}`},'web','personal',${user},${`fixture-key-${user}`},1,3)`;
	await client`insert into platform.task_authorization_records(id,execution_id,boundary) values (${`task-${suffix}`},${`execution-${suffix}`},${client.json({ schemaVersion: 1, principal: { kind: "user", id: user }, agentId, channelId: "web", identityRevision: "identity-r1", agentAuthorizationRevision: "agent-r1", accessSources: [{ kind: "user", userId: user }] })})`;
	await seedSessionSandboxFixture(client, `conversation-${suffix}`);
	// A live claim carries the same delivery fence on the outbox item and the Execution.
	await client`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,status,lease_owner,lease_expires_at,delivery_fence,trace_id) values (${`item-${suffix}`},'conversation',${`conversation-${suffix}`},'conversation.turn.submit.v1',${client.json({ executionId: `execution-${suffix}` })},'processing',${worker},now()+interval '1 hour',3,'trace')`;
}

async function seedAgent(agentId: string) {
	await client`insert into platform.agents(id,authorization_revision) values (${agentId},'agent-r1')`;
	await client`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values (${`application-${agentId}`},${agentId},'owner','Agent','test','available','trace','request',now(),1,1,'ready','running',1,1)`;
	await client`insert into platform.agent_owners(agent_id,owner_id,created_at) values (${agentId},'owner',now())`;
}

async function associate(
	agentId: string,
	connectionAgentId: string,
	revision: number,
) {
	await client`insert into platform.connection_association_generations(agent_id,last_revision) values (${agentId},${revision}) on conflict (agent_id) do update set last_revision=excluded.last_revision`;
	await client`delete from platform.connection_manual_associations where agent_id=${agentId}`;
	await client`insert into platform.connection_manual_associations(agent_id,connection_agent_id,credential_fingerprint,association_revision,owner_id,credential_ciphertext,verified_at) values (${agentId},${connectionAgentId},${randomBytes(32).toString("hex")},${revision},'owner',${client.json({ schemaVersion: 1, agentId, ownerId: "owner", secretVersion: revision, crypto: { dekFingerprint: randomBytes(32).toString("hex") }, sealed: "fixture-ciphertext-only" })},now())`;
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("4206-manual-install");
	client = postgres(database.databaseUrl, { onnotice: () => {} });
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	installations = new PostgresConnectionInstallationAuthorizationTransactionV1({
		databaseUrl: database.databaseUrl,
		directory,
		manualInstallation: policy,
	});
	manual = new PostgresConnectionManualInstallationStoreV1({
		databaseUrl: database.databaseUrl,
		directory,
		policy,
	});
	associations = new PostgresAgentConnectionAssociationStoreV1({
		databaseUrl: database.databaseUrl,
	});
	use = createConnectionInstallationAuthorizationV1({ store: installations });
	await seedAgent("agent-a");
	await seedAgent("agent-b");
	await seedExecution({
		agentId: "agent-a",
		user: "alice",
		suffix: "a",
		worker: "worker-a",
	});
	await seedExecution({
		agentId: "agent-b",
		user: "alice",
		suffix: "b",
		worker: "worker-a",
	});
	await seedExecution({
		agentId: "agent-a",
		user: "bob",
		suffix: "bob",
		worker: "worker-b",
	});
}, 180_000);

afterAll(async () => {
	await manual?.close();
	await installations?.close();
	await associations?.close();
	await client?.end();
	await database?.stop();
});

beforeEach(async () => {
	await client`delete from platform.connection_principal_pin_receipts`;
	await client`delete from platform.connection_principal_pins`;
	await client`delete from platform.connection_manual_installations`;
	await client`delete from platform.connection_installation_commands`;
	await client`delete from platform.connection_installation_authorizations`;
	await client`delete from platform.idempotency_records where scope_type='connection_installation'`;
	// Restore the seeded original claims that claim and fence regressions move.
	await client`delete from platform.outbox_items where id not in ('item-a','item-b','item-bob')`;
	await client`update platform.outbox_items set status='processing', lease_expires_at=now()+interval '1 hour', delivery_fence=3`;
	await client`update platform.conversation_executions set delivery_fence=3`;
	await associate("agent-a", "connection-agent-a", 1);
	await associate("agent-b", "connection-agent-b", 1);
});

async function begin(user = "alice", suffix = "a", key = randomUUID()) {
	return use.executeInstallation({
		userId: user,
		identityRevision: "identity-r1",
		command: "begin",
		executionId: `execution-${suffix}`,
		idempotencyKey: key,
		requestId: "request",
		traceId: "trace",
	});
}

async function facts(suffix = "a") {
	const [row] = await client`
		select s.sandbox_id, s.resource_name, s.resource_fence, s.resource_observation, c.host_session_ref
		from platform.session_sandbox_allocations s join platform.conversations c on c.id = s.conversation_id
		where s.conversation_id = ${`conversation-${suffix}`}`;
	const pod = (
		(row as { resource_observation: unknown }).resource_observation as {
			resources: { kind: string; uid: string }[];
		}
	).resources.find((resource) => resource.kind === "Pod");
	return {
		sandboxId: row?.sandbox_id as string,
		resourceName: row?.resource_name as string,
		resourceFence: Number(row?.resource_fence),
		hostRef: row?.host_session_ref as string,
		podUid: pod?.uid as string,
	};
}

async function claimFirst(
	command: string,
	executionId = "execution-a",
	worker = "worker-a",
) {
	const pending = await manual.listPending(32, [executionId]);
	const item = pending.find((entry) => entry.command === command);
	if (!item) throw new Error(`no pending ${command}`);
	const attemptId = randomUUID();
	const claimed = await manual.claim({
		commandId: item.commandId,
		attemptId,
		attemptOwner: worker,
	});
	return { item, attemptId, claimed };
}

async function templateFor(
	authorizationId: string,
	options: {
		suffix?: string;
		user?: string;
		agentId?: string;
		connectionAgentId?: string;
		podUid?: string;
		claimFence?: number;
		worker?: string;
		registrationKey?: string;
	} = {},
) {
	const suffix = options.suffix ?? "a";
	const f = await facts(suffix);
	const [authorization] =
		await client`select confirmation_revision, binding from platform.connection_installation_authorizations where id=${authorizationId}`;
	const binding = authorization?.binding as {
		reference: ConnectionRegistrationTemplateV1["reference"];
	};
	const registrationKey =
		options.registrationKey ?? `mi-${randomBytes(32).toString("base64url")}`;
	const template = buildConnectionRegistrationTemplateV1({
		access,
		clientName: "Agent Infra",
		principal: { kind: "user", id: options.user ?? "alice" },
		reference: binding.reference,
		authorizationId,
		confirmationRevision: authorization?.confirmation_revision as string,
		association: {
			connectionAgentId: options.connectionAgentId ?? "connection-agent-a",
			revision: 1,
		},
		claim: {
			owner: options.worker ?? "worker-a",
			fence: options.claimFence ?? 3,
		},
		target: {
			deploymentIdentity,
			hostRef: f.hostRef,
			sandboxId: f.sandboxId,
			podUid: options.podUid ?? f.podUid,
			sessionGeneration: 1,
			resourceFence: f.resourceFence,
			runtimeOrigin: `https://${f.resourceName}.fixture-sandboxes.svc:3443/`,
		},
		registrationKey,
	});
	return { template, registrationKey };
}

function receiptFor(
	template: ConnectionRegistrationTemplateV1,
	registrationKey: string,
	override: Partial<ConnectionRegistrationReceiptV1> = {},
): ConnectionRegistrationReceiptV1 {
	return {
		registrationKey,
		clientId: `client-${randomBytes(6).toString("hex")}`,
		clientName: template.registration.clientName,
		clientStatus: "ACTIVE",
		configFingerprint: template.registration.configFingerprint,
		consumerId: "consumer-internal-a",
		createdAt: new Date().toISOString(),
		instanceId: `instance-${randomBytes(6).toString("hex")}`,
		instanceStatus: "ACTIVE",
		principalId: null,
		redirectUri: template.registration.redirectUri,
		resource: template.registration.resource,
		scope: "mcp",
		source: template.registration.source,
		status: "ACTIVE",
		...override,
	};
}

async function fixSupply(
	user = "alice",
	suffix = "a",
	worker = "worker-a",
	key = randomUUID(),
) {
	const projection = await begin(user, suffix, key);
	const authorizationId = projection.authorizationId;
	const prepare = await claimFirst("prepare", `execution-${suffix}`, worker);
	expect(prepare.claimed?.command.command).toBe("prepare");
	// Execution "b" runs on agent-b; every other fixture Execution on agent-a.
	const agentId = suffix === "b" ? "agent-b" : "agent-a";
	const { template, registrationKey } = await templateFor(authorizationId, {
		user,
		suffix,
		worker,
		connectionAgentId: `connection-${agentId}`,
	});
	const supplyAttemptId = randomUUID();
	const supply = await manual.fixSupply({
		commandId: prepare.item.commandId,
		attemptId: prepare.attemptId,
		attemptOwner: worker,
		command: "prepare",
		template,
		registrationKey,
		supplyAttemptId,
	});
	expect(supply?.binding).toEqual({
		agentId,
		ownerId: "owner",
		associationRevision: 1,
	});
	const readbackBase = {
		schemaVersion: 1 as const,
		target: template.target,
		principal: template.principal,
		reference: template.reference,
		authorizationId,
		confirmationRevision: template.confirmationRevision,
		templateDigest: connectionRegistrationTemplateDigestV1(template),
		supply: { ...template.supply, attemptId: supplyAttemptId },
		nonce: randomBytes(32).toString("base64url"),
		issuedAt: Date.now(),
		expiresAt: Date.now() + 30_000,
	};
	expect(await manual.readback({ ...readbackBase, purpose: "supply" })).toBe(
		"allowed",
	);
	return {
		authorizationId,
		prepare,
		template,
		registrationKey,
		supplyAttemptId,
		readbackBase,
	};
}

/** Drives prepare to a delivered request; returns the facts the Host would read back. */
async function prepareDelivered(
	user = "alice",
	suffix = "a",
	worker = "worker-a",
	key = randomUUID(),
) {
	const fixed = await fixSupply(user, suffix, worker, key);
	const {
		authorizationId,
		prepare,
		template,
		registrationKey,
		supplyAttemptId,
		readbackBase,
	} = fixed;
	expect(
		await manual.settleSupply({
			commandId: prepare.item.commandId,
			attemptId: prepare.attemptId,
			attemptOwner: worker,
			command: "prepare",
			authorizationId,
			supplyAttemptId,
			outcome: "confirmed",
		}),
	).toBe(true);
	const deliveryDigest = connectionInstallCommandDigestV1({
		schemaVersion: 1,
		command: "prepare",
		commandId: prepare.item.commandId,
		attemptId: prepare.attemptId,
		attemptOwner: worker,
		template,
		supplyAttemptId,
		registrationKey,
	});
	expect(
		await manual.commitDelivery({
			commandId: prepare.item.commandId,
			attemptId: prepare.attemptId,
			attemptOwner: worker,
			command: "prepare",
			authorizationId,
			deliveryDigest,
		}),
	).toBe(true);
	const commandReadback = {
		...readbackBase,
		purpose: "command" as const,
		command: {
			commandId: prepare.item.commandId,
			attemptId: prepare.attemptId,
			attemptOwner: worker,
			command: "prepare" as const,
			requestDigest: deliveryDigest,
			registrationKeyHash: template.registration.registrationKeyHash,
		},
	};
	return {
		...fixed,
		commandReadback,
	};
}

function settlePrepared(
	run: Awaited<ReturnType<typeof prepareDelivered>>,
	override?: Partial<ConnectionRegistrationReceiptV1>,
) {
	return manual.settleRegistration({
		commandId: run.prepare.item.commandId,
		attemptId: run.prepare.attemptId,
		attemptOwner: run.commandReadback.command.attemptOwner,
		command: "prepare",
		authorizationId: run.authorizationId,
		response: {
			schemaVersion: 1,
			outcome: "registered",
			commandId: run.prepare.item.commandId,
			receipt: receiptFor(run.template, run.registrationKey, override),
		},
	});
}

/** The same Worker re-claims the original outbox item: the next fence on item and Execution. */
async function reclaim(suffix = "a") {
	await client`update platform.outbox_items set delivery_fence=4 where id=${`item-${suffix}`}`;
	await client`update platform.conversation_executions set delivery_fence=4 where execution_id=${`execution-${suffix}`}`;
}

/**
 * During the next directory read the original claim expires on its own while
 * another outbox item of the same Worker and Execution holds a live lease.
 */
async function expireClaimDuringRead(suffix = "a", worker = "worker-a") {
	await client`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,status,trace_id) values (${`item-${suffix}-other`},'conversation',${`conversation-${suffix}`},'conversation.turn.supplement.v1',${client.json({ executionId: `execution-${suffix}` })},'pending','trace')`;
	beforeResolveUser = async () => {
		beforeResolveUser = undefined;
		await client`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second' where id=${`item-${suffix}`}`;
		await client`update platform.outbox_items set status='processing', lease_owner=${worker},
			lease_expires_at=clock_timestamp()+interval '1 hour', delivery_fence=9 where id=${`item-${suffix}-other`}`;
	};
}

/** The next directory read lasts until the row's database deadline has passed. */
function waitDuringRead(expired: () => Promise<unknown>) {
	beforeResolveUser = async () => {
		beforeResolveUser = undefined;
		await vi.waitFor(
			async () => {
				const [row] = (await expired()) as { expired?: boolean }[];
				expect(row?.expired).toBe(true);
			},
			{ timeout: 3000, interval: 20 },
		);
	};
}

function authorizationUrlFor(
	configuration: {
		authorizationEndpoint: string;
		clientId: string;
		callbackUrl: string;
		resource: string;
	},
	state = "b".repeat(64),
) {
	const url = new URL(configuration.authorizationEndpoint);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: configuration.clientId,
		redirect_uri: configuration.callbackUrl,
		state,
		scope: "mcp",
		resource: configuration.resource,
		code_challenge_method: "S256",
		code_challenge: "c".repeat(43),
	}).toString();
	return url.toString();
}

/** A registered installation whose first begin was delivered and its response lost. */
async function beginStatusDelivered() {
	const run = await prepareDelivered();
	expect(await settlePrepared(run)).toBe("registered");
	const first = await claimFirst("begin");
	const begin = {
		commandId: first.item.commandId,
		attemptId: first.attemptId,
		attemptOwner: "worker-a",
		authorizationId: run.authorizationId,
		command: "begin" as const,
	};
	const context = await manual.firstBeginContext(begin);
	if (!context) throw new Error("missing first begin context");
	expect(
		await manual.commitDelivery({ ...begin, deliveryDigest: "4".repeat(64) }),
	).toBe(true);
	expect(await manual.settleBegin(begin)).toBe("unknown");
	await use.executeInstallation({
		userId: "alice",
		identityRevision: "identity-r1",
		command: "status",
		authorizationId: run.authorizationId,
		requestId: "request",
		traceId: "trace",
	});
	const recovery = await claimFirst("begin_status");
	const attempt = {
		commandId: recovery.item.commandId,
		attemptId: recovery.attemptId,
		attemptOwner: "worker-a",
		authorizationId: run.authorizationId,
		command: "begin_status" as const,
	};
	expect(await manual.firstBeginContext(attempt)).toMatchObject({
		beginCommandId: begin.commandId,
	});
	expect(
		await manual.commitDelivery({ ...attempt, deliveryDigest: "6".repeat(64) }),
	).toBe(true);
	return {
		run,
		attempt,
		beginCommandId: begin.commandId,
		result: {
			schemaVersion: 1 as const,
			authorizationId: run.authorizationId,
			phase: "awaiting_callback" as const,
			expiresAt: Date.now() + 60_000,
			authorizationUrl: authorizationUrlFor(context.configuration),
		},
	};
}

/** A first begin whose callback mapping is committed; returns the stored state hash. */
async function mapFirstBegin(
	user = "alice",
	suffix = "a",
	worker = "worker-a",
) {
	const run = await prepareDelivered(user, suffix, worker);
	expect(await settlePrepared(run)).toBe("registered");
	const first = await claimFirst("begin", `execution-${suffix}`, worker);
	const attempt = {
		commandId: first.item.commandId,
		attemptId: first.attemptId,
		attemptOwner: worker,
		authorizationId: run.authorizationId,
		command: "begin" as const,
	};
	const context = await manual.firstBeginContext(attempt);
	if (!context) throw new Error("missing first begin context");
	expect(
		await manual.commitDelivery({ ...attempt, deliveryDigest: "4".repeat(64) }),
	).toBe(true);
	expect(
		await manual.settleBegin({
			...attempt,
			result: {
				schemaVersion: 1,
				authorizationId: run.authorizationId,
				phase: "awaiting_callback",
				expiresAt: Date.now() + 60_000,
				// Each installation gets its own state, as a real first begin does.
				authorizationUrl: authorizationUrlFor(
					context.configuration,
					randomBytes(32).toString("hex"),
				),
			},
		}),
	).toBe("mapped");
	const [row] =
		await client`select binding->'callback'->>'stateHash' as hash from platform.connection_installation_authorizations where id=${run.authorizationId}`;
	return { run, stateHash: row?.hash as string };
}

async function callbackStatus(authorizationId: string) {
	const [row] =
		await client`select binding->'callback'->>'status' as status from platform.connection_installation_authorizations where id=${authorizationId}`;
	return row?.status;
}

/** Consumed first-begin callback and the original user's explicit confirm. */
async function confirmed(user = "alice", suffix = "a", worker = "worker-a") {
	const { run, stateHash } = await mapFirstBegin(user, suffix, worker);
	const claimed = await use.callback.claim({ stateHash, now: Date.now() });
	expect(
		await use.callback.settle({
			stateHash,
			attemptId: claimed?.attemptId as string,
			now: Date.now(),
			status: "delivered",
		}),
	).toBe(true);
	const key = randomUUID();
	const projection = await use.executeInstallation({
		userId: user,
		identityRevision: "identity-r1",
		command: "confirm",
		authorizationId: run.authorizationId,
		idempotencyKey: key,
		requestId: "request",
		traceId: "trace",
	});
	expect(projection).toMatchObject({ manual: true, status: "confirmed" });
	return { run, key, user, suffix, worker };
}

/** Claims the logical confirm and opens phase 1 with a committed delivery. */
async function bindingReadback(flow: Awaited<ReturnType<typeof confirmed>>) {
	const confirm = await claimFirst(
		"confirm",
		`execution-${flow.suffix}`,
		flow.worker,
	);
	const attempt = {
		confirmCommandId: confirm.item.commandId,
		attemptId: confirm.attemptId,
		attemptOwner: flow.worker,
		authorizationId: flow.run.authorizationId,
	};
	const phase = await manual.openConfirmPhase({
		...attempt,
		phase: "confirm_binding_readback",
	});
	if (!phase) throw new Error("phase 1 not opened");
	const deliveryDigest = randomBytes(32).toString("hex");
	expect(
		await manual.commitDelivery({
			commandId: phase.phaseCommandId,
			attemptId: confirm.attemptId,
			attemptOwner: flow.worker,
			command: "confirm_binding_readback",
			authorizationId: flow.run.authorizationId,
			deliveryDigest,
		}),
	).toBe(true);
	return { ...attempt, phaseCommandId: phase.phaseCommandId, deliveryDigest };
}

/** The Host's phase-1 candidate for this installation (EP-1060 readback facts). */
async function candidateFor(
	flow: Awaited<ReturnType<typeof confirmed>>,
	phase: Awaited<ReturnType<typeof bindingReadback>>,
	principalId = "principal-a",
): Promise<ConnectionManualConfirmCandidateV1> {
	const [row] = await client`
		select client_id, consumer_id, instance_id, registration_key, descriptor_digest
		from platform.connection_manual_installations where authorization_id=${flow.run.authorizationId}`;
	const template = flow.run.template;
	return {
		schemaVersion: 1,
		principal: template.principal,
		reference: template.reference,
		authorizationId: template.authorizationId,
		confirmationRevision: template.confirmationRevision,
		association: template.association,
		confirm: {
			commandId: phase.confirmCommandId,
			phase: "binding_readback",
			phaseCommandId: phase.phaseCommandId,
			requestDigest: phase.deliveryDigest,
		},
		target: template.target,
		descriptorDigest: row?.descriptor_digest as string,
		supply: template.supply,
		exceptionPolicy: dynamic.principalMapping.policy,
		verified: {
			issuer: access.system.issuer,
			registrationKey: row?.registration_key as string,
			principalId,
			clientId: row?.client_id as string,
			consumerId: row?.consumer_id as string,
			instanceId: row?.instance_id as string,
			redirectUri: template.registration.redirectUri,
			resource: template.registration.resource,
			scope: "mcp",
			instanceStatus: "ACTIVE",
		},
	};
}

async function pinFacts(authorizationId: string) {
	const [row] = await client`select
		(select count(*)::int from platform.connection_principal_pins where released_at is null) as pins,
		(select count(*)::int from platform.connection_principal_pin_receipts where authorization_id=${authorizationId}) as receipts,
		(select a.status from platform.connection_installation_authorizations a where a.id=${authorizationId}) as status,
		(select m.revoke_state from platform.connection_manual_installations m where m.authorization_id=${authorizationId}) as revoke_state,
		(select string_agg(command || ':' || status, ',' order by created_at, command)
			from platform.connection_installation_commands
			where authorization_id=${authorizationId} and command like 'confirm%') as confirm`;
	return row;
}

describe("manual Owner EP-1060 install Store (§13.5.5–§13.5.7)", () => {
	it("creates a pre-registration authorization with one prepare and no link", async () => {
		const key = randomUUID();
		const projection = await begin("alice", "a", key);
		expect(projection).toMatchObject({
			manual: true,
			status: "awaiting_confirmation",
		});
		expect(projection).not.toHaveProperty("authorizationUrl");
		// Same key and request replays the same installation; it never duplicates.
		expect((await begin("alice", "a", key)).authorizationId).toBe(
			projection.authorizationId,
		);
		const commands =
			await client`select command, status from platform.connection_installation_commands where authorization_id=${projection.authorizationId}`;
		expect(commands).toEqual([{ command: "prepare", status: "pending" }]);
		// Confirm and the callback stay closed before the configuration is fixed.
		await expect(
			use.executeInstallation({
				userId: "alice",
				identityRevision: "identity-r1",
				command: "confirm",
				authorizationId: projection.authorizationId,
				idempotencyKey: randomUUID(),
				requestId: "request",
				traceId: "trace",
			}),
		).rejects.toMatchObject({ code: "denied" });
		// Another user cannot read or touch the installation.
		await expect(
			use.executeInstallation({
				userId: "bob",
				identityRevision: "identity-r1",
				command: "status",
				authorizationId: projection.authorizationId,
				requestId: "request",
				traceId: "trace",
			}),
		).rejects.toMatchObject({ code: "denied" });
		// The static path never returns a manual projection.
		await expect(
			use.execute({
				userId: "alice",
				identityRevision: "identity-r1",
				command: "begin",
				executionId: "execution-a",
				idempotencyKey: randomUUID(),
				requestId: "request",
				traceId: "trace",
			}),
		).rejects.toMatchObject({ code: "denied" });
	});

	it("is unavailable without an Owner manual association", async () => {
		await client`delete from platform.connection_manual_associations where agent_id='agent-a'`;
		await expect(begin()).rejects.toMatchObject({ code: "denied" });
	});

	// §13.5.1: a missing or invalid dynamic approval keeps the whole route closed.
	it.each([
		["no dynamic approval", undefined],
		[
			"an exception for another system access",
			{
				...dynamic,
				principalMapping: {
					...dynamic.principalMapping,
					systemAccessFingerprint: "a".repeat(64),
				},
			},
		],
		[
			"an exception without a Connection release",
			{
				...dynamic,
				principalMapping: {
					...dynamic.principalMapping,
					connectionRelease: undefined,
				},
			},
		],
		[
			"a mapping rule without a server resolver",
			{
				...dynamic,
				principalMapping: {
					schemaVersion: 1,
					kind: "principal_mapping",
					authority: { ref: "corp-identity", revision: "r1" },
					rule: { ref: "ldap-uid-to-connection-subject", revision: "r1" },
					issuer: system.issuer,
					resolution: { ref: "identity-adapter-ldap", revision: "r1" },
					systemAccessFingerprint: connectionSystemAccessFingerprintV1(system),
					approvalSource: systemApproval.source,
				},
			},
		],
	])("keeps the manual route closed with %s", (_name, value) => {
		const refused = (create: () => unknown) => {
			try {
				create();
			} catch (error) {
				return (error as { code?: string }).code;
			}
			return "constructed";
		};
		const input = { ...policy, dynamic: value } as never;
		expect(
			refused(
				() =>
					new PostgresConnectionManualInstallationStoreV1({
						databaseUrl: database.databaseUrl,
						directory,
						policy: input,
					}),
			),
		).toBe("unavailable");
		expect(
			refused(
				() =>
					new PostgresConnectionInstallationAuthorizationTransactionV1({
						databaseUrl: database.databaseUrl,
						directory,
						manualInstallation: input,
					}),
			),
		).toBe("unavailable");
	});

	// §13.5.1 exception item 3: uniqueness also counts Principals confirmed
	// outside the exception. Without the caller's server-resolved complete set
	// the route stays closed instead of treating it as an empty, verified set.
	it.each([
		["omitted", undefined],
		["null", null],
		["not a list", { issuer: system.issuer }],
	])(
		"keeps the manual route closed when the confirmed Principals are %s",
		(_name, value) => {
			const { confirmedPrincipals: _confirmed, ...rest } = policy;
			const input = (
				value === undefined ? rest : { ...rest, confirmedPrincipals: value }
			) as never;
			const refused = (create: () => { close(): Promise<void> }) => {
				try {
					void create().close();
				} catch (error) {
					return (error as { code?: string }).code;
				}
				return "constructed";
			};
			expect(
				refused(
					() =>
						new PostgresConnectionManualInstallationStoreV1({
							databaseUrl: database.databaseUrl,
							directory,
							policy: input,
						}),
				),
			).toBe("unavailable");
			expect(
				refused(
					() =>
						new PostgresConnectionInstallationAuthorizationTransactionV1({
							databaseUrl: database.databaseUrl,
							directory,
							manualInstallation: input,
						}),
				),
			).toBe("unavailable");
		},
	);

	// §13.5.1 item 8: after `notAfter` (database clock) the exception accepts no new
	// installation, and an installation begun before it binds no receipt.
	it("accepts no new installation and binds no receipt after the exception's notAfter", async () => {
		const expired = {
			...policy,
			dynamic: {
				...dynamic,
				principalMapping: {
					...dynamic.principalMapping,
					notAfter: "2026-01-01T00:00:00Z",
				},
			},
		};
		const lateInstallations =
			new PostgresConnectionInstallationAuthorizationTransactionV1({
				databaseUrl: database.databaseUrl,
				directory,
				manualInstallation: expired,
			});
		const lateManual = new PostgresConnectionManualInstallationStoreV1({
			databaseUrl: database.databaseUrl,
			directory,
			policy: expired,
		});
		try {
			await expect(
				createConnectionInstallationAuthorizationV1({
					store: lateInstallations,
				}).executeInstallation({
					userId: "alice",
					identityRevision: "identity-r1",
					command: "begin",
					executionId: "execution-a",
					idempotencyKey: randomUUID(),
					requestId: "request",
					traceId: "trace",
				}),
			).rejects.toMatchObject({ code: "denied" });
			const [empty] = await client`select
				(select count(*)::int from platform.connection_installation_authorizations) as authorizations,
				(select count(*)::int from platform.connection_manual_installations) as installations,
				(select count(*)::int from platform.connection_installation_commands) as commands`;
			expect(empty).toEqual({
				authorizations: 0,
				installations: 0,
				commands: 0,
			});

			const run = await prepareDelivered();
			expect(
				await lateManual.settleRegistration({
					commandId: run.prepare.item.commandId,
					attemptId: run.prepare.attemptId,
					attemptOwner: "worker-a",
					command: "prepare",
					authorizationId: run.authorizationId,
					response: {
						schemaVersion: 1,
						outcome: "registered",
						commandId: run.prepare.item.commandId,
						receipt: receiptFor(run.template, run.registrationKey),
					},
				}),
			).toBe("unknown");
			const [row] = await client`
				select a.status, m.registration_state, m.configuration, m.descriptor, m.revoke_state
				from platform.connection_installation_authorizations a
				join platform.connection_manual_installations m on m.authorization_id=a.id
				where a.id=${run.authorizationId}`;
			expect(row).toEqual({
				status: "revoked",
				registration_state: "closed",
				configuration: null,
				descriptor: null,
				revoke_state: "pending",
			});
			// The registered client is compensated with its original key; no begin exists.
			expect(
				(
					await client`select command, status from platform.connection_installation_commands
						where authorization_id=${run.authorizationId} order by created_at`
				).map(({ command, status }) => `${command}:${status}`),
			).toEqual(["prepare:completed", "revoke:pending"]);
		} finally {
			await lateManual.close();
			await lateInstallations.close();
		}
	});

	// PR-Agent on #4206: the static-only `execute` entry used to commit the manual
	// begin before refusing its projection. It now refuses before any write.
	it("refuses the manual route through the static-only entry before any write", async () => {
		const facts = async () => {
			const [row] = await client`select
				(select count(*)::int from platform.connection_installation_authorizations) as authorizations,
				(select count(*)::int from platform.connection_manual_installations) as installations,
				(select count(*)::int from platform.connection_installation_commands) as commands,
				(select count(*)::int from platform.idempotency_records where scope_type='connection_installation') as receipts,
				(select count(*)::int from platform.audit_events where action like 'connection.installation.%') as audits`;
			return row;
		};
		const before = await facts();
		const staticRequest = (
			command: "begin" | "confirm" | "status",
			authorizationId?: string,
		) =>
			use.execute({
				userId: "alice",
				identityRevision: "identity-r1",
				command,
				...(command === "begin"
					? { executionId: "execution-a" }
					: { authorizationId }),
				...(command === "status" ? {} : { idempotencyKey: randomUUID() }),
				requestId: "request",
				traceId: "trace",
			});
		await expect(staticRequest("begin")).rejects.toMatchObject({
			code: "denied",
		});
		expect(await facts()).toEqual(before);

		// Before and after the receipt CAS, the static entry neither reads back nor
		// enqueues a manual status, begin_status or confirm.
		const run = await prepareDelivered();
		const commands = () =>
			client`select command, status from platform.connection_installation_commands
				where authorization_id=${run.authorizationId} order by created_at, command`;
		const pending = await commands();
		for (const command of ["status", "confirm"] as const)
			await expect(
				staticRequest(command, run.authorizationId),
			).rejects.toMatchObject({ code: "denied" });
		expect(await commands()).toEqual(pending);
		expect(await settlePrepared(run)).toBe("registered");
		const bound = await commands();
		for (const command of ["status", "confirm"] as const)
			await expect(
				staticRequest(command, run.authorizationId),
			).rejects.toMatchObject({ code: "denied" });
		expect(await commands()).toEqual(bound);
		const [audits] =
			await client`select count(*)::int as n from platform.audit_events where details->>'authorizationId'=${run.authorizationId}`;
		expect(audits?.n).toBe(1);
	});

	it("claims only on the original claim holder and fixes one template", async () => {
		const projection = await begin();
		const pending = await manual.listPending(32, ["execution-a"]);
		expect(pending.map((entry) => entry.command)).toEqual(["prepare"]);
		// Another Worker never claims an Execution it does not hold.
		expect(
			await manual.claim({
				commandId: pending[0]?.commandId as string,
				attemptId: randomUUID(),
				attemptOwner: "worker-b",
			}),
		).toBeNull();
		const [rejected] =
			await client`select status from platform.connection_installation_commands where id=${pending[0]?.commandId as string}`;
		expect(rejected?.status).toBe("rejected");
		expect(projection).toMatchObject({ manual: true });
	});

	it("rejects cross-user, cross-Agent, wrong-Pod and stale-claim templates before supply", async () => {
		const projection = await begin();
		const prepare = await claimFirst("prepare");
		for (const options of [
			{ user: "bob" },
			{ connectionAgentId: "connection-agent-b" },
			{ podUid: "other-pod" },
			{ claimFence: 2 },
		]) {
			const { template, registrationKey } = await templateFor(
				projection.authorizationId,
				options,
			);
			expect(
				await manual.fixSupply({
					commandId: prepare.item.commandId,
					attemptId: prepare.attemptId,
					attemptOwner: "worker-a",
					command: "prepare",
					template,
					registrationKey,
					supplyAttemptId: randomUUID(),
				}),
			).toBeNull();
		}
		const [row] =
			await client`select template, supply_state from platform.connection_manual_installations where authorization_id=${projection.authorizationId}`;
		expect(row).toEqual({ template: null, supply_state: "pending" });
	});

	it("reads back only the original supply attempt and the command's own sending digest", async () => {
		const run = await prepareDelivered();
		expect(await manual.readback(run.commandReadback)).toBe("allowed");
		for (const request of [
			{
				...run.readbackBase,
				purpose: "supply" as const,
				supply: { ...run.readbackBase.supply, attemptId: randomUUID() },
			},
			{
				...run.readbackBase,
				purpose: "supply" as const,
				templateDigest: "0".repeat(64),
			},
			{
				...run.readbackBase,
				purpose: "supply" as const,
				target: { ...run.template.target, podUid: "rebuilt-pod" },
			},
			{
				...run.readbackBase,
				purpose: "supply" as const,
				target: { ...run.template.target, resourceFence: 9 },
			},
			{
				...run.readbackBase,
				purpose: "supply" as const,
				principal: { kind: "user" as const, id: "bob" },
			},
			{
				...run.commandReadback,
				command: {
					...run.commandReadback.command,
					requestDigest: "1".repeat(64),
				},
			},
			{
				...run.commandReadback,
				command: { ...run.commandReadback.command, attemptId: randomUUID() },
			},
			{
				...run.commandReadback,
				command: { ...run.commandReadback.command, command: "status" as const },
			},
			{
				...run.commandReadback,
				command: {
					...run.commandReadback.command,
					registrationKeyHash: "2".repeat(64),
				},
			},
		])
			expect(await manual.readback(request)).toBe("denied");
		// A second delivery digest is never accepted for the same attempt.
		expect(
			await manual.commitDelivery({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
				deliveryDigest: "3".repeat(64),
			}),
		).toBe(false);
	});

	it("keeps the original supply unknown when the Host reply outlasts authorization", async () => {
		const run = await fixSupply();
		await client`update platform.connection_installation_authorizations
			set expires_at=clock_timestamp()-interval '1 second' where id=${run.authorizationId}`;
		expect(
			await manual.settleSupply({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
				supplyAttemptId: run.supplyAttemptId,
				outcome: "confirmed",
			}),
		).toBe(false);
		const [row] =
			await client`select m.supply_state, m.registration_key, c.status
			from platform.connection_manual_installations m join platform.connection_installation_commands c
			on c.authorization_id=m.authorization_id where c.id=${run.prepare.item.commandId}`;
		expect(row).toEqual({
			supply_state: "unknown",
			registration_key: run.registrationKey,
			status: "unknown",
		});
	});

	it("keeps supply unknown when authorization readback outlasts the recovery attempt", async () => {
		const run = await fixSupply();
		const { authorizationId, supplyAttemptId } = run;
		expect(
			await manual.settleSupply({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId,
				supplyAttemptId,
				outcome: "unknown",
			}),
		).toBe(true);
		const requestStatus = () =>
			use.executeInstallation({
				userId: "alice",
				identityRevision: "identity-r1",
				command: "status",
				authorizationId,
				requestId: "request",
				traceId: "trace",
			});
		await requestStatus();
		const recovery = await claimFirst("status");
		const attempt = {
			commandId: recovery.item.commandId,
			attemptId: recovery.attemptId,
			attemptOwner: "worker-a",
			authorizationId,
		};
		expect(
			await manual.commitDelivery({
				...attempt,
				command: "status",
				deliveryDigest: "5".repeat(64),
			}),
		).toBe(true);
		await client`update platform.connection_installation_commands
			set attempt_expires_at=clock_timestamp()+interval '1 second' where id=${attempt.commandId}`;
		let observedLive = false;
		beforeResolveUser = async () => {
			const [row] =
				await client`select attempt_expires_at > clock_timestamp() as live
				from platform.connection_installation_commands where id=${attempt.commandId}`;
			observedLive = row?.live === true;
			await vi.waitFor(
				async () => {
					const [current] =
						await client`select attempt_expires_at <= clock_timestamp() as expired
					from platform.connection_installation_commands where id=${attempt.commandId}`;
					expect(current?.expired).toBe(true);
				},
				{ timeout: 3000, interval: 20 },
			);
		};
		try {
			await manual.recoverSupply({
				...attempt,
				supplyAttemptId,
				confirmed: true,
			});
		} finally {
			beforeResolveUser = undefined;
		}
		expect(observedLive).toBe(true);
		const [row] =
			await client`select m.supply_state, m.registration_state, p.status as prepare, s.status as status
			from platform.connection_manual_installations m
			join platform.connection_installation_commands p on p.authorization_id=m.authorization_id
			join platform.connection_installation_commands s on s.authorization_id=m.authorization_id
			where p.id=${run.prepare.item.commandId} and s.id=${attempt.commandId}`;
		expect(row).toEqual({
			supply_state: "unknown",
			registration_state: "pending",
			prepare: "unknown",
			status: "unknown",
		});
		expect(await manual.listPending(32, ["execution-a"])).toEqual([]);
		await expect(requestStatus()).resolves.not.toHaveProperty(
			"authorizationUrl",
		);
		const retry = await claimFirst("status");
		expect(retry.claimed?.installation).toMatchObject({
			registrationKey: run.registrationKey,
			supplyAttemptId,
			supplyState: "unknown",
		});
	});

	it("binds the configuration only after a deep-matching receipt CAS and enqueues one first begin", async () => {
		const run = await prepareDelivered();
		const receipt = receiptFor(run.template, run.registrationKey);
		expect(
			await manual.settleRegistration({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
				response: {
					schemaVersion: 1,
					outcome: "registered",
					commandId: run.prepare.item.commandId,
					receipt,
				},
			}),
		).toBe("registered");
		// A replayed or late receipt for the same attempt is stale.
		expect(
			await manual.settleRegistration({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
				response: {
					schemaVersion: 1,
					outcome: "registered",
					commandId: run.prepare.item.commandId,
					receipt: receiptFor(run.template, run.registrationKey),
				},
			}),
		).toBe("stale");
		const [row] =
			await client`select a.status, a.binding, m.registration_state, m.client_id, m.configuration from platform.connection_installation_authorizations a join platform.connection_manual_installations m on m.authorization_id=a.id where a.id=${run.authorizationId}`;
		expect(row?.status).toBe("awaiting_confirmation");
		expect(row?.registration_state).toBe("registered");
		expect(row?.client_id).toBe(receipt.clientId);
		const configuration = row?.configuration as {
			clientId: string;
			runtimeOrigin: string;
			ref: string;
			revision: string;
		};
		expect(configuration).toMatchObject({
			clientId: receipt.clientId,
			runtimeOrigin: run.template.target.runtimeOrigin,
		});
		expect(
			((row as { binding: unknown }).binding as { scope: unknown }).scope,
		).toMatchObject({
			oauthConfiguration: {
				ref: configuration.ref,
				revision: configuration.revision,
			},
		});
		// Core status now reselects the bound per-install configuration.
		const status = await use.executeInstallation({
			userId: "alice",
			identityRevision: "identity-r1",
			command: "status",
			authorizationId: run.authorizationId,
			requestId: "request",
			traceId: "trace",
		});
		expect(status).toMatchObject({ status: "awaiting_confirmation" });
		expect(status).not.toHaveProperty("authorizationUrl");
		const pending = await manual.listPending(32, ["execution-a"]);
		expect(pending.map((entry) => entry.command)).toEqual(["begin"]);
		// The static drain never sees manual installations.
		expect(await installations.listPending(32, ["execution-a"])).toEqual([]);
	});

	it.each(["unlink", "replace"] as const)(
		"settles an in-flight receipt without a deadlock during Owner %s",
		async (operation) => {
			const run = await prepareDelivered();
			const ownerLocked = Promise.withResolvers<void>();
			const releaseOwner = Promise.withResolvers<void>();
			const owner = associations.execute(async (tx) => {
				await tx.current("agent-a");
				ownerLocked.resolve();
				await releaseOwner.promise;
				return operation === "unlink"
					? tx.deleteManual("agent-a", 1)
					: tx.saveManual({
							agentId: "agent-a",
							ownerId: "owner",
							connectionAgentId: "connection-agent-new",
							credentialFingerprint: randomBytes(32).toString("hex"),
							expectedRevision: 1,
							encrypt: ({ agentId, ownerId, associationRevision }) => ({
								schemaVersion: 1,
								agentId,
								ownerId,
								secretVersion: associationRevision,
								crypto: { dekFingerprint: randomBytes(32).toString("hex") },
							}),
						});
			});
			await ownerLocked.promise;
			const settlement = settlePrepared(run);
			const done = Promise.allSettled([owner, settlement]);
			try {
				await vi.waitFor(
					async () => {
						const waiting = await client`select pid from pg_stat_activity
						where datname=current_database() and cardinality(pg_blocking_pids(pid))>0`;
						expect(waiting).toHaveLength(1);
					},
					{ timeout: 3000, interval: 20 },
				);
			} finally {
				releaseOwner.resolve();
				await done;
			}
			expect(await done).toEqual([
				{ status: "fulfilled", value: operation === "unlink" ? true : 2 },
				{ status: "fulfilled", value: "unknown" },
			]);
			const [row] =
				await client`select a.status, m.supply_state, m.configuration, m.registration_key
				from platform.connection_manual_installations m join platform.connection_installation_authorizations a on a.id=m.authorization_id
				where m.authorization_id=${run.authorizationId}`;
			expect(row).toMatchObject({
				status: "revoked",
				supply_state: "closed",
				configuration: null,
				registration_key: run.registrationKey,
			});
			expect(await manual.listPending(32, ["execution-a"])).toEqual([]);
		},
	);

	it("keeps a receipt out of begin if the settlement lock wait outlasts the attempt", async () => {
		const run = await prepareDelivered();
		const blocker = await client.reserve();
		let completed: ReturnType<typeof settlePrepared> | undefined;
		try {
			const lockScope = JSON.stringify([
				"connection-manual-consumer",
				"agent-a",
				1,
			]);
			const [lock] =
				await blocker`select pg_backend_pid() as pid, pg_advisory_lock(hashtextextended(${lockScope},0))`;
			await client`update platform.connection_installation_commands
				set attempt_expires_at=clock_timestamp()+interval '1 second' where id=${run.prepare.item.commandId}`;
			completed = settlePrepared(run);
			void completed.catch(() => undefined);
			await vi.waitFor(
				async () => {
					const waiting =
						await client`select pid from pg_stat_activity where ${lock?.pid}=any(pg_blocking_pids(pid))`;
					expect(waiting).toHaveLength(1);
				},
				{ timeout: 3000, interval: 20 },
			);
			await vi.waitFor(
				async () => {
					const [row] =
						await client`select attempt_expires_at <= clock_timestamp() as expired
					from platform.connection_installation_commands where id=${run.prepare.item.commandId}`;
					expect(row?.expired).toBe(true);
				},
				{ timeout: 3000, interval: 20 },
			);
			await blocker`select pg_advisory_unlock(hashtextextended(${lockScope},0))`;
		} finally {
			await blocker`select pg_advisory_unlock_all()`;
			blocker.release();
			await completed?.catch(() => undefined);
		}
		await expect(completed).resolves.toBe("unknown");
		const [row] =
			await client`select m.registration_state, m.consumer_id, m.configuration,
			m.registration_key, c.status from platform.connection_manual_installations m
			join platform.connection_installation_commands c on c.authorization_id=m.authorization_id
			where c.id=${run.prepare.item.commandId}`;
		expect(row).toEqual({
			registration_state: "unknown",
			consumer_id: null,
			configuration: null,
			registration_key: run.registrationKey,
			status: "unknown",
		});
		expect(await manual.listPending(32, ["execution-a"])).toEqual([]);
		const status = await use.executeInstallation({
			userId: "alice",
			identityRevision: "identity-r1",
			command: "status",
			authorizationId: run.authorizationId,
			requestId: "request",
			traceId: "trace",
		});
		expect(status).toMatchObject({ manual: true, status: "unknown" });
		const recovery = await claimFirst("status");
		expect(recovery.claimed?.installation.registrationKey).toBe(
			run.registrationKey,
		);
	});

	it("pins one Consumer when two installations settle concurrently", async () => {
		const first = await prepareDelivered();
		const second = await prepareDelivered("bob", "bob", "worker-b");
		const settle = (run: typeof first, consumerId: string) =>
			manual.settleRegistration({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: run.commandReadback.command.attemptOwner,
				command: "prepare",
				authorizationId: run.authorizationId,
				response: {
					schemaVersion: 1,
					outcome: "registered",
					commandId: run.prepare.item.commandId,
					receipt: receiptFor(run.template, run.registrationKey, {
						consumerId,
					}),
				},
			});

		// Pause each successful update after its Consumer check. Observe both
		// transactions waiting before allowing the first one to commit.
		await client`create function platform.pause_consumer_settlement() returns trigger
			language plpgsql as $$
			begin
				perform pg_advisory_xact_lock(4206, 4199);
				return new;
			end
			$$`;
		await client`create trigger pause_consumer_settlement before update on platform.connection_manual_installations
			for each row when (new.registration_state = 'registered')
			execute function platform.pause_consumer_settlement()`;
		const pending: ReturnType<typeof settle>[] = [];
		const blocker = await client.reserve();
		try {
			const [lock] =
				await blocker`select pg_backend_pid() as pid, pg_advisory_lock(4206, 4199)`;
			pending.push(settle(first, "consumer-first"));
			await vi.waitFor(
				async () => {
					const blocked = await client`select pid from pg_stat_activity
					where ${lock?.pid} = any(pg_blocking_pids(pid))`;
					expect(blocked).toHaveLength(1);
				},
				{ timeout: 3000, interval: 20 },
			);
			pending.push(settle(second, "consumer-second"));
			await vi.waitFor(
				async () => {
					const [blocked] =
						await client`select count(*)::int as count from pg_locks
					where database = (select oid from pg_database where datname = current_database())
						and locktype = 'advisory' and not granted`;
					expect(blocked?.count).toBe(2);
				},
				{ timeout: 3000, interval: 20 },
			);
		} finally {
			await blocker`select pg_advisory_unlock(4206, 4199)`;
			blocker.release();
			await Promise.allSettled(pending);
			await client`drop trigger pause_consumer_settlement on platform.connection_manual_installations`;
			await client`drop function platform.pause_consumer_settlement()`;
		}
		expect(await Promise.all(pending)).toEqual(["registered", "unknown"]);

		const [accepted] =
			await client`select registration_state, consumer_id from platform.connection_manual_installations where authorization_id=${first.authorizationId}`;
		expect(accepted).toMatchObject({
			registration_state: "registered",
			consumer_id: "consumer-first",
		});
		const [rejected] = await client`
			select a.status, m.registration_state, m.consumer_id, m.configuration, m.revoke_state,
				m.receipt->>'consumerId' as rejected_consumer
			from platform.connection_manual_installations m
			join platform.connection_installation_authorizations a on a.id=m.authorization_id
			where m.authorization_id=${second.authorizationId}`;
		expect(rejected).toMatchObject({
			status: "revoked",
			registration_state: "closed",
			consumer_id: null,
			configuration: null,
			revoke_state: "pending",
			rejected_consumer: "consumer-second",
		});
		expect(
			(await manual.listPending(32, ["execution-a", "execution-bob"])).map(
				({ command, authorizationId }) => [command, authorizationId],
			),
		).toEqual(
			expect.arrayContaining([
				["begin", first.authorizationId],
				["revoke", second.authorizationId],
			]),
		);
		const next = await prepareDelivered();
		expect(await settle(next, "consumer-first")).toBe("registered");
	});

	it("never binds a mismatching, replaced or late receipt", async () => {
		for (const override of [
			{ redirectUri: "https://other.test/callback" },
			{ principalId: "connection-principal" },
			{ clientStatus: "REVOKED" },
			{ registrationKey: "mi-other-key-000000" },
		]) {
			const run = await prepareDelivered();
			const result = await manual.settleRegistration({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
				response: {
					schemaVersion: 1,
					outcome: "registered",
					commandId: run.prepare.item.commandId,
					receipt: receiptFor(run.template, run.registrationKey, override),
				},
			});
			expect(result).toBe("unknown");
			const [row] =
				await client`select a.status, m.registration_state, m.configuration from platform.connection_installation_authorizations a join platform.connection_manual_installations m on m.authorization_id=a.id where a.id=${run.authorizationId}`;
			expect(row?.configuration).toBeNull();
			expect(row?.status).not.toBe("awaiting_confirmation");
			expect(
				(await manual.listPending(32, ["execution-a"])).map(
					(entry) => entry.command,
				),
			).not.toContain("begin");
			await client`delete from platform.connection_manual_installations`;
			await client`delete from platform.connection_installation_commands`;
			await client`delete from platform.connection_installation_authorizations`;
		}
		// Unbind before the receipt arrives: the late receipt cannot reopen anything.
		const run = await prepareDelivered();
		expect(
			await associations.execute((transaction) =>
				transaction.deleteManual("agent-a", 1),
			),
		).toBe(true);
		expect(
			await manual.settleRegistration({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
				response: {
					schemaVersion: 1,
					outcome: "registered",
					commandId: run.prepare.item.commandId,
					receipt: receiptFor(run.template, run.registrationKey),
				},
			}),
		).toBe("unknown");
		const [row] =
			await client`select a.status, m.supply_state, m.revoke_state, m.configuration, m.registration_key from platform.connection_installation_authorizations a join platform.connection_manual_installations m on m.authorization_id=a.id where a.id=${run.authorizationId}`;
		expect(row).toMatchObject({
			status: "revoked",
			supply_state: "closed",
			revoke_state: "unknown",
			configuration: null,
			registration_key: run.registrationKey,
		});
		expect(await manual.readback(run.commandReadback)).toBe("denied");
	});

	it("keeps a lost prepare unknown and verifies only through a user-requested status", async () => {
		const run = await prepareDelivered();
		expect(
			await manual.settleRegistration({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
			}),
		).toBe("unknown");
		// No automatic retry: nothing is pending until the original user asks.
		expect(await manual.listPending(32, ["execution-a"])).toEqual([]);
		const projection = await use.executeInstallation({
			userId: "alice",
			identityRevision: "identity-r1",
			command: "status",
			authorizationId: run.authorizationId,
			requestId: "request",
			traceId: "trace",
		});
		expect(projection).toMatchObject({ manual: true, status: "unknown" });
		const status = await claimFirst("status");
		expect(status.claimed?.installation.registrationKey).toBe(
			run.registrationKey,
		);
		// Status never receives ciphertext, even for the original supply attempt.
		expect(
			await manual.fixSupply({
				commandId: status.item.commandId,
				attemptId: status.attemptId,
				attemptOwner: "worker-a",
				command: "status",
				template: run.template,
				registrationKey: run.registrationKey,
				supplyAttemptId: run.supplyAttemptId,
			}),
		).toBeNull();
		expect(
			await manual.fixSupply({
				commandId: status.item.commandId,
				attemptId: status.attemptId,
				attemptOwner: "worker-a",
				command: "status",
				template: run.template,
				registrationKey: run.registrationKey,
				supplyAttemptId: randomUUID(),
			}),
		).toBeNull();
		const digest = connectionInstallCommandDigestV1({
			schemaVersion: 1,
			command: "status",
			commandId: status.item.commandId,
			attemptId: status.attemptId,
			attemptOwner: "worker-a",
			template: run.template,
			supplyAttemptId: run.supplyAttemptId,
			registrationKey: run.registrationKey,
		});
		expect(
			await manual.commitDelivery({
				commandId: status.item.commandId,
				attemptId: status.attemptId,
				attemptOwner: "worker-a",
				command: "status",
				authorizationId: run.authorizationId,
				deliveryDigest: digest,
			}),
		).toBe(true);
		expect(
			await manual.readback({
				...run.commandReadback,
				command: {
					...run.commandReadback.command,
					commandId: status.item.commandId,
					attemptId: status.attemptId,
					command: "status",
					requestDigest: digest,
				},
			}),
		).toBe("allowed");
		expect(
			await manual.settleRegistration({
				commandId: status.item.commandId,
				attemptId: status.attemptId,
				attemptOwner: "worker-a",
				command: "status",
				authorizationId: run.authorizationId,
				response: {
					schemaVersion: 1,
					outcome: "registered",
					commandId: status.item.commandId,
					receipt: receiptFor(run.template, run.registrationKey),
				},
			}),
		).toBe("registered");
	});

	it("keeps begin unknown when authorization readback outlasts the attempt", async () => {
		const run = await prepareDelivered();
		expect(await settlePrepared(run)).toBe("registered");
		const first = await claimFirst("begin");
		const attempt = {
			commandId: first.item.commandId,
			attemptId: first.attemptId,
			attemptOwner: "worker-a",
			authorizationId: run.authorizationId,
			command: "begin" as const,
		};
		const context = await manual.firstBeginContext(attempt);
		if (!context) throw new Error("missing first begin context");
		const { configuration } = context;
		expect(
			await manual.commitDelivery({
				...attempt,
				deliveryDigest: "4".repeat(64),
			}),
		).toBe(true);
		const url = new URL(configuration.authorizationEndpoint);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: configuration.clientId,
			redirect_uri: configuration.callbackUrl,
			state: "b".repeat(64),
			scope: "mcp",
			resource: configuration.resource,
			code_challenge_method: "S256",
			code_challenge: "c".repeat(43),
		}).toString();
		await client`update platform.connection_installation_commands
			set attempt_expires_at=clock_timestamp()+interval '1 second' where id=${attempt.commandId}`;
		let observedLive = false;
		beforeResolveUser = async () => {
			const [row] =
				await client`select attempt_expires_at > clock_timestamp() as live
				from platform.connection_installation_commands where id=${attempt.commandId}`;
			observedLive = row?.live === true;
			await vi.waitFor(
				async () => {
					const [current] =
						await client`select attempt_expires_at <= clock_timestamp() as expired
					from platform.connection_installation_commands where id=${attempt.commandId}`;
					expect(current?.expired).toBe(true);
				},
				{ timeout: 3000, interval: 20 },
			);
		};
		let outcome: Awaited<ReturnType<typeof manual.settleBegin>>;
		try {
			outcome = await manual.settleBegin({
				...attempt,
				result: {
					schemaVersion: 1,
					authorizationId: run.authorizationId,
					phase: "awaiting_callback",
					expiresAt: Date.now() + 60_000,
					authorizationUrl: url.toString(),
				},
			});
		} finally {
			beforeResolveUser = undefined;
		}
		expect(observedLive).toBe(true);
		expect(outcome).toBe("unknown");
		const [row] =
			await client`select m.registration_key, c.status, a.binding->'callback' as callback,
			a.binding->>'authorizationUrl' as url
			from platform.connection_manual_installations m
			join platform.connection_installation_authorizations a on a.id=m.authorization_id
			join platform.connection_installation_commands c on c.authorization_id=a.id
			where c.id=${attempt.commandId}`;
		expect(row).toEqual({
			registration_key: run.registrationKey,
			status: "unknown",
			callback: null,
			url: null,
		});
		const status = await use.executeInstallation({
			userId: "alice",
			identityRevision: "identity-r1",
			command: "status",
			authorizationId: run.authorizationId,
			requestId: "request",
			traceId: "trace",
		});
		expect(status).not.toHaveProperty("authorizationUrl");
		const recovery = await claimFirst("begin_status");
		const recoveryContext = await manual.firstBeginContext({
			commandId: recovery.item.commandId,
			attemptId: recovery.attemptId,
			attemptOwner: "worker-a",
			authorizationId: run.authorizationId,
			command: "begin_status",
		});
		expect(recoveryContext).toMatchObject({
			beginCommandId: attempt.commandId,
			registrationKey: run.registrationKey,
		});
	});

	it.each(["unlink pending", "replace in-flight"] as const)(
		"archives compensation under its original key on Owner %s",
		async (scenario) => {
			const first = await prepareDelivered();
			expect(await settlePrepared(first)).toBe("registered");
			const run = await prepareDelivered("bob", "bob", "worker-b");
			expect(
				await settlePrepared(run, { consumerId: "consumer-conflict" }),
			).toBe("unknown");
			const pending = (await manual.listPending(32, ["execution-bob"])).find(
				(entry) => entry.command === "revoke",
			);
			if (!pending) throw new Error("missing pending compensation");
			const claimed =
				scenario === "replace in-flight"
					? await claimFirst("revoke", "execution-bob", "worker-b")
					: undefined;
			if (claimed) {
				expect(
					await manual.commitDelivery({
						commandId: pending.commandId,
						attemptId: claimed.attemptId,
						attemptOwner: "worker-b",
						command: "revoke",
						authorizationId: run.authorizationId,
						deliveryDigest: "7".repeat(64),
					}),
				).toBe(true);
				expect(
					await associations.execute((tx) =>
						tx.saveManual({
							agentId: "agent-a",
							ownerId: "owner",
							connectionAgentId: "connection-agent-new",
							credentialFingerprint: randomBytes(32).toString("hex"),
							expectedRevision: 1,
							encrypt: ({ agentId, ownerId, associationRevision }) => ({
								schemaVersion: 1,
								agentId,
								ownerId,
								secretVersion: associationRevision,
								crypto: { dekFingerprint: randomBytes(32).toString("hex") },
							}),
						}),
					),
				).toBe(2);
				expect(
					await manual.settleRevoke({
						commandId: pending.commandId,
						attemptId: claimed.attemptId,
						attemptOwner: "worker-b",
						authorizationId: run.authorizationId,
						response: {
							schemaVersion: 1,
							commandId: pending.commandId,
							outcome: "revoked",
						},
					}),
				).toBe("stale");
			} else {
				expect(
					await associations.execute((tx) => tx.deleteManual("agent-a", 1)),
				).toBe(true);
			}
			const [row] =
				await client`select m.registration_key, m.revoke_state, m.supply_state,
			m.receipt->>'consumerId' as consumer, c.status
			from platform.connection_manual_installations m
			join platform.connection_installation_commands c on c.authorization_id=m.authorization_id
			where c.id=${pending.commandId}`;
			expect(row).toEqual({
				registration_key: run.registrationKey,
				revoke_state: "unknown",
				supply_state: "closed",
				consumer: "consumer-conflict",
				status: "unknown",
			});
			expect(await manual.listPending(32, ["execution-bob"])).toEqual([]);
		},
	);

	it("keeps revoke unknown when the command row lock outlasts the attempt", async () => {
		expect(await settlePrepared(await prepareDelivered())).toBe("registered");
		const run = await prepareDelivered("bob", "bob", "worker-b");
		expect(await settlePrepared(run, { consumerId: "consumer-conflict" })).toBe(
			"unknown",
		);
		const { item, attemptId, claimed } = await claimFirst(
			"revoke",
			"execution-bob",
			"worker-b",
		);
		const receipt = claimed?.installation.receipt;
		expect(receipt).toMatchObject({ consumerId: "consumer-conflict" });
		const attempt = {
			commandId: item.commandId,
			attemptId,
			attemptOwner: "worker-b",
			authorizationId: run.authorizationId,
		};
		expect(
			await manual.commitDelivery({
				...attempt,
				command: "revoke",
				deliveryDigest: "8".repeat(64),
			}),
		).toBe(true);
		await client`update platform.connection_installation_commands
			set attempt_expires_at=clock_timestamp()+interval '1 second' where id=${attempt.commandId}`;
		let settlement: ReturnType<typeof manual.settleRevoke> | undefined;
		await client.begin(async (tx) => {
			const [lock] =
				await tx`select pg_backend_pid() as pid from platform.connection_installation_commands
				where id=${attempt.commandId} for update`;
			settlement = manual.settleRevoke({
				...attempt,
				response: {
					schemaVersion: 1,
					commandId: attempt.commandId,
					outcome: "revoked",
				},
			});
			void settlement.catch(() => undefined);
			await vi.waitFor(
				async () => {
					const waiting =
						await client`select pid from pg_stat_activity where ${lock?.pid}=any(pg_blocking_pids(pid))`;
					expect(waiting).toHaveLength(1);
				},
				{ timeout: 3000, interval: 20 },
			);
			const [live] =
				await client`select attempt_expires_at > clock_timestamp() as live
				from platform.connection_installation_commands where id=${attempt.commandId}`;
			expect(live?.live).toBe(true);
			await vi.waitFor(
				async () => {
					const [row] =
						await client`select attempt_expires_at <= clock_timestamp() as expired
					from platform.connection_installation_commands where id=${attempt.commandId}`;
					expect(row?.expired).toBe(true);
				},
				{ timeout: 3000, interval: 20 },
			);
		});
		await expect(settlement).resolves.toBe("unknown");
		const [row] =
			await client`select m.registration_key, m.revoke_state, m.supply_state, m.receipt, c.status
			from platform.connection_manual_installations m
			join platform.connection_installation_commands c on c.authorization_id=m.authorization_id
			where c.id=${attempt.commandId}`;
		expect(row).toEqual({
			registration_key: run.registrationKey,
			revoke_state: "unknown",
			supply_state: "closed",
			receipt,
			status: "unknown",
		});
		expect(await manual.listPending(32, ["execution-bob"])).toEqual([]);
	});

	it("persists the first begin mapping once and recovers a lost begin read-only", async () => {
		const run = await prepareDelivered();
		const receipt = receiptFor(run.template, run.registrationKey);
		await manual.settleRegistration({
			commandId: run.prepare.item.commandId,
			attemptId: run.prepare.attemptId,
			attemptOwner: "worker-a",
			command: "prepare",
			authorizationId: run.authorizationId,
			response: {
				schemaVersion: 1,
				outcome: "registered",
				commandId: run.prepare.item.commandId,
				receipt,
			},
		});
		const first = await claimFirst("begin");
		const context = await manual.firstBeginContext({
			commandId: first.item.commandId,
			attemptId: first.attemptId,
			attemptOwner: "worker-a",
			authorizationId: run.authorizationId,
			command: "begin",
		});
		expect(context?.receipt).toEqual(receipt);
		const configuration = context?.configuration as NonNullable<
			typeof context
		>["configuration"];
		// §13.5.6: the descriptor fixed with the configuration names this install's
		// receipt, configuration and supply, and the exception policy (first pin: none).
		const descriptor = context?.descriptor as NonNullable<
			typeof context
		>["descriptor"];
		expect(descriptor).toEqual({
			schemaVersion: 1,
			readbackContract: dynamic.readbackContract,
			registrationKey: run.registrationKey,
			consumerId: receipt.consumerId,
			clientId: receipt.clientId,
			instanceId: receipt.instanceId,
			configuration: {
				ref: configuration.ref,
				revision: configuration.revision,
				digest: connectionInstallConfigurationDigestV1(configuration),
			},
			principalMapping: {
				kind: "consistency-exception-v1",
				policy: dynamic.principalMapping.policy,
				pinnedPrincipalId: null,
			},
			publicationContract: dynamic.publicationContract,
			supply: run.template.supply,
		});
		expect(
			await manual.commitDelivery({
				commandId: first.item.commandId,
				attemptId: first.attemptId,
				attemptOwner: "worker-a",
				command: "begin",
				authorizationId: run.authorizationId,
				deliveryDigest: "4".repeat(64),
			}),
		).toBe(true);
		const beginReadback = {
			...run.commandReadback,
			command: {
				...run.commandReadback.command,
				commandId: first.item.commandId,
				attemptId: first.attemptId,
				command: "begin" as const,
				requestDigest: "4".repeat(64),
				configurationDigest:
					connectionInstallConfigurationDigestV1(configuration),
				receiptDigest: connectionRegistrationReceiptDigestV1(receipt),
				descriptorDigest: connectionManualInstallDescriptorDigestV1(descriptor),
			},
		};
		expect(await manual.readback(beginReadback)).toBe("allowed");
		for (const replaced of [
			{ configurationDigest: "5".repeat(64) },
			{ descriptorDigest: "5".repeat(64) },
			{ descriptorDigest: undefined },
		])
			expect(
				await manual.readback({
					...beginReadback,
					command: { ...beginReadback.command, ...replaced },
				}),
			).toBe("denied");
		// The begin response is lost: unknown, no link, no automatic resend.
		expect(
			await manual.settleBegin({
				commandId: first.item.commandId,
				attemptId: first.attemptId,
				attemptOwner: "worker-a",
				command: "begin",
				authorizationId: run.authorizationId,
			}),
		).toBe("unknown");
		expect(await manual.listPending(32, ["execution-a"])).toEqual([]);
		await use.executeInstallation({
			userId: "alice",
			identityRevision: "identity-r1",
			command: "status",
			authorizationId: run.authorizationId,
			requestId: "request",
			traceId: "trace",
		});
		const recovery = await claimFirst("begin_status");
		const recoveryContext = await manual.firstBeginContext({
			commandId: recovery.item.commandId,
			attemptId: recovery.attemptId,
			attemptOwner: "worker-a",
			authorizationId: run.authorizationId,
			command: "begin_status",
		});
		expect(recoveryContext?.beginCommandId).toBe(first.item.commandId);
		await manual.commitDelivery({
			commandId: recovery.item.commandId,
			attemptId: recovery.attemptId,
			attemptOwner: "worker-a",
			command: "begin_status",
			authorizationId: run.authorizationId,
			deliveryDigest: "6".repeat(64),
		});
		const state = "b".repeat(64);
		const url = new URL(configuration.authorizationEndpoint);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: configuration.clientId,
			redirect_uri: configuration.callbackUrl,
			state,
			scope: "mcp",
			resource: configuration.resource,
			code_challenge_method: "S256",
			code_challenge: "c".repeat(43),
		}).toString();
		expect(
			await manual.settleBegin({
				commandId: recovery.item.commandId,
				attemptId: recovery.attemptId,
				attemptOwner: "worker-a",
				command: "begin_status",
				authorizationId: run.authorizationId,
				result: {
					schemaVersion: 1,
					authorizationId: run.authorizationId,
					phase: "awaiting_callback",
					expiresAt: Date.now() + 60_000,
					authorizationUrl: url.toString(),
				},
			}),
		).toBe("mapped");
		const status = await use.executeInstallation({
			userId: "alice",
			identityRevision: "identity-r1",
			command: "status",
			authorizationId: run.authorizationId,
			requestId: "request",
			traceId: "trace",
		});
		expect(status).toMatchObject({ authorizationUrl: url.toString() });
		const [row] =
			await client`select binding->'callback'->>'stateHash' as hash, binding->'callback'->>'runtimeOrigin' as origin from platform.connection_installation_authorizations where id=${run.authorizationId}`;
		expect(row?.origin).toBe(run.template.target.runtimeOrigin);
		expect(row?.hash).toMatch(/^[a-f0-9]{64}$/);
		const callbackRequest = { stateHash: row?.hash as string, now: Date.now() };
		expect(await use.callback.claim(callbackRequest)).toMatchObject({
			authorizationId: run.authorizationId,
			runtimeOrigin: run.template.target.runtimeOrigin,
			issuer: "https://connection.test/",
		});
		expect(await use.callback.claim(callbackRequest)).toBeNull();
	});

	it("fixes no supply when the directory read outlasts authorization", async () => {
		const projection = await begin();
		const prepare = await claimFirst("prepare");
		const { template, registrationKey } = await templateFor(
			projection.authorizationId,
		);
		await client`update platform.connection_installation_authorizations
			set expires_at=clock_timestamp()+interval '1 second' where id=${projection.authorizationId}`;
		waitDuringRead(
			() => client`select expires_at <= clock_timestamp() as expired
				from platform.connection_installation_authorizations where id=${projection.authorizationId}`,
		);
		try {
			expect(
				await manual.fixSupply({
					commandId: prepare.item.commandId,
					attemptId: prepare.attemptId,
					attemptOwner: "worker-a",
					command: "prepare",
					template,
					registrationKey,
					supplyAttemptId: randomUUID(),
				}),
			).toBeNull();
		} finally {
			beforeResolveUser = undefined;
		}
		const [row] =
			await client`select template, supply_state from platform.connection_manual_installations where authorization_id=${projection.authorizationId}`;
		expect(row).toEqual({ template: null, supply_state: "pending" });
	});

	// PR-Agent "Partial state commit": an Owner unlink or replace after the claim
	// never leaves a fixed template sending without the ciphertext it fixed.
	it.each([
		["unlink", "before"],
		["unlink", "during"],
		["replace", "before"],
		["replace", "during"],
	] as const)(
		"leaves no half-fixed supply when the Owner %s lands %s fixSupply",
		async (operation, order) => {
			const projection = await begin();
			const prepare = await claimFirst("prepare");
			const { template, registrationKey } = await templateFor(
				projection.authorizationId,
			);
			const supplyAttemptId = randomUUID();
			const supply = () =>
				manual.fixSupply({
					commandId: prepare.item.commandId,
					attemptId: prepare.attemptId,
					attemptOwner: "worker-a",
					command: "prepare",
					template,
					registrationKey,
					supplyAttemptId,
				});
			const ownerWrite = () =>
				associations.execute<boolean | number | null>((tx) =>
					operation === "unlink"
						? tx.deleteManual("agent-a", 1)
						: tx.saveManual({
								agentId: "agent-a",
								ownerId: "owner",
								connectionAgentId: "connection-agent-new",
								credentialFingerprint: randomBytes(32).toString("hex"),
								expectedRevision: 1,
								encrypt: ({ agentId, ownerId, associationRevision }) => ({
									schemaVersion: 1,
									agentId,
									ownerId,
									secretVersion: associationRevision,
									crypto: { dekFingerprint: randomBytes(32).toString("hex") },
								}),
							}),
				);
			let fixed: Awaited<ReturnType<typeof supply>>;
			let owner: Awaited<ReturnType<typeof ownerWrite>>;
			if (order === "before") {
				owner = await ownerWrite();
				fixed = await supply();
			} else {
				// fixSupply holds the association share lock through its directory read.
				const reading = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				beforeResolveUser = async () => {
					beforeResolveUser = undefined;
					reading.resolve();
					await release.promise;
				};
				const supplying = supply();
				await reading.promise;
				const writing = ownerWrite();
				try {
					await vi.waitFor(
						async () => {
							const waiting = await client`select pid from pg_stat_activity
							where datname=current_database() and cardinality(pg_blocking_pids(pid))>0`;
							expect(waiting).toHaveLength(1);
						},
						{ timeout: 3000, interval: 20 },
					);
				} finally {
					beforeResolveUser = undefined;
					release.resolve();
				}
				[fixed, owner] = await Promise.all([supplying, writing]);
			}
			expect(owner).toBe(operation === "unlink" ? true : 2);
			const state = () => client`
				select a.status, m.template is not null as fixed, m.supply_attempt_id,
					m.supply_state, m.registration_state, c.status as command
				from platform.connection_manual_installations m
				join platform.connection_installation_authorizations a on a.id=m.authorization_id
				join platform.connection_installation_commands c on c.id=${prepare.item.commandId}
				where m.authorization_id=${projection.authorizationId}`;
			if (order === "before") {
				// Nothing was fixed: the Owner closed the unsupplied installation first.
				expect(fixed).toBeNull();
				expect(await state()).toEqual([
					{
						status: "revoked",
						fixed: false,
						supply_attempt_id: null,
						supply_state: "pending",
						registration_state: "closed",
						command: "pending",
					},
				]);
			} else {
				// The Owner waited for the fixed row and its ciphertext, then closed the supply.
				expect(fixed?.binding).toEqual({
					agentId: "agent-a",
					ownerId: "owner",
					associationRevision: 1,
				});
				expect(await state()).toEqual([
					{
						status: "revoked",
						fixed: true,
						supply_attempt_id: supplyAttemptId,
						supply_state: "closed",
						registration_state: "closed",
						command: "pending",
					},
				]);
			}
			// The expired attempt closes as unknown; nothing is left sending or pending.
			await client`update platform.connection_installation_commands
				set attempt_expires_at=clock_timestamp()-interval '1 second' where id=${prepare.item.commandId}`;
			expect(await manual.listPending(32, ["execution-a"])).toEqual([]);
			const [closed] = await state();
			expect(closed).toMatchObject({
				status: "revoked",
				supply_state: order === "before" ? "pending" : "closed",
				registration_state: "closed",
				command: "unknown",
			});
		},
	);

	it("keeps the original supply unknown when the original claim is re-claimed during Host supply", async () => {
		const run = await fixSupply();
		await reclaim();
		expect(
			await manual.settleSupply({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
				supplyAttemptId: run.supplyAttemptId,
				outcome: "confirmed",
			}),
		).toBe(false);
		const [row] =
			await client`select m.supply_state, m.registration_key, c.status
			from platform.connection_manual_installations m join platform.connection_installation_commands c
			on c.authorization_id=m.authorization_id where c.id=${run.prepare.item.commandId}`;
		expect(row).toEqual({
			supply_state: "unknown",
			registration_key: run.registrationKey,
			status: "unknown",
		});
	});

	it("commits no delivery once the original claim lease expires", async () => {
		const run = await fixSupply();
		expect(
			await manual.settleSupply({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
				supplyAttemptId: run.supplyAttemptId,
				outcome: "confirmed",
			}),
		).toBe(true);
		await client`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second' where id='item-a'`;
		expect(
			await manual.commitDelivery({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
				deliveryDigest: "9".repeat(64),
			}),
		).toBe(false);
		const [row] = await client`select m.registration_state, c.delivery_digest
			from platform.connection_manual_installations m join platform.connection_installation_commands c
			on c.authorization_id=m.authorization_id where c.id=${run.prepare.item.commandId}`;
		expect(row).toEqual({
			registration_state: "pending",
			delivery_digest: null,
		});
	});

	it("keeps a receipt unknown when the original claim expires during settlement beside another live outbox", async () => {
		const run = await prepareDelivered();
		const receipt = receiptFor(run.template, run.registrationKey);
		await expireClaimDuringRead();
		let outcome: Awaited<ReturnType<typeof manual.settleRegistration>>;
		try {
			outcome = await manual.settleRegistration({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId: run.authorizationId,
				response: {
					schemaVersion: 1,
					outcome: "registered",
					commandId: run.prepare.item.commandId,
					receipt,
				},
			});
		} finally {
			beforeResolveUser = undefined;
		}
		expect(outcome).toBe("unknown");
		const [row] =
			await client`select m.registration_state, m.consumer_id, m.configuration, m.registration_key,
			m.receipt->>'clientId' as client, c.status
			from platform.connection_manual_installations m
			join platform.connection_installation_commands c on c.authorization_id=m.authorization_id
			where c.id=${run.prepare.item.commandId}`;
		expect(row).toEqual({
			registration_state: "unknown",
			consumer_id: null,
			configuration: null,
			registration_key: run.registrationKey,
			client: receipt.clientId,
			status: "unknown",
		});
		expect(await manual.listPending(32, ["execution-a"])).toEqual([]);
	});

	it("opens no compensation when the original claim expires during a conflicting settlement", async () => {
		expect(await settlePrepared(await prepareDelivered())).toBe("registered");
		const run = await prepareDelivered("bob", "bob", "worker-b");
		await expireClaimDuringRead("bob", "worker-b");
		let outcome: Awaited<ReturnType<typeof manual.settleRegistration>>;
		try {
			outcome = await settlePrepared(run, { consumerId: "consumer-conflict" });
		} finally {
			beforeResolveUser = undefined;
		}
		expect(outcome).toBe("unknown");
		const [row] =
			await client`select a.status, m.registration_state, m.revoke_state, m.registration_key,
			m.receipt->>'consumerId' as consumer, c.status as command
			from platform.connection_manual_installations m
			join platform.connection_installation_authorizations a on a.id=m.authorization_id
			join platform.connection_installation_commands c on c.authorization_id=m.authorization_id
			where c.id=${run.prepare.item.commandId}`;
		expect(row).toEqual({
			status: "preparing",
			registration_state: "unknown",
			revoke_state: "not_required",
			registration_key: run.registrationKey,
			consumer: "consumer-conflict",
			command: "unknown",
		});
		expect(await manual.listPending(32, ["execution-bob"])).toEqual([]);
	});

	it("reopens no prepare when the original claim expires during supply recovery", async () => {
		const run = await fixSupply();
		const { authorizationId, supplyAttemptId } = run;
		expect(
			await manual.settleSupply({
				commandId: run.prepare.item.commandId,
				attemptId: run.prepare.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				authorizationId,
				supplyAttemptId,
				outcome: "unknown",
			}),
		).toBe(true);
		await use.executeInstallation({
			userId: "alice",
			identityRevision: "identity-r1",
			command: "status",
			authorizationId,
			requestId: "request",
			traceId: "trace",
		});
		const recovery = await claimFirst("status");
		const attempt = {
			commandId: recovery.item.commandId,
			attemptId: recovery.attemptId,
			attemptOwner: "worker-a",
			authorizationId,
		};
		expect(
			await manual.commitDelivery({
				...attempt,
				command: "status",
				deliveryDigest: "5".repeat(64),
			}),
		).toBe(true);
		await expireClaimDuringRead();
		try {
			await manual.recoverSupply({
				...attempt,
				supplyAttemptId,
				confirmed: true,
			});
		} finally {
			beforeResolveUser = undefined;
		}
		const [row] =
			await client`select m.supply_state, m.registration_key, p.status as prepare, s.status as status
			from platform.connection_manual_installations m
			join platform.connection_installation_commands p on p.authorization_id=m.authorization_id
			join platform.connection_installation_commands s on s.authorization_id=m.authorization_id
			where p.id=${run.prepare.item.commandId} and s.id=${attempt.commandId}`;
		expect(row).toEqual({
			supply_state: "unknown",
			registration_key: run.registrationKey,
			prepare: "unknown",
			status: "unknown",
		});
	});

	it("keeps begin_status unmapped when the authorization readback outlasts the attempt", async () => {
		const { run, attempt, beginCommandId, result } =
			await beginStatusDelivered();
		await client`update platform.connection_installation_commands
			set attempt_expires_at=clock_timestamp()+interval '1 second' where id=${attempt.commandId}`;
		waitDuringRead(
			() => client`select attempt_expires_at <= clock_timestamp() as expired
				from platform.connection_installation_commands where id=${attempt.commandId}`,
		);
		let outcome: Awaited<ReturnType<typeof manual.settleBegin>>;
		try {
			outcome = await manual.settleBegin({ ...attempt, result });
		} finally {
			beforeResolveUser = undefined;
		}
		expect(outcome).toBe("unknown");
		const [row] =
			await client`select m.registration_key, a.binding->'callback' as callback, a.binding->>'authorizationUrl' as url,
			(select status from platform.connection_installation_commands where id=${attempt.commandId}) as recovery,
			(select status from platform.connection_installation_commands where id=${beginCommandId}) as original
			from platform.connection_manual_installations m
			join platform.connection_installation_authorizations a on a.id=m.authorization_id
			where a.id=${run.authorizationId}`;
		expect(row).toEqual({
			registration_key: run.registrationKey,
			callback: null,
			url: null,
			recovery: "unknown",
			original: "unknown",
		});
	});

	it("keeps begin_status unmapped when the original claim expires beside another live outbox", async () => {
		const { run, attempt, beginCommandId, result } =
			await beginStatusDelivered();
		await expireClaimDuringRead();
		let outcome: Awaited<ReturnType<typeof manual.settleBegin>>;
		try {
			outcome = await manual.settleBegin({ ...attempt, result });
		} finally {
			beforeResolveUser = undefined;
		}
		expect(outcome).toBe("unknown");
		const [row] =
			await client`select a.binding->'callback' as callback, a.binding->>'authorizationUrl' as url,
			(select status from platform.connection_installation_commands where id=${beginCommandId}) as original
			from platform.connection_installation_authorizations a where a.id=${run.authorizationId}`;
		expect(row).toEqual({ callback: null, url: null, original: "unknown" });
	});

	it("keeps revoke unknown with its original key when the original claim is re-claimed", async () => {
		expect(await settlePrepared(await prepareDelivered())).toBe("registered");
		const run = await prepareDelivered("bob", "bob", "worker-b");
		expect(await settlePrepared(run, { consumerId: "consumer-conflict" })).toBe(
			"unknown",
		);
		const { item, attemptId, claimed } = await claimFirst(
			"revoke",
			"execution-bob",
			"worker-b",
		);
		const receipt = claimed?.installation.receipt;
		expect(receipt).toMatchObject({ consumerId: "consumer-conflict" });
		const attempt = {
			commandId: item.commandId,
			attemptId,
			attemptOwner: "worker-b",
			authorizationId: run.authorizationId,
		};
		expect(
			await manual.commitDelivery({
				...attempt,
				command: "revoke",
				deliveryDigest: "8".repeat(64),
			}),
		).toBe(true);
		await reclaim("bob");
		expect(
			await manual.settleRevoke({
				...attempt,
				response: {
					schemaVersion: 1,
					commandId: attempt.commandId,
					outcome: "revoked",
				},
			}),
		).toBe("unknown");
		const [row] =
			await client`select m.registration_key, m.revoke_state, m.supply_state, m.receipt, c.status
			from platform.connection_manual_installations m
			join platform.connection_installation_commands c on c.authorization_id=m.authorization_id
			where c.id=${attempt.commandId}`;
		expect(row).toEqual({
			registration_key: run.registrationKey,
			revoke_state: "unknown",
			supply_state: "closed",
			receipt,
			status: "unknown",
		});
	});

	it("keeps a compensation revoke unknown when its original claim is lost before the claim", async () => {
		expect(await settlePrepared(await prepareDelivered())).toBe("registered");
		const run = await prepareDelivered("bob", "bob", "worker-b");
		expect(await settlePrepared(run, { consumerId: "consumer-conflict" })).toBe(
			"unknown",
		);
		await client`update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second' where id='item-bob'`;
		const pending = (await manual.listPending(32, ["execution-bob"])).find(
			(entry) => entry.command === "revoke",
		);
		if (!pending) throw new Error("missing pending compensation");
		expect(
			await manual.claim({
				commandId: pending.commandId,
				attemptId: randomUUID(),
				attemptOwner: "worker-b",
			}),
		).toBeNull();
		const [row] =
			await client`select m.registration_key, m.revoke_state, m.receipt->>'consumerId' as consumer, c.status
			from platform.connection_manual_installations m
			join platform.connection_installation_commands c on c.authorization_id=m.authorization_id
			where c.id=${pending.commandId}`;
		expect(row).toEqual({
			registration_key: run.registrationKey,
			revoke_state: "unknown",
			consumer: "consumer-conflict",
			status: "unknown",
		});
		expect(await manual.listPending(32, ["execution-bob"])).toEqual([]);
	});

	it("claims and settles a manual callback on the database clock", async () => {
		const { run, stateHash } = await mapFirstBegin();
		const claimed = await use.callback.claim({ stateHash, now: Date.now() });
		expect(claimed).toMatchObject({
			authorizationId: run.authorizationId,
			runtimeOrigin: run.template.target.runtimeOrigin,
		});
		expect(await callbackStatus(run.authorizationId)).toBe("sending");
		expect(
			await use.callback.settle({
				stateHash,
				attemptId: claimed?.attemptId as string,
				now: Date.now(),
				status: "delivered",
			}),
		).toBe(true);
		expect(await callbackStatus(run.authorizationId)).toBe("delivered");
	});

	it("keeps a manual callback closed when the directory read outlasts authorization", async () => {
		const { run, stateHash } = await mapFirstBegin();
		await client`update platform.connection_installation_authorizations
			set expires_at=clock_timestamp()+interval '1 second' where id=${run.authorizationId}`;
		waitDuringRead(
			() => client`select expires_at <= clock_timestamp() as expired
				from platform.connection_installation_authorizations where id=${run.authorizationId}`,
		);
		try {
			expect(
				await use.callback.claim({ stateHash, now: Date.now() }),
			).toBeNull();
		} finally {
			beforeResolveUser = undefined;
		}
		expect(await callbackStatus(run.authorizationId)).toBe("pending");
	});

	it("settles a manual callback unknown when the row lock outlasts the attempt", async () => {
		const { run, stateHash } = await mapFirstBegin();
		const claimed = await use.callback.claim({ stateHash, now: Date.now() });
		if (!claimed) throw new Error("missing callback claim");
		await client`update platform.connection_installation_authorizations
			set binding=jsonb_set(binding, '{callback,attemptExpiresAt}',
				to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint + 1000))
			where id=${run.authorizationId}`;
		let settlement: Promise<boolean> | undefined;
		await client.begin(async (tx) => {
			const [lock] =
				await tx`select pg_backend_pid() as pid from platform.connection_installation_authorizations
				where id=${run.authorizationId} for update`;
			settlement = use.callback.settle({
				stateHash,
				attemptId: claimed.attemptId,
				now: Date.now(),
				status: "delivered",
			});
			void settlement.catch(() => undefined);
			await vi.waitFor(
				async () => {
					const waiting =
						await client`select pid from pg_stat_activity where ${lock?.pid}=any(pg_blocking_pids(pid))`;
					expect(waiting).toHaveLength(1);
				},
				{ timeout: 3000, interval: 20 },
			);
			await vi.waitFor(
				async () => {
					const [row] =
						await client`select (binding->'callback'->>'attemptExpiresAt')::bigint
							<= (extract(epoch from clock_timestamp()) * 1000)::bigint as expired
						from platform.connection_installation_authorizations where id=${run.authorizationId}`;
					expect(row?.expired).toBe(true);
				},
				{ timeout: 3000, interval: 20 },
			);
		});
		await expect(settlement).resolves.toBe(false);
		expect(await callbackStatus(run.authorizationId)).toBe("unknown");
	});

	// PR-Agent 93a436f78b2e: the readback permit is decided after the directory
	// read, at the database clock, against the original claim only.
	it.each([
		["supply_delivery", "authorization"],
		["supply", "authorization"],
		["command", "authorization"],
		["supply_delivery", "claim"],
		["supply", "claim"],
		["command", "claim"],
	] as const)(
		"permits no %s readback when the directory read outlasts the %s",
		async (purpose, expiry) => {
			const run =
				purpose === "command" ? await prepareDelivered() : await fixSupply();
			const request =
				purpose === "command"
					? (run as Awaited<ReturnType<typeof prepareDelivered>>)
							.commandReadback
					: { ...run.readbackBase, purpose };
			expect(await manual.readback(request)).toBe("allowed");
			if (expiry === "authorization") {
				await client`update platform.connection_installation_authorizations
				set expires_at=clock_timestamp()+interval '1 second' where id=${run.authorizationId}`;
				waitDuringRead(
					() => client`select expires_at <= clock_timestamp() as expired
					from platform.connection_installation_authorizations where id=${run.authorizationId}`,
				);
			} else {
				// Another live outbox of the same Worker and Execution never stands in.
				await expireClaimDuringRead();
			}
			try {
				expect(await manual.readback(request)).toBe("denied");
			} finally {
				beforeResolveUser = undefined;
			}
		},
	);

	// PR-Agent 435324e3306b: the original begin stays idempotent after its receipt CAS.
	it("replays the same begin after the receipt CAS as the original installation", async () => {
		const key = randomUUID();
		const run = await prepareDelivered("alice", "a", "worker-a", key);
		expect(await settlePrepared(run)).toBe("registered");
		const replay = await begin("alice", "a", key);
		expect(replay).toEqual({
			schemaVersion: 1,
			manual: true,
			authorizationId: run.authorizationId,
			status: "awaiting_confirmation",
			expiresAt: expect.any(Number),
		});
		// The replay is a readback: no second prepare, registration or installation.
		const installations =
			await client`select authorization_id from platform.connection_manual_installations`;
		expect(installations).toEqual([{ authorization_id: run.authorizationId }]);
		const commands =
			await client`select command, status from platform.connection_installation_commands
			where authorization_id=${run.authorizationId} order by created_at, command`;
		expect(commands).toEqual([
			{ command: "prepare", status: "completed" },
			{ command: "begin", status: "pending" },
		]);
		// A different request under the same key still conflicts.
		await expect(begin("alice", "b", key)).rejects.toMatchObject({
			code: "conflict",
		});
	});

	// PR-Agent 46d2b1c86bf3: a prepare claimed but never fixed sent nothing and
	// reopens for the same installation instead of staying unknown forever.
	it("reopens a prepare whose attempt expired before fixSupply and finishes the same installation", async () => {
		const projection = await begin();
		const first = await claimFirst("prepare");
		expect(first.claimed?.command.command).toBe("prepare");
		await client`update platform.connection_installation_commands
			set attempt_expires_at=clock_timestamp()-interval '1 second' where id=${first.item.commandId}`;
		expect(await manual.listPending(32, ["execution-a"])).toEqual([
			{
				commandId: first.item.commandId,
				command: "prepare",
				authorizationId: projection.authorizationId,
				executionId: "execution-a",
			},
		]);
		// The expired attempt can no longer fix a template or obtain ciphertext.
		const stale = await templateFor(projection.authorizationId);
		expect(
			await manual.fixSupply({
				commandId: first.item.commandId,
				attemptId: first.attemptId,
				attemptOwner: "worker-a",
				command: "prepare",
				template: stale.template,
				registrationKey: stale.registrationKey,
				supplyAttemptId: randomUUID(),
			}),
		).toBeNull();
		const attemptId = randomUUID();
		const claimed = await manual.claim({
			commandId: first.item.commandId,
			attemptId,
			attemptOwner: "worker-a",
		});
		expect(claimed?.authorization.authorizationId).toBe(
			projection.authorizationId,
		);
		const { template, registrationKey } = await templateFor(
			projection.authorizationId,
		);
		const supplyAttemptId = randomUUID();
		const attempt = {
			commandId: first.item.commandId,
			attemptId,
			attemptOwner: "worker-a",
		};
		expect(
			await manual.fixSupply({
				...attempt,
				command: "prepare",
				template,
				registrationKey,
				supplyAttemptId,
			}),
		).not.toBeNull();
		expect(
			await manual.settleSupply({
				...attempt,
				command: "prepare",
				authorizationId: projection.authorizationId,
				supplyAttemptId,
				outcome: "confirmed",
			}),
		).toBe(true);
		expect(
			await manual.commitDelivery({
				...attempt,
				command: "prepare",
				authorizationId: projection.authorizationId,
				deliveryDigest: connectionInstallCommandDigestV1({
					schemaVersion: 1,
					command: "prepare",
					...attempt,
					template,
					supplyAttemptId,
					registrationKey,
				}),
			}),
		).toBe(true);
		expect(
			await manual.settleRegistration({
				...attempt,
				command: "prepare",
				authorizationId: projection.authorizationId,
				response: {
					schemaVersion: 1,
					outcome: "registered",
					commandId: first.item.commandId,
					receipt: receiptFor(template, registrationKey),
				},
			}),
		).toBe("registered");
		const prepares =
			await client`select id from platform.connection_installation_commands
			where authorization_id=${projection.authorizationId} and command='prepare'`;
		expect(prepares).toEqual([{ id: first.item.commandId }]);
	});

	it("keeps a prepare unknown when its attempt expired after fixSupply", async () => {
		const run = await fixSupply();
		await client`update platform.connection_installation_commands
			set attempt_expires_at=clock_timestamp()-interval '1 second' where id=${run.prepare.item.commandId}`;
		expect(await manual.listPending(32, ["execution-a"])).toEqual([]);
		const [row] =
			await client`select m.supply_state, m.registration_key, c.status, c.attempt_id
			from platform.connection_manual_installations m join platform.connection_installation_commands c
			on c.authorization_id=m.authorization_id where c.id=${run.prepare.item.commandId}`;
		expect(row).toEqual({
			supply_state: "unknown",
			registration_key: run.registrationKey,
			status: "unknown",
			attempt_id: run.prepare.attemptId,
		});
	});

	// Files K8413-4206-0500: recovery is not truncated by one sweep page, and it
	// spans Executions. Every unsupplied prepare keeps its original command.
	it("recovers every unsupplied prepare across Executions after more than one page expires", async () => {
		const originals: { commandId: string; executionId: string }[] = [];
		for (const [user, suffix, worker, count] of [
			["alice", "a", "worker-a", 33],
			["bob", "bob", "worker-b", 2],
		] as const)
			for (let index = 0; index < count; index += 1) {
				const projection = await begin(user, suffix);
				const [command] =
					await client`select id from platform.connection_installation_commands
					where authorization_id=${projection.authorizationId} and command='prepare'`;
				const commandId = command?.id as string;
				expect(
					await manual.claim({
						commandId,
						attemptId: randomUUID(),
						attemptOwner: worker,
					}),
				).not.toBeNull();
				originals.push({ commandId, executionId: `execution-${suffix}` });
			}
		// Every Worker exits before fixSupply.
		await client`update platform.connection_installation_commands
			set attempt_expires_at=clock_timestamp()-interval '1 second' where command='prepare'`;
		// Bounded recovery passes continue until every expired candidate is handled.
		for (
			let pass = 0;
			pass < 40 && (await unsuppliedStates()).waiting > 0;
			pass += 1
		)
			await manual.listPending(1, ["execution-a"]);
		const first = await manual.listPending(32, ["execution-a"]);
		expect(first).toHaveLength(32);
		for (const item of first)
			expect(
				await manual.claim({
					commandId: item.commandId,
					attemptId: randomUUID(),
					attemptOwner: "worker-a",
				}),
			).not.toBeNull();
		const next = await manual.listPending(32, ["execution-a"]);
		expect(next).toHaveLength(1);
		const bob = await manual.listPending(32, ["execution-bob"]);
		expect(bob).toHaveLength(2);
		expect(
			[...first, ...next, ...bob].map((item) => item.commandId).sort(),
		).toEqual(originals.map((item) => item.commandId).sort());
		expect(
			await client`select count(*)::int as n from platform.connection_installation_commands
				where command='prepare' and status='unknown'`,
		).toEqual([{ n: 0 }]);
	}, 60_000);

	it("closes an unsupplied expired prepare whose authorization expired as unknown", async () => {
		const projection = await begin();
		const first = await claimFirst("prepare");
		await client`update platform.connection_installation_commands
			set attempt_expires_at=clock_timestamp()-interval '1 second' where id=${first.item.commandId}`;
		await client`update platform.connection_installation_authorizations
			set expires_at=clock_timestamp()-interval '1 second' where id=${projection.authorizationId}`;
		expect(await manual.listPending(32, ["execution-a"])).toEqual([]);
		const [row] =
			await client`select status, attempt_id from platform.connection_installation_commands
			where id=${first.item.commandId}`;
		expect(row).toEqual({ status: "unknown", attempt_id: first.attemptId });
	});

	/** Claims `count` prepares on execution-a and lets every attempt expire before fixSupply. */
	async function expiredUnsuppliedBacklog(count: number) {
		const commandIds: string[] = [];
		for (let index = 0; index < count; index += 1) {
			const projection = await begin();
			const [command] =
				await client`select id from platform.connection_installation_commands
				where authorization_id=${projection.authorizationId} and command='prepare'`;
			const commandId = command?.id as string;
			expect(
				await manual.claim({
					commandId,
					attemptId: randomUUID(),
					attemptOwner: "worker-a",
				}),
			).not.toBeNull();
			commandIds.push(commandId);
		}
		await client`update platform.connection_installation_commands
			set attempt_expires_at=clock_timestamp()-interval '1 second' where command='prepare'`;
		return commandIds;
	}

	async function unsuppliedStates() {
		const [row] = await client`select
			count(*) filter (where status='pending' and attempt_id is not null)::int as waiting,
			count(*) filter (where status='pending' and attempt_id is null)::int as reopened,
			count(*) filter (where status='unknown')::int as unknown
			from platform.connection_installation_commands where command='prepare'`;
		return row as { waiting: number; reopened: number; unknown: number };
	}

	// Files K8413-4206-0620 (r4639978171): one recovery pass has a bounded amount
	// of work and yields; the backlog keeps its eligibility for later passes.
	it("bounds one unsupplied recovery pass and finishes the backlog in later passes", async () => {
		const commandIds = await expiredUnsuppliedBacklog(70);
		// The pass returns with the backlog only partly handled; listing still answers.
		expect(await manual.listPending(1, ["execution-a"])).toHaveLength(1);
		const first = await unsuppliedStates();
		expect(first.waiting).toBeGreaterThan(0);
		expect(first.reopened).toBeGreaterThan(0);
		expect(first.unknown).toBe(0);
		let passes = 1;
		while ((await unsuppliedStates()).waiting > 0 && passes < 40) {
			await manual.listPending(1, ["execution-a"]);
			passes += 1;
		}
		expect(passes).toBeGreaterThan(1);
		expect(await unsuppliedStates()).toEqual({
			waiting: 0,
			reopened: 70,
			unknown: 0,
		});
		const reopened =
			await client`select id from platform.connection_installation_commands
			where command='prepare' and status='pending' and attempt_id is null`;
		expect(reopened.map((row) => row.id as string).sort()).toEqual(
			commandIds.sort(),
		);
	}, 120_000);

	it("yields a recovery pass on an aborted signal and keeps every candidate eligible", async () => {
		const commandIds = await expiredUnsuppliedBacklog(3);
		expect(
			await manual.listPending(32, ["execution-a"], AbortSignal.abort()),
		).toEqual([]);
		expect(await unsuppliedStates()).toEqual({
			waiting: 3,
			reopened: 0,
			unknown: 0,
		});
		const pending = await manual.listPending(32, ["execution-a"]);
		expect(pending.map((item) => item.commandId).sort()).toEqual(
			commandIds.sort(),
		);
	});

	// §13.5.6 dynamic manual confirm and the exception's pre-exchange first pin.
	it("confirms once after the consumed callback and pins before any exchange", async () => {
		const { run, stateHash } = await mapFirstBegin();
		const confirm = (key = randomUUID()) =>
			use.executeInstallation({
				userId: "alice",
				identityRevision: "identity-r1",
				command: "confirm",
				authorizationId: run.authorizationId,
				idempotencyKey: key,
				requestId: "request",
				traceId: "trace",
			});
		// The callback of the first begin is not consumed yet.
		await expect(confirm()).rejects.toMatchObject({ code: "conflict" });
		const claimed = await use.callback.claim({ stateHash, now: Date.now() });
		expect(
			await use.callback.settle({
				stateHash,
				attemptId: claimed?.attemptId as string,
				now: Date.now(),
				status: "delivered",
			}),
		).toBe(true);
		// Another user never confirms it.
		await expect(
			use.executeInstallation({
				userId: "bob",
				identityRevision: "identity-r1",
				command: "confirm",
				authorizationId: run.authorizationId,
				idempotencyKey: randomUUID(),
				requestId: "request",
				traceId: "trace",
			}),
		).rejects.toMatchObject({ code: "denied" });
		const key = randomUUID();
		expect(await confirm(key)).toMatchObject({ status: "confirmed" });
		// The same request replays; another explicit confirm saves nothing new.
		expect(await confirm(key)).toMatchObject({ status: "confirmed" });
		await expect(confirm()).rejects.toMatchObject({ code: "conflict" });
		const flow = { run, key, user: "alice", suffix: "a", worker: "worker-a" };
		expect((await pinFacts(run.authorizationId))?.confirm).toBe(
			"confirm:pending",
		);
		const phase = await bindingReadback(flow);
		const attempt = {
			confirmCommandId: phase.confirmCommandId,
			attemptId: phase.attemptId,
			attemptOwner: phase.attemptOwner,
			authorizationId: run.authorizationId,
		};
		// No exchange before this confirm's first-pin receipt committed; no second phase 1.
		for (const next of [
			"confirm_exchange",
			"confirm_binding_readback",
		] as const)
			expect(
				await manual.openConfirmPhase({ ...attempt, phase: next }),
			).toBeNull();
		const pinned = await manual.commitConfirmPin({
			...attempt,
			phaseCommandId: phase.phaseCommandId,
			candidate: await candidateFor(flow, phase),
		});
		expect(pinned).toMatchObject({
			outcome: "pinned",
			receipt: { revision: 1 },
		});
		expect(await pinFacts(run.authorizationId)).toEqual({
			pins: 1,
			receipts: 1,
			status: "confirmed",
			revoke_state: "not_required",
			confirm: "confirm:sending,confirm_binding_readback:completed",
		});
		const [pin] =
			await client`select issuer, principal_id, user_id, policy_ref, policy_revision from platform.connection_principal_pins`;
		expect(pin).toEqual({
			issuer: system.issuer,
			principal_id: "principal-a",
			user_id: "alice",
			policy_ref: dynamic.principalMapping.policy.ref,
			policy_revision: dynamic.principalMapping.policy.revision,
		});
		// A replayed candidate commits nothing more.
		expect(
			await manual.commitConfirmPin({
				...attempt,
				phaseCommandId: phase.phaseCommandId,
				candidate: await candidateFor(flow, phase),
			}),
		).toEqual({ outcome: "stale" });
		const exchange = await manual.openConfirmPhase({
			...attempt,
			phase: "confirm_exchange",
		});
		expect(exchange?.receipt).toEqual(
			pinned.outcome === "pinned" ? pinned.receipt : undefined,
		);
		expect(
			await manual.openConfirmPhase({ ...attempt, phase: "confirm_exchange" }),
		).toBeNull();
	});

	it.each([
		["another client", { clientId: "client-other" }],
		["another DEVICE instance", { instanceId: "instance-other" }],
		[
			"another registration key",
			{ registrationKey: "mi-other-registration-key" },
		],
		["another issuer", { issuer: "https://other.test/" }],
	] as const)(
		"refuses a candidate naming %s, revokes the original key and pins nothing",
		async (_name, verified) => {
			const flow = await confirmed();
			const phase = await bindingReadback(flow);
			const candidate = await candidateFor(flow, phase);
			expect(
				await manual.commitConfirmPin({
					...phase,
					candidate: {
						...candidate,
						verified: { ...candidate.verified, ...verified },
					},
				}),
			).toEqual({ outcome: "rejected" });
			expect(await pinFacts(flow.run.authorizationId)).toEqual({
				pins: 0,
				receipts: 0,
				status: "revoked",
				revoke_state: "pending",
				confirm: "confirm:rejected,confirm_binding_readback:rejected",
			});
			expect(
				await manual.openConfirmPhase({ ...phase, phase: "confirm_exchange" }),
			).toBeNull();
		},
	);

	it.each([
		[
			"another user's Execution",
			{ reference: { executionId: "execution-bob" } },
		],
		[
			"another installation revision",
			{ confirmationRevision: "confirmation-other" },
		],
		["another association revision", { association: { revision: 2 } }],
		["another Pod", { target: { podUid: "pod-other" } }],
		["an older fence", { target: { resourceFence: 99 } }],
		["another phase request", { confirm: { requestDigest: "7".repeat(64) } }],
	] as const)("refuses a candidate bound to %s", async (_name, change) => {
		const flow = await confirmed();
		const phase = await bindingReadback(flow);
		const candidate = await candidateFor(flow, phase);
		const replaced = Object.fromEntries(
			Object.entries(change).map(([key, value]) => [
				key,
				{
					...(candidate as unknown as Record<string, object>)[key],
					...value,
				},
			]),
		);
		expect(
			await manual.commitConfirmPin({
				...phase,
				candidate: { ...candidate, ...replaced } as never,
			}),
		).toEqual({ outcome: "rejected" });
		expect((await pinFacts(flow.run.authorizationId))?.pins).toBe(0);
	});

	it.each([
		[
			"another Principal for a user pinned through another Agent",
			"principal-a",
		],
		["a Principal pinned by another user", "principal-b"],
	])("refuses %s and keeps the existing pins", async (_name, principalId) => {
		// Both pins are live: inside their verification window (§13.5.1 item 4).
		await client`insert into platform.connection_principal_pins(id, issuer, principal_id, user_id, policy_ref, policy_revision, verification_deadline)
			values ('pin-alice-agent-b', ${system.issuer}, 'principal-x', 'alice', 'consistency-exception-v1', 'r1', clock_timestamp() + interval '1 day'),
				('pin-bob', ${system.issuer}, 'principal-b', 'bob', 'consistency-exception-v1', 'r1', clock_timestamp() + interval '1 day')`;
		const flow = await confirmed();
		const phase = await bindingReadback(flow);
		expect(
			await manual.commitConfirmPin({
				...phase,
				candidate: await candidateFor(flow, phase, principalId),
			}),
		).toEqual({ outcome: "rejected" });
		const pins =
			await client`select principal_id, user_id from platform.connection_principal_pins where released_at is null order by id`;
		expect(pins).toEqual([
			{ principal_id: "principal-x", user_id: "alice" },
			{ principal_id: "principal-b", user_id: "bob" },
		]);
		expect((await pinFacts(flow.run.authorizationId))?.receipts).toBe(0);
	});

	it("reuses the user's pin, keeps its first pin time and commits a receipt per confirm", async () => {
		const first = await confirmed();
		const firstPhase = await bindingReadback(first);
		expect(
			(
				await manual.commitConfirmPin({
					...firstPhase,
					candidate: await candidateFor(first, firstPhase),
				})
			).outcome,
		).toBe("pinned");
		const [before] =
			await client`select id, pinned_at from platform.connection_principal_pins`;
		// The first installation ends; alice installs again with the same Principal.
		await client`update platform.connection_installation_commands set status='completed' where authorization_id=${first.run.authorizationId}`;
		await client`update platform.connection_installation_authorizations set status='revoked' where id=${first.run.authorizationId}`;
		const second = await confirmed();
		const secondPhase = await bindingReadback(second);
		expect(
			(
				await manual.commitConfirmPin({
					...secondPhase,
					candidate: await candidateFor(second, secondPhase),
				})
			).outcome,
		).toBe("pinned");
		const pins =
			await client`select id, pinned_at from platform.connection_principal_pins`;
		expect(pins).toEqual([before]);
		const receipts =
			await client`select authorization_id, pin_id from platform.connection_principal_pin_receipts order by created_at`;
		expect(receipts).toEqual([
			{ authorization_id: first.run.authorizationId, pin_id: before?.id },
			{ authorization_id: second.run.authorizationId, pin_id: before?.id },
		]);
	});

	it("refuses a new first pin at the exception's capacity", async () => {
		await client`insert into platform.connection_principal_pins(id, issuer, principal_id, user_id, policy_ref, policy_revision)
			values ('pin-1', ${system.issuer}, 'principal-1', 'carol', 'consistency-exception-v1', 'r1'),
				('pin-2', ${system.issuer}, 'principal-2', 'dave', 'consistency-exception-v1', 'r1')`;
		const flow = await confirmed();
		const phase = await bindingReadback(flow);
		expect(
			await manual.commitConfirmPin({
				...phase,
				candidate: await candidateFor(flow, phase),
			}),
		).toEqual({ outcome: "rejected" });
		expect((await pinFacts(flow.run.authorizationId))?.pins).toBe(2);
	});

	// #4300 review M1: two users' concurrent first pins are serialized on the
	// issuer's capacity, so the exception never exceeds maximumPinnedPrincipals.
	it("admits only one of two users' concurrent first pins at the last free slot", async () => {
		await client`insert into platform.connection_principal_pins(id, issuer, principal_id, user_id, policy_ref, policy_revision)
			values ('pin-1', ${system.issuer}, 'principal-1', 'carol', 'consistency-exception-v1', 'r1')`;
		const alice = await confirmed();
		const alicePhase = await bindingReadback(alice);
		const bob = await confirmed("bob", "bob", "worker-b");
		const bobPhase = await bindingReadback(bob);
		const [aliceCandidate, bobCandidate] = [
			await candidateFor(alice, alicePhase, "principal-a"),
			await candidateFor(bob, bobPhase, "principal-b"),
		];
		// Both CAS transactions reach the authorization recheck before either decides.
		const arrived = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let waiting = 0;
		beforeResolveUser = async () => {
			waiting++;
			if (waiting === 2) arrived.resolve();
			await release.promise;
		};
		try {
			const outcomes = Promise.all([
				manual.commitConfirmPin({ ...alicePhase, candidate: aliceCandidate }),
				manual.commitConfirmPin({ ...bobPhase, candidate: bobCandidate }),
			]);
			await arrived.promise;
			release.resolve();
			const results = (await outcomes).map(({ outcome }) => outcome).sort();
			expect(results).toEqual(["pinned", "rejected"]);
		} finally {
			beforeResolveUser = undefined;
			release.resolve();
		}
		const [count] =
			await client`select count(*)::int as n from platform.connection_principal_pins where released_at is null`;
		expect(count?.n).toBe(dynamic.principalMapping.maximumPinnedPrincipals);
	});

	it("admits only one of two issuers' concurrent first pins at the last free slot", async () => {
		// `maximumPinnedPrincipals` bounds the total across issuers (§13.5.1), so a
		// Worker still configured for another issuer shares the same capacity.
		const systemB = {
			...system,
			publicOrigin: "https://connection-b.test",
			issuer: "https://connection-b.test/",
		};
		const approvalB = {
			...systemApproval,
			configFingerprint: connectionSystemAccessFingerprintV1(systemB),
		};
		const policyB = {
			...policy,
			systemAccess: systemB,
			approval: approvalB,
			dynamic: {
				...dynamic,
				principalMapping: {
					...dynamic.principalMapping,
					systemAccessFingerprint: connectionSystemAccessFingerprintV1(systemB),
				},
			},
		};
		const installationsB =
			new PostgresConnectionInstallationAuthorizationTransactionV1({
				databaseUrl: database.databaseUrl,
				directory,
				manualInstallation: policyB,
			});
		const manualB = new PostgresConnectionManualInstallationStoreV1({
			databaseUrl: database.databaseUrl,
			directory,
			policy: policyB,
		});
		const saved = { access, installations, manual, use };
		try {
			await client`insert into platform.connection_principal_pins(id, issuer, principal_id, user_id, policy_ref, policy_revision)
				values ('pin-1', ${system.issuer}, 'principal-1', 'carol', 'consistency-exception-v1', 'r1')`;
			const alice = await confirmed();
			const alicePhase = await bindingReadback(alice);
			const aliceCandidate = await candidateFor(
				alice,
				alicePhase,
				"principal-a",
			);
			// Bob's installation is fixed, confirmed and read back under issuer B.
			access = resolvedAccess(systemB, approvalB);
			installations = installationsB;
			manual = manualB;
			use = createConnectionInstallationAuthorizationV1({
				store: installationsB,
			});
			const bob = await confirmed("bob", "bob", "worker-b");
			const bobPhase = await bindingReadback(bob);
			const bobCandidate = await candidateFor(bob, bobPhase, "principal-b");
			expect(bobCandidate.verified.issuer).toBe(systemB.issuer);
			const arrived = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let waiting = 0;
			beforeResolveUser = async () => {
				waiting++;
				if (waiting === 2) arrived.resolve();
				await release.promise;
			};
			try {
				const outcomes = Promise.all([
					saved.manual.commitConfirmPin({
						...alicePhase,
						candidate: aliceCandidate,
					}),
					manualB.commitConfirmPin({ ...bobPhase, candidate: bobCandidate }),
				]);
				await arrived.promise;
				release.resolve();
				const results = (await outcomes).map(({ outcome }) => outcome).sort();
				expect(results).toEqual(["pinned", "rejected"]);
			} finally {
				beforeResolveUser = undefined;
				release.resolve();
			}
			const [count] =
				await client`select count(*)::int as n from platform.connection_principal_pins where released_at is null`;
			expect(count?.n).toBe(dynamic.principalMapping.maximumPinnedPrincipals);
		} finally {
			({ access, installations, manual, use } = saved);
			await manualB.close();
			await installationsB.close();
		}
	});

	// §13.5.6 step 3: the exchange readback is read-only and admits only the
	// receipt this confirm's phase 2 was opened with, its active pin and phase 1.
	it("allows the exchange readback only with this installation's own receipt and active pin", async () => {
		const alice = await confirmed();
		const alicePhase = await bindingReadback(alice);
		expect(
			(
				await manual.commitConfirmPin({
					...alicePhase,
					candidate: await candidateFor(alice, alicePhase),
				})
			).outcome,
		).toBe("pinned");
		const bob = await confirmed("bob", "bob", "worker-b");
		const bobPhase = await bindingReadback(bob);
		const bobPinned = await manual.commitConfirmPin({
			...bobPhase,
			candidate: await candidateFor(bob, bobPhase, "principal-b"),
		});
		expect(bobPinned.outcome).toBe("pinned");
		const exchange = await manual.openConfirmPhase({
			confirmCommandId: alicePhase.confirmCommandId,
			attemptId: alicePhase.attemptId,
			attemptOwner: alicePhase.attemptOwner,
			authorizationId: alicePhase.authorizationId,
			phase: "confirm_exchange",
		});
		if (!exchange?.receipt) throw new Error("phase 2 not opened");
		expect(
			await manual.commitDelivery({
				commandId: exchange.phaseCommandId,
				attemptId: alicePhase.attemptId,
				attemptOwner: alicePhase.attemptOwner,
				command: "confirm_exchange",
				authorizationId: alicePhase.authorizationId,
				deliveryDigest: "7".repeat(64),
			}),
		).toBe(true);
		const [row] =
			await client`select descriptor_digest from platform.connection_manual_installations where authorization_id=${alice.run.authorizationId}`;
		const readback = (pinReceipt?: { id: string; candidateDigest: string }) =>
			manual.readback({
				...alice.run.commandReadback,
				command: {
					...alice.run.commandReadback.command,
					commandId: exchange.phaseCommandId,
					attemptId: alicePhase.attemptId,
					attemptOwner: alicePhase.attemptOwner,
					command: "confirm_exchange",
					requestDigest: "7".repeat(64),
					descriptorDigest: row?.descriptor_digest as string,
					...(pinReceipt ? { pinReceipt } : {}),
				},
			});
		const own = {
			id: exchange.receipt.id,
			candidateDigest: exchange.receipt.candidateDigest,
		};
		expect(await readback(own)).toBe("allowed");
		expect(await readback()).toBe("denied");
		expect(await readback({ ...own, candidateDigest: "8".repeat(64) })).toBe(
			"denied",
		);
		if (bobPinned.outcome !== "pinned") throw new Error("bob not pinned");
		expect(
			await readback({
				id: bobPinned.receipt.id,
				candidateDigest: bobPinned.receipt.candidateDigest,
			}),
		).toBe("denied");
		// A pin re-issued at another revision never admits the old receipt.
		await client`update platform.connection_principal_pins set revision=revision+1 where user_id='alice'`;
		expect(await readback(own)).toBe("denied");
	});

	// #4309 S2 (§13.5.6): only the original attempt drives the phases and an
	// unknown confirm is never resent, so a confirm that lapsed after its pin but
	// before its exchange opened is closed and its original key revoked.
	it("closes a confirm stranded between its pin and its exchange and revokes the original key", async () => {
		const flow = await confirmed();
		const phase = await bindingReadback(flow);
		const candidate = await candidateFor(flow, phase);
		expect(
			(await manual.commitConfirmPin({ ...phase, candidate })).outcome,
		).toBe("pinned");
		await client`update platform.connection_installation_commands set attempt_expires_at=clock_timestamp()-interval '1 second'
			where authorization_id=${flow.run.authorizationId} and status='sending'`;
		await manual.listPending(32, ["execution-a"]);
		expect(await pinFacts(flow.run.authorizationId)).toEqual({
			pins: 1,
			receipts: 1,
			status: "revoked",
			revoke_state: "pending",
			confirm: "confirm:unknown,confirm_binding_readback:completed",
		});
		const [revoke] =
			await client`select status from platform.connection_installation_commands where authorization_id=${flow.run.authorizationId} and command='revoke'`;
		expect(revoke?.status).toBe("pending");
		expect(
			await manual.openConfirmPhase({
				confirmCommandId: phase.confirmCommandId,
				attemptId: phase.attemptId,
				attemptOwner: phase.attemptOwner,
				authorizationId: phase.authorizationId,
				phase: "confirm_exchange",
			}),
		).toBeNull();
	});

	it("leaves an unknown confirm whose exchange was already sent for read-only verification", async () => {
		const flow = await confirmed();
		const phase = await bindingReadback(flow);
		const candidate = await candidateFor(flow, phase);
		expect(
			(await manual.commitConfirmPin({ ...phase, candidate })).outcome,
		).toBe("pinned");
		const exchange = await manual.openConfirmPhase({
			confirmCommandId: phase.confirmCommandId,
			attemptId: phase.attemptId,
			attemptOwner: phase.attemptOwner,
			authorizationId: phase.authorizationId,
			phase: "confirm_exchange",
		});
		expect(exchange?.receipt).toBeDefined();
		await client`update platform.connection_installation_commands set attempt_expires_at=clock_timestamp()-interval '1 second'
			where authorization_id=${flow.run.authorizationId} and status='sending'`;
		await manual.listPending(32, ["execution-a"]);
		expect(await pinFacts(flow.run.authorizationId)).toEqual({
			pins: 1,
			receipts: 1,
			status: "confirmed",
			revoke_state: "not_required",
			confirm:
				"confirm:unknown,confirm_binding_readback:completed,confirm_exchange:unknown",
		});
	});

	it("refuses a Principal another user confirmed outside the exception", async () => {
		const confirmedElsewhere = new PostgresConnectionManualInstallationStoreV1({
			databaseUrl: database.databaseUrl,
			directory,
			policy: {
				...policy,
				confirmedPrincipals: [
					{ issuer: system.issuer, principalId: "principal-a", userId: "bob" },
				],
			},
		});
		try {
			const flow = await confirmed();
			const phase = await bindingReadback(flow);
			expect(
				await confirmedElsewhere.commitConfirmPin({
					...phase,
					candidate: await candidateFor(flow, phase),
				}),
			).toEqual({ outcome: "rejected" });
			expect((await pinFacts(flow.run.authorizationId))?.pins).toBe(0);
		} finally {
			await confirmedElsewhere.close();
		}
	});

	it("commits no pin when the original claim expires during the authorization recheck", async () => {
		const flow = await confirmed();
		const phase = await bindingReadback(flow);
		const candidate = await candidateFor(flow, phase);
		// The recheck's directory read outlasts the original lease; another outbox
		// of the same Worker and Execution holds a live lease meanwhile.
		await expireClaimDuringRead();
		try {
			expect(await manual.commitConfirmPin({ ...phase, candidate })).toEqual({
				outcome: "unknown",
			});
		} finally {
			beforeResolveUser = undefined;
		}
		expect(await pinFacts(flow.run.authorizationId)).toEqual({
			pins: 0,
			receipts: 0,
			status: "confirmed",
			revoke_state: "not_required",
			confirm: "confirm:sending,confirm_binding_readback:sending",
		});
		expect(
			await manual.openConfirmPhase({ ...phase, phase: "confirm_exchange" }),
		).toBeNull();
	});

	it("commits no pin once the original fence, the attempt owner or notAfter no longer holds", async () => {
		const flow = await confirmed();
		const phase = await bindingReadback(flow);
		const candidate = await candidateFor(flow, phase);
		// Another Worker never commits this confirm's pin.
		expect(
			await manual.commitConfirmPin({
				...phase,
				attemptOwner: "worker-b",
				candidate,
			}),
		).toEqual({ outcome: "stale" });
		const expired = new PostgresConnectionManualInstallationStoreV1({
			databaseUrl: database.databaseUrl,
			directory,
			policy: {
				...policy,
				dynamic: {
					...dynamic,
					principalMapping: {
						...dynamic.principalMapping,
						notAfter: "2026-01-01T00:00:00Z",
					},
				},
			},
		});
		try {
			expect(await expired.commitConfirmPin({ ...phase, candidate })).toEqual({
				outcome: "unknown",
			});
		} finally {
			await expired.close();
		}
		// The original claim is re-claimed at the next fence while the pin is decided.
		await reclaim();
		expect(await manual.commitConfirmPin({ ...phase, candidate })).toEqual({
			outcome: "unknown",
		});
		expect(await pinFacts(flow.run.authorizationId)).toEqual({
			pins: 0,
			receipts: 0,
			status: "confirmed",
			revoke_state: "not_required",
			confirm: "confirm:sending,confirm_binding_readback:sending",
		});
	});
});

describe("exception pin rules: verification, unpin and notAfter (§13.5.1 items 4, 6, 8)", () => {
	let admin: PostgresConnectionPrincipalPinAdministrationV1;
	const expiredPolicy = {
		...policy,
		dynamic: {
			...dynamic,
			principalMapping: {
				...dynamic.principalMapping,
				notAfter: "2026-01-01T00:00:00Z",
			},
		},
	};

	beforeAll(() => {
		admin = new PostgresConnectionPrincipalPinAdministrationV1({
			databaseUrl: database.databaseUrl,
			policy,
		});
	});

	afterAll(async () => {
		await admin?.close();
	});

	/** One exception installation through phase 1 and its committed pin. */
	async function pinned(
		user = "alice",
		suffix = "a",
		worker = "worker-a",
		principalId = "principal-a",
	) {
		const flow = await confirmed(user, suffix, worker);
		const phase = await bindingReadback(flow);
		expect(
			(
				await manual.commitConfirmPin({
					...phase,
					candidate: await candidateFor(flow, phase, principalId),
				})
			).outcome,
		).toBe("pinned");
		return { flow, phase };
	}

	/** The logical confirm finished: the installation holds a Connection client. */
	async function finish({ flow }: Awaited<ReturnType<typeof pinned>>) {
		await client`update platform.connection_installation_commands set status='completed'
			where authorization_id=${flow.run.authorizationId} and command like 'confirm%' and status='sending'`;
	}

	/** The Worker's DELETE of the original key; without a response it stays unknown. */
	async function revoke(
		{ flow }: Awaited<ReturnType<typeof pinned>>,
		revoked = true,
	) {
		const { item, attemptId } = await claimFirst(
			"revoke",
			`execution-${flow.suffix}`,
			flow.worker,
		);
		expect(item.authorizationId).toBe(flow.run.authorizationId);
		const attempt = {
			commandId: item.commandId,
			attemptId,
			attemptOwner: flow.worker,
			authorizationId: flow.run.authorizationId,
		};
		expect(
			await manual.commitDelivery({
				...attempt,
				command: "revoke",
				deliveryDigest: "7".repeat(64),
			}),
		).toBe(true);
		return manual.settleRevoke({
			...attempt,
			...(revoked
				? {
						response: {
							schemaVersion: 1 as const,
							commandId: item.commandId,
							outcome: "revoked" as const,
						},
					}
				: {}),
		});
	}

	async function pinOf(userId: string) {
		const [row] =
			await client`select id, revision::int, rule_revision::int, verification_state,
			extract(epoch from verification_deadline - pinned_at)::int as window_seconds,
			verified_at is not null as verified, suspended_at is not null as suspended,
			overdue_at is not null as overdue, release_requested_at is not null as releasing,
			release_reason, released_at is not null as released
			from platform.connection_principal_pins where user_id=${userId}`;
		return row;
	}

	async function installation({ flow }: Awaited<ReturnType<typeof pinned>>) {
		const [row] = await client`select a.status, m.revoke_state,
			(select string_agg(c.idempotency_key || ':' || c.status, ',') from platform.connection_installation_commands c
				where c.authorization_id=a.id and c.command='revoke') as revoke
			from platform.connection_installation_authorizations a
			join platform.connection_manual_installations m on m.authorization_id=a.id
			where a.id=${flow.run.authorizationId}`;
		return row;
	}

	async function audit(pinId: string) {
		const rows =
			await client`select action, actor_type, actor_id, outcome from platform.audit_events
			where target_type='connection_principal_pin' and target_id=${pinId} order by occurred_at, action`;
		return rows.map((row) => ({ ...row }));
	}

	function record(pinId: string, expectedRuleRevision: number) {
		return {
			pinId,
			expectedRuleRevision,
			administratorId: "admin-1",
			reference:
				"https://github.com/AgoraIO-Extensions/agent-infra/issues/4199",
			requestId: "request-admin",
			traceId: "trace-admin",
		};
	}

	it("unpins only after closing and revoking every exception installation of the user (item 6)", async () => {
		const aliceA = await pinned();
		const aliceB = await pinned("alice", "b");
		const bob = await pinned("bob", "bob", "worker-b", "principal-b");
		for (const flow of [aliceA, aliceB, bob]) await finish(flow);
		const pin = await pinOf("alice");
		expect(pin).toMatchObject({
			revision: 1,
			rule_revision: 1,
			verification_state: "pending",
			window_seconds: 24 * 3600,
			releasing: false,
			released: false,
		});
		await expect(
			admin.requestRelease({ ...record(pin?.id, 1), reference: "" }),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(await admin.requestRelease(record(pin?.id, 1))).toEqual({
			outcome: "recorded",
			ruleRevision: 2,
			closed: 2,
		});
		// The same administrator record against the old rule revision writes nothing.
		expect(await admin.requestRelease(record(pin?.id, 1))).toEqual({
			outcome: "stale",
		});
		for (const flow of [aliceA, aliceB])
			expect(await installation(flow)).toEqual({
				status: "revoked",
				revoke_state: "pending",
				revoke: `manual-revoke:${flow.flow.run.authorizationId}:pending`,
			});
		// Another user's installation on the same Agent is untouched.
		expect(await installation(bob)).toEqual({
			status: "confirmed",
			revoke_state: "not_required",
			revoke: null,
		});
		// Permits stop at once; the pin stays until every revoke settled.
		expect(await pinOf("alice")).toMatchObject({
			revision: 1,
			rule_revision: 2,
			releasing: true,
			release_reason: "administrator",
			released: false,
		});
		expect(await revoke(aliceA)).toBe("revoked");
		await admin.sweep();
		expect((await pinOf("alice"))?.released).toBe(false);
		expect(await revoke(aliceB)).toBe("revoked");
		await admin.sweep();
		// Releasing moves the pin revision, so no earlier receipt binds it again.
		expect(await pinOf("alice")).toMatchObject({
			revision: 2,
			released: true,
		});
		expect(await audit(pin?.id)).toEqual([
			{
				action: "connection.principal_pin.release_requested",
				actor_type: "user",
				actor_id: "admin-1",
				outcome: "succeeded",
			},
			{
				action: "connection.principal_pin.released",
				actor_type: "system",
				actor_id: "platform-worker",
				outcome: "succeeded",
			},
		]);
		expect(await admin.requestRelease(record(pin?.id, 2))).toEqual({
			outcome: "not_found",
		});
		expect(await pinOf("bob")).toMatchObject({
			rule_revision: 1,
			releasing: false,
			released: false,
		});
	});

	it("keeps the pin while a revoke result is unknown and never re-sends it", async () => {
		const flow = await pinned();
		await finish(flow);
		const pin = await pinOf("alice");
		expect(await admin.requestRelease(record(pin?.id, 1))).toMatchObject({
			outcome: "recorded",
			closed: 1,
		});
		expect(await revoke(flow, false)).toBe("unknown");
		await admin.sweep();
		await admin.sweep();
		expect(await pinOf("alice")).toMatchObject({
			releasing: true,
			released: false,
		});
		// Only the original key exists; it is verified, never resent under a new one.
		expect(await installation(flow)).toEqual({
			status: "revoked",
			revoke_state: "unknown",
			revoke: `manual-revoke:${flow.flow.run.authorizationId}:unknown`,
		});
		expect(
			(await manual.listPending(32, ["execution-a"])).filter(
				(entry) => entry.command === "revoke",
			),
		).toEqual([]);
	});

	it("suspends the holder on a uniqueness conflict and resumes it on a consistent record (item 4)", async () => {
		const alice = await pinned();
		const pin = await pinOf("alice");
		const bobFlow = await confirmed("bob", "bob", "worker-b");
		const bobPhase = await bindingReadback(bobFlow);
		expect(
			await manual.commitConfirmPin({
				...bobPhase,
				candidate: await candidateFor(bobFlow, bobPhase, "principal-a"),
			}),
		).toEqual({ outcome: "rejected" });
		expect(await pinOf("alice")).toMatchObject({
			revision: 1,
			rule_revision: 2,
			verification_state: "pending",
			suspended: true,
		});
		expect((await audit(pin?.id)).map(({ action }) => action)).toEqual([
			"connection.principal_pin.suspended",
		]);
		// The holder's in-flight confirm opens no exchange while suspended.
		const exchange = { ...alice.phase, phase: "confirm_exchange" as const };
		expect(await manual.openConfirmPhase(exchange)).toBeNull();
		// A record against the rule revision before the suspension writes nothing.
		expect(
			await admin.recordVerification({
				...record(pin?.id, 1),
				result: "consistent",
			}),
		).toEqual({ outcome: "stale" });
		expect(
			await admin.recordVerification({
				...record(pin?.id, 2),
				result: "consistent",
			}),
		).toEqual({ outcome: "recorded", ruleRevision: 3, closed: 0 });
		expect(await pinOf("alice")).toMatchObject({
			revision: 1,
			verification_state: "verified",
			verified: true,
			suspended: false,
		});
		expect(await manual.openConfirmPhase(exchange)).not.toBeNull();
	});

	it("suspends no holder when the latecomer's original claim no longer holds", async () => {
		await pinned();
		const pin = await pinOf("alice");
		const bobFlow = await confirmed("bob", "bob", "worker-b");
		const bobPhase = await bindingReadback(bobFlow);
		const candidate = await candidateFor(bobFlow, bobPhase, "principal-a");
		await reclaim("bob");
		expect(await manual.commitConfirmPin({ ...bobPhase, candidate })).toEqual({
			outcome: "unknown",
		});
		expect(await pinOf("alice")).toMatchObject({
			rule_revision: 1,
			suspended: false,
		});
		expect(await audit(pin?.id)).toEqual([]);
	});

	it("re-reads the pin after waiting on an unpin and accepts no new installation", async () => {
		const aliceA = await pinned();
		await finish(aliceA);
		const aliceB = await confirmed("alice", "b");
		const phase = await bindingReadback(aliceB);
		const candidate = await candidateFor(aliceB, phase, "principal-a");
		const pin = await pinOf("alice");
		let commit: ReturnType<typeof manual.commitConfirmPin> | undefined;
		// An unpin holds the pin row while the second installation's CAS waits on it.
		await client.begin(async (tx) => {
			await tx`update platform.connection_principal_pins
				set release_requested_at=clock_timestamp(), release_reason='administrator',
					release_actor_id='admin-1', release_reference='reference', rule_revision=rule_revision+1
				where id=${pin?.id}`;
			commit = manual.commitConfirmPin({ ...phase, candidate });
			await vi.waitFor(
				async () => {
					const [row] =
						await client`select count(*)::int as n from pg_stat_activity
						where datname=current_database() and wait_event_type='Lock'`;
					expect(row?.n).toBe(1);
				},
				{ timeout: 5000, interval: 20 },
			);
		});
		expect(await commit).toEqual({ outcome: "rejected" });
		expect(await pinFacts(aliceB.run.authorizationId)).toMatchObject({
			receipts: 0,
			status: "revoked",
			revoke_state: "pending",
		});
	});

	it("allows no exchange readback while the pin backs no permits (items 4 and 8)", async () => {
		const alice = await confirmed();
		const phase = await bindingReadback(alice);
		expect(
			(
				await manual.commitConfirmPin({
					...phase,
					candidate: await candidateFor(alice, phase),
				})
			).outcome,
		).toBe("pinned");
		const exchange = await manual.openConfirmPhase({
			...phase,
			phase: "confirm_exchange",
		});
		if (!exchange?.receipt) throw new Error("phase 2 not opened");
		expect(
			await manual.commitDelivery({
				commandId: exchange.phaseCommandId,
				attemptId: phase.attemptId,
				attemptOwner: phase.attemptOwner,
				command: "confirm_exchange",
				authorizationId: phase.authorizationId,
				deliveryDigest: "7".repeat(64),
			}),
		).toBe(true);
		const [row] =
			await client`select descriptor_digest from platform.connection_manual_installations where authorization_id=${alice.run.authorizationId}`;
		const readback = (store = manual) =>
			store.readback({
				...alice.run.commandReadback,
				command: {
					...alice.run.commandReadback.command,
					commandId: exchange.phaseCommandId,
					attemptId: phase.attemptId,
					attemptOwner: phase.attemptOwner,
					command: "confirm_exchange",
					requestDigest: "7".repeat(64),
					descriptorDigest: row?.descriptor_digest as string,
					pinReceipt: {
						id: exchange.receipt?.id as string,
						candidateDigest: exchange.receipt?.candidateDigest as string,
					},
				},
			});
		expect(await readback()).toBe("allowed");
		// Overdue on the database clock, before any sweep closed the installation.
		const pin = await pinOf("alice");
		await client`update platform.connection_principal_pins
			set verification_deadline=clock_timestamp()-interval '1 second' where id=${pin?.id}`;
		expect(await readback()).toBe("denied");
		expect(
			await admin.recordVerification({
				...record(pin?.id, 1),
				result: "consistent",
			}),
		).toMatchObject({ outcome: "recorded" });
		expect(await readback()).toBe("allowed");
		const expired = new PostgresConnectionManualInstallationStoreV1({
			databaseUrl: database.databaseUrl,
			directory,
			policy: expiredPolicy,
		});
		try {
			expect(await readback(expired)).toBe("denied");
		} finally {
			await expired.close();
		}
	});

	it("stops, closes and unpins the user after an inconsistent record (item 4)", async () => {
		const alice = await pinned();
		const bob = await pinned("bob", "bob", "worker-b", "principal-b");
		for (const flow of [alice, bob]) await finish(flow);
		const pin = await pinOf("alice");
		expect(
			await admin.recordVerification({
				...record(pin?.id, 1),
				result: "inconsistent",
			}),
		).toEqual({ outcome: "recorded", ruleRevision: 2, closed: 1 });
		expect(await pinOf("alice")).toMatchObject({
			verification_state: "mismatch",
			releasing: true,
			release_reason: "mismatch",
			released: false,
		});
		// A later record cannot turn a mismatch back into a verified pin.
		expect(
			await admin.recordVerification({
				...record(pin?.id, 2),
				result: "consistent",
			}),
		).toEqual({ outcome: "stale" });
		expect(await installation(alice)).toMatchObject({
			status: "revoked",
			revoke_state: "pending",
		});
		expect(await installation(bob)).toMatchObject({
			status: "confirmed",
			revoke_state: "not_required",
		});
		expect(await revoke(alice)).toBe("revoked");
		await admin.sweep();
		expect(await pinOf("alice")).toMatchObject({ released: true });
		expect((await audit(pin?.id)).map(({ action }) => action)).toEqual([
			"connection.principal_pin.verification_mismatch",
			"connection.principal_pin.released",
		]);
		expect(await pinOf("bob")).toMatchObject({
			rule_revision: 1,
			released: false,
		});
	});

	it("closes the user's installations once the verification window passes and keeps the pin (item 4)", async () => {
		const aliceA = await pinned();
		await finish(aliceA);
		const bob = await pinned("bob", "bob", "worker-b", "principal-b");
		await finish(bob);
		// A second installation of the same user is read back before the deadline.
		const aliceB = await confirmed("alice", "b");
		const aliceBPhase = await bindingReadback(aliceB);
		const pin = await pinOf("alice");
		await client`update platform.connection_principal_pins
			set verification_deadline=clock_timestamp()-interval '1 second' where id=${pin?.id}`;
		// The overdue pin backs no new installation, though the Principal is its own.
		expect(
			await manual.commitConfirmPin({
				...aliceBPhase,
				candidate: await candidateFor(aliceB, aliceBPhase, "principal-a"),
			}),
		).toEqual({ outcome: "rejected" });
		expect((await pinFacts(aliceB.run.authorizationId))?.receipts).toBe(0);
		await admin.sweep();
		await admin.sweep();
		expect(await installation(aliceA)).toMatchObject({
			status: "revoked",
			revoke_state: "pending",
		});
		expect(await installation(bob)).toMatchObject({
			status: "confirmed",
			revoke_state: "not_required",
		});
		expect(await pinOf("alice")).toMatchObject({
			verification_state: "pending",
			overdue: true,
			releasing: false,
			released: false,
		});
		expect(await audit(pin?.id)).toEqual([
			{
				action: "connection.principal_pin.verification_overdue",
				actor_type: "system",
				actor_id: "platform-worker",
				outcome: "succeeded",
			},
		]);
		expect(await pinOf("bob")).toMatchObject({ overdue: false });
	});

	// #4315 MUST 1: a conflict suspends a "主体待核对" holder without moving its
	// deadline; the window is always counted from the first pin.
	it("keeps a pending holder's first-pin deadline when a conflict suspends it (item 4)", async () => {
		const alice = await pinned();
		await finish(alice);
		const pin = await pinOf("alice");
		// First pinned 23 hours ago, so 1 hour of its window is left.
		await client`update platform.connection_principal_pins
			set pinned_at=pinned_at-interval '23 hours', verification_deadline=verification_deadline-interval '23 hours'
			where id=${pin?.id}`;
		const [before] =
			await client`select verification_deadline from platform.connection_principal_pins where id=${pin?.id}`;
		const bobFlow = await confirmed("bob", "bob", "worker-b");
		const bobPhase = await bindingReadback(bobFlow);
		expect(
			await manual.commitConfirmPin({
				...bobPhase,
				candidate: await candidateFor(bobFlow, bobPhase, "principal-a"),
			}),
		).toEqual({ outcome: "rejected" });
		const [after] =
			await client`select verification_deadline from platform.connection_principal_pins where id=${pin?.id}`;
		expect(after?.verification_deadline).toEqual(before?.verification_deadline);
		expect(await pinOf("alice")).toMatchObject({
			verification_state: "pending",
			suspended: true,
			window_seconds: dynamic.principalMapping.verificationWindowHours * 3600,
		});
		// 25 hours after the first pin the window has passed: closed and revoked.
		await client`update platform.connection_principal_pins
			set pinned_at=pinned_at-interval '2 hours', verification_deadline=verification_deadline-interval '2 hours'
			where id=${pin?.id}`;
		await admin.sweep();
		expect(await installation(alice)).toMatchObject({
			status: "revoked",
			revoke_state: "pending",
		});
		expect(await pinOf("alice")).toMatchObject({ overdue: true });
	});

	// #4315 MUST 2: overdue pins already handled leave the candidates, so more
	// than one batch of overdue pins never starves a later user.
	it("closes an overdue user's installations behind more than 32 earlier overdue pins (item 4)", async () => {
		const alice = await pinned();
		await finish(alice);
		const pin = await pinOf("alice");
		await client`update platform.connection_principal_pins
			set verification_deadline=clock_timestamp()-interval '1 second' where id=${pin?.id}`;
		// 32 overdue pins of other users whose ids sort before alice's.
		for (let index = 0; index < 32; index++) {
			const n = String(index).padStart(2, "0");
			await client`insert into platform.connection_principal_pins
				(id, issuer, principal_id, user_id, policy_ref, policy_revision, verification_deadline)
				values (${`00000000-0000-0000-0000-0000000000${n}`}, ${system.issuer}, ${`principal-overdue-${n}`},
					${`user-overdue-${n}`}, 'consistency-exception-v1', 'r1', clock_timestamp()-interval '1 second')`;
		}
		for (let pass = 0; pass < 3; pass++) await admin.sweep();
		expect(await installation(alice)).toMatchObject({
			status: "revoked",
			revoke_state: "pending",
		});
		expect(await pinOf("alice")).toMatchObject({ overdue: true });
		const [marked] =
			await client`select count(*)::int as n from platform.connection_principal_pins where overdue_at is not null`;
		expect(marked?.n).toBe(33);
	});

	it("closes and revokes every exception installation at notAfter in the drain sweep (item 8)", async () => {
		const alice = await pinned();
		const bob = await pinned("bob", "bob", "worker-b", "principal-b");
		for (const flow of [alice, bob]) await finish(flow);
		const expired = new PostgresConnectionManualInstallationStoreV1({
			databaseUrl: database.databaseUrl,
			directory,
			policy: expiredPolicy,
		});
		try {
			await expired.listPending(32, ["execution-a"]);
		} finally {
			await expired.close();
		}
		for (const flow of [alice, bob])
			expect(await installation(flow)).toEqual({
				status: "revoked",
				revoke_state: "pending",
				revoke: `manual-revoke:${flow.flow.run.authorizationId}:pending`,
			});
		expect(await revoke(alice)).toBe("revoked");
		expect(await installation(alice)).toMatchObject({
			revoke_state: "revoked",
		});
	});
});
