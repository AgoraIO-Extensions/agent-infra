import { randomBytes, randomUUID } from "node:crypto";
import {
	connectionSystemAccessFingerprintV1,
	resolveApprovedConnectionSystemAccessV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import {
	type ConnectionRegistrationReceiptV1,
	type ConnectionRegistrationTemplateV1,
	connectionHostDeploymentIdentityV1,
} from "@agent-infra/contracts/runtime";
import {
	buildConnectionRegistrationTemplateV1,
	connectionInstallCommandDigestV1,
	connectionInstallConfigurationDigestV1,
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
const policy = {
	systemAccess: system,
	approval: systemApproval,
	clientName: "Agent Infra",
};
const access = (() => {
	const value = resolveApprovedConnectionSystemAccessV1(system, systemApproval);
	if (value.status !== "available") throw new Error("fixture");
	return value;
})();
const directory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1 as const,
		userId,
		accountStatus: "active" as const,
		organizationIds: ["eng"],
		authorizationRevision: "identity-r1",
	}),
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
	await client`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,status,lease_owner,lease_expires_at,trace_id) values (${`item-${suffix}`},'conversation',${`conversation-${suffix}`},'conversation.turn.submit.v1',${client.json({ executionId: `execution-${suffix}` })},'processing',${worker},now()+interval '1 hour','trace')`;
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
	await client`delete from platform.connection_manual_installations`;
	await client`delete from platform.connection_installation_commands`;
	await client`delete from platform.connection_installation_authorizations`;
	await client`delete from platform.idempotency_records where scope_type='connection_installation'`;
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

/** Drives prepare to a delivered request; returns the facts the Host would read back. */
async function prepareDelivered(
	user = "alice",
	suffix = "a",
	worker = "worker-a",
) {
	const projection = await begin(user, suffix);
	const authorizationId = projection.authorizationId;
	const prepare = await claimFirst("prepare", `execution-${suffix}`, worker);
	expect(prepare.claimed?.command.command).toBe("prepare");
	const { template, registrationKey } = await templateFor(authorizationId, {
		user,
		suffix,
		worker,
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
		agentId: "agent-a",
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
		authorizationId,
		prepare,
		template,
		registrationKey,
		supplyAttemptId,
		readbackBase,
		commandReadback,
	};
}

function settlePrepared(run: Awaited<ReturnType<typeof prepareDelivered>>) {
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
			receipt: receiptFor(run.template, run.registrationKey),
		},
	});
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
			},
		};
		expect(await manual.readback(beginReadback)).toBe("allowed");
		expect(
			await manual.readback({
				...beginReadback,
				command: {
					...beginReadback.command,
					configurationDigest: "5".repeat(64),
				},
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
});
