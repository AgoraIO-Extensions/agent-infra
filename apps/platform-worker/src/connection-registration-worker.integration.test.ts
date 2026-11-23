import { createHash, generateKeyPairSync } from "node:crypto";
import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	type ConnectionConsumerDisableIntentV1,
	type ConnectionConsumerRegistrationIntentV1,
	connectionServiceCredentialSecretInputV1,
	planConnectionConsumerDisableIdentityV1,
	planConnectionConsumerRegistrationV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConnectionAssociationStoreV1,
	PostgresConnectionAssociationSourceV1,
	PostgresConnectionManualAssociationReaderV1,
} from "@agent-infra/platform-store";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import { createWorkloadSecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import {
	createStartupConnectionSelectionGuardV1,
	readConnectionConsumerSourceSelectionV1,
	resolveRegisteredConnectionConsumerBindingsV1,
} from "./connection-registration-bindings.js";
import { createConnectionConsumerRegistrationHttpAdapterV2 } from "./connection-registration-http.js";
import { createConnectionConsumerRegistrationWorkerV1 } from "./connection-registration-worker.js";

const policy = {
	schemaVersion: 1 as const,
	sourceNamespace: "controlled-worker-integration",
	revision: "policy-1",
	callbackUrl: "https://platform.example.test/connection/callback",
	resource: "https://connection.example.test/mcp",
	scope: "mcp:tools",
};
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("connection-registration-worker");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 2, onnotice: () => {} });
}, 120_000);
beforeEach(async () => {
	await sql`truncate platform.agents, platform.outbox_items, platform.persisted_events, platform.platform_user_disables cascade`;
	await sql`insert into platform.agents (id) values ('agent-a')`;
	await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,desired_state,workload_revision,fence) values ('application-a','agent-a','owner-a','Agent A','Controlled registration','creating','trace','request',now(),1,1,'running',1,1)`;
	await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values ('agent-a','owner-a',now())`;
	const intent = planConnectionConsumerRegistrationV1({
		policy,
		platformAgentId: "agent-a",
		platformOwnerId: "owner-a",
		consumerName: "Agent A",
	});
	await sql.begin(async (transaction) => {
		await transaction`insert into platform.connection_consumer_registrations(operation_id,agent_id,source_namespace,source_key,request_digest,idempotency_key,request) values (${intent.operationId},${intent.platformAgentId},${intent.sourceNamespace},${intent.sourceKey},${intent.requestDigest},${intent.idempotencyKey},${transaction.json({ ...intent })})`;
		await transaction`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id) values (${intent.operationId},'agent',${intent.platformAgentId},'agent.connection.consumer.register.v1',${transaction.json({ schemaVersion: 1, operationId: intent.operationId, platformAgentId: intent.platformAgentId, requestDigest: intent.requestDigest })},'trace')`;
	});
	await sql`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id) values ('workload-untouched','agent','agent-a','agent.workload.reconcile.v1','{}'::jsonb,'trace')`;
});
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});
const receipt = (intent: ConnectionConsumerRegistrationIntentV1) => ({
	outcome: "registered" as const,
	receipt: {
		schemaVersion: 1 as const,
		operationId: intent.operationId,
		sourceNamespace: intent.sourceNamespace,
		sourceKey: intent.sourceKey,
		requestDigest: intent.requestDigest,
		consumerId: "actual-consumer-a",
		consumerRevision: "1",
		registrationId: "actual-registration-a",
	},
});

it("default absence of an adapter keeps the unsent intent pending and retries only its outbox", async () => {
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
	});
	try {
		await worker.runOnce();
		expect(
			await sql`select status, consumer_id from platform.connection_consumer_registrations`,
		).toEqual([{ status: "pending", consumer_id: null }]);
		expect(
			await sql`select operation,status from platform.outbox_items order by operation`,
		).toEqual([
			{
				operation: "agent.connection.consumer.register.v1",
				status: "retry_scheduled",
			},
			{ operation: "agent.workload.reconcile.v1", status: "pending" },
		]);
	} finally {
		await worker.close();
	}
});

it("reconciles a thrown registration on the same operation without creating again", async () => {
	const register = vi.fn(async () => {
		throw new Error("Controlled lost response");
	});
	const reconcile = vi.fn(
		async (intent: ConnectionConsumerRegistrationIntentV1) => receipt(intent),
	);
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter: { register, reconcile },
	});
	try {
		await worker.runOnce();
		expect(
			await sql`select status from platform.connection_consumer_registrations`,
		).toEqual([{ status: "unknown" }]);
		await sql`update platform.outbox_items set available_at = now() where operation = 'agent.connection.consumer.register.v1'`;
		await worker.runOnce();
		expect(register).toHaveBeenCalledOnce();
		expect(reconcile).toHaveBeenCalledOnce();
		expect(
			await sql`select status, consumer_id from platform.connection_consumer_registrations`,
		).toEqual([{ status: "registered", consumer_id: "actual-consumer-a" }]);
		expect(
			await sql`select status from platform.outbox_items where operation = 'agent.connection.consumer.register.v1'`,
		).toEqual([{ status: "succeeded" }]);
		expect(
			await sql`select * from platform.connection_consumer_registrations`,
		).toHaveLength(1);
	} finally {
		await worker.close();
	}
});

it("keeps the original delivery unknown if the Platform Owner is disabled during I/O", async () => {
	const register = vi.fn(
		async (intent: ConnectionConsumerRegistrationIntentV1) => {
			await sql`insert into platform.platform_user_disables(user_id) values ('owner-a')`;
			return receipt(intent);
		},
	);
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter: { register, reconcile: register },
	});
	try {
		await worker.runOnce();
		expect(register).toHaveBeenCalledOnce();
		expect(
			await sql`select status, consumer_id from platform.connection_consumer_registrations`,
		).toEqual([{ status: "unknown", consumer_id: null }]);
		expect(
			await sql`select status from platform.outbox_items where operation = 'agent.connection.consumer.register.v1'`,
		).toEqual([{ status: "retry_scheduled" }]);
	} finally {
		await worker.close();
	}
});

it.each([false, true])(
	"consumes the original worker's persisted Consumer binding and rejects a late Owner change (%s)",
	async (changed) => {
		const worker = createConnectionConsumerRegistrationWorkerV1({
			databaseUrl: database.databaseUrl,
			policy,
			adapter: {
				register: async (intent) => receipt(intent),
				reconcile: async (intent) => receipt(intent),
			},
		});
		try {
			await worker.runOnce();
			const resolve = vi.fn(async (signal: AbortSignal, registrations) => {
				signal.throwIfAborted();
				const binding = registrations?.["agent-a"];
				if (!binding) throw Error("Expected original persisted binding");
				expect(binding.receipt.consumerId).toBe("actual-consumer-a");
				expect(binding.source).toEqual({
					ref: binding.intent.operationId,
					revision: "1",
				});
				const profile = {
					schemaVersion: 1 as const,
					publicOrigin: "https://connection.example.test",
					mcpPath: "/mcp",
					consumerId: binding.receipt.consumerId,
					audience: "mcp",
					egressProfile: { ref: "controlled-egress", revision: "r1" },
				};
				if (changed)
					await sql`insert into platform.platform_user_disables(user_id) values ('owner-a')`;
				return {
					"agent-a": {
						profile,
						approval: {
							schemaVersion: 1,
							configFingerprint:
								connectionConsumerProfileFingerprintV1(profile),
							egressEnforced: true,
							source: binding.source,
						},
						installationSupply: {
							ref: "controlled-host-supply",
							revision: "r1",
						},
					},
				};
			});
			const bindings = await resolveRegisteredConnectionConsumerBindingsV1({
				databaseUrl: database.databaseUrl,
				policy,
				resolve,
				signal: new AbortController().signal,
			});
			expect(resolve).toHaveBeenCalledOnce();
			expect(Object.keys(bindings)).toEqual(changed ? [] : ["agent-a"]);
			if (!changed)
				expect(bindings["agent-a"]?.profile).toMatchObject({
					consumerId: "actual-consumer-a",
				});
		} finally {
			await worker.close();
		}
	},
);

it("never prepares an installation from an original unknown worker delivery", async () => {
	const unknown = async () => ({
		outcome: "unknown" as const,
		failureCode: "CONTROLLED_UNKNOWN",
	});
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter: { register: unknown, reconcile: unknown },
	});
	try {
		await worker.runOnce();
		const resolve = vi.fn(async () => ({}));
		expect(
			await resolveRegisteredConnectionConsumerBindingsV1({
				databaseUrl: database.databaseUrl,
				policy,
				resolve,
				signal: new AbortController().signal,
			}),
		).toEqual({});
		expect(resolve).not.toHaveBeenCalled();
	} finally {
		await worker.close();
	}
});

/** Rows the accepted administrator `disable_agent` transaction writes (Store-tested separately). */
async function disableAgent() {
	const [registration] =
		await sql`select operation_id, source_namespace from platform.connection_consumer_registrations where agent_id='agent-a'`;
	if (!registration) throw new Error("Expected registration");
	const identity = planConnectionConsumerDisableIdentityV1({
		registrationOperationId: registration.operation_id,
		sourceNamespace: registration.source_namespace,
		platformAgentId: "agent-a",
	});
	await sql.begin(async (transaction) => {
		await transaction`update platform.agent_applications set status='disabled', desired_state='stopped', service_availability=null where agent_id='agent-a'`;
		await transaction`insert into platform.connection_consumer_disables(operation_id,registration_operation_id,agent_id,source_namespace,idempotency_key) values (${identity.operationId},${identity.registrationOperationId},'agent-a',${identity.sourceNamespace},${identity.idempotencyKey})`;
		await transaction`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id) values (${identity.operationId},'agent','agent-a','agent.connection.consumer.disable.v1',${transaction.json({ schemaVersion: 1, operationId: identity.operationId, platformAgentId: "agent-a", registrationOperationId: identity.registrationOperationId })},'trace')`;
	});
	await sql`update platform.outbox_items set available_at = now() where operation like 'agent.connection.consumer.%'`;
}
const disabledReceipt = (intent: ConnectionConsumerDisableIntentV1) => ({
	outcome: "disabled" as const,
	receipt: {
		schemaVersion: 1 as const,
		operationId: intent.operationId,
		consumerId: intent.consumerId,
		registrationId: intent.registrationId,
		resultRevision: "2",
		requestDigest: intent.requestDigest,
	},
});
const consumerOutbox = () =>
	sql`select operation, status from platform.outbox_items order by operation`;

it("disables only the Agent's own registered Consumer once and confirms the exact receipt", async () => {
	const disable = vi.fn(async (intent: ConnectionConsumerDisableIntentV1) =>
		disabledReceipt(intent),
	);
	const reconcileDisable = vi.fn(
		async (intent: ConnectionConsumerDisableIntentV1) =>
			disabledReceipt(intent),
	);
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter: {
			register: async (intent) => receipt(intent),
			reconcile: async (intent) => receipt(intent),
			disable,
			reconcileDisable,
		},
	});
	try {
		await worker.runOnce();
		expect(disable).not.toHaveBeenCalled();
		await disableAgent();
		await worker.runOnce();
		expect(disable).toHaveBeenCalledOnce();
		expect(reconcileDisable).not.toHaveBeenCalled();
		expect(disable.mock.calls[0]?.[0]).toMatchObject({
			platformAgentId: "agent-a",
			consumerId: "actual-consumer-a",
			registrationId: "actual-registration-a",
			expectedRevision: "1",
			policyRevision: policy.revision,
		});
		expect(
			await sql`select status, result_revision from platform.connection_consumer_disables`,
		).toEqual([{ status: "disabled", result_revision: "2" }]);
		expect(await consumerOutbox()).toEqual([
			{
				operation: "agent.connection.consumer.disable.v1",
				status: "succeeded",
			},
			{
				operation: "agent.connection.consumer.register.v1",
				status: "succeeded",
			},
			{ operation: "agent.workload.reconcile.v1", status: "pending" },
		]);
	} finally {
		await worker.close();
	}
});

it("a lost disable response only reads back the original command", async () => {
	const disable = vi.fn(async (_intent: ConnectionConsumerDisableIntentV1) => {
		throw new Error("Controlled lost response");
	});
	const reconcileDisable = vi.fn(
		async (intent: ConnectionConsumerDisableIntentV1) =>
			disabledReceipt(intent),
	);
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter: {
			register: async (intent) => receipt(intent),
			reconcile: async (intent) => receipt(intent),
			disable,
			reconcileDisable,
		},
	});
	try {
		await worker.runOnce();
		await disableAgent();
		await worker.runOnce();
		expect(
			await sql`select status, request is not null as sent from platform.connection_consumer_disables`,
		).toEqual([{ status: "unknown", sent: true }]);
		await sql`update platform.outbox_items set available_at = now() where operation = 'agent.connection.consumer.disable.v1'`;
		await worker.runOnce();
		expect(disable).toHaveBeenCalledOnce();
		expect(reconcileDisable).toHaveBeenCalledOnce();
		expect(reconcileDisable.mock.calls[0]?.[0]).toEqual(
			disable.mock.calls[0]?.[0],
		);
		expect(
			await sql`select status from platform.connection_consumer_disables`,
		).toEqual([{ status: "disabled" }]);
	} finally {
		await worker.close();
	}
});

it("an adapter without the lifecycle seam never sends a disable", async () => {
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter: {
			register: async (intent) => receipt(intent),
			reconcile: async (intent) => receipt(intent),
		},
	});
	try {
		await worker.runOnce();
		await disableAgent();
		await worker.runOnce();
		expect(
			await sql`select status, failure_code, request is null as unsent from platform.connection_consumer_disables`,
		).toEqual([
			{
				status: "pending",
				failure_code: "CONNECTION_DISABLE_ADAPTER_UNAVAILABLE",
				unsent: true,
			},
		]);
		expect(
			await sql`select status from platform.outbox_items where operation = 'agent.connection.consumer.disable.v1'`,
		).toEqual([{ status: "retry_scheduled" }]);
	} finally {
		await worker.close();
	}
});

it("an Agent disabled before registration was sent never registers or disables", async () => {
	const register = vi.fn(
		async (intent: ConnectionConsumerRegistrationIntentV1) => receipt(intent),
	);
	const disable = vi.fn(async (intent: ConnectionConsumerDisableIntentV1) =>
		disabledReceipt(intent),
	);
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter: {
			register,
			reconcile: register,
			disable,
			reconcileDisable: disable,
		},
	});
	try {
		await disableAgent();
		await worker.runOnce();
		await sql`update platform.outbox_items set available_at = now() where operation = 'agent.connection.consumer.disable.v1'`;
		await worker.runOnce();
		expect(register).not.toHaveBeenCalled();
		expect(disable).not.toHaveBeenCalled();
		expect(
			await sql`select status, failure_code from platform.connection_consumer_registrations`,
		).toEqual([
			{
				status: "failed",
				failure_code: "CONNECTION_REGISTRATION_AGENT_DISABLED",
			},
		]);
		expect(
			await sql`select status from platform.connection_consumer_disables`,
		).toEqual([{ status: "not_required" }]);
		expect(await consumerOutbox()).toEqual([
			{
				operation: "agent.connection.consumer.disable.v1",
				status: "succeeded",
			},
			{ operation: "agent.connection.consumer.register.v1", status: "failed" },
			{ operation: "agent.workload.reconcile.v1", status: "pending" },
		]);
	} finally {
		await worker.close();
	}
});

it("closes a startup static or shared Consumer selection for an Agent associated after Worker start (#4157)", async () => {
	await sql`delete from platform.outbox_items`;
	await sql`delete from platform.connection_consumer_registrations`;
	await sql`insert into platform.agents (id) values ('agent-b')`;
	// Startup: no Agent has a persistent source, so every Agent was selected as legacy.
	expect(
		await readConnectionConsumerSourceSelectionV1(database.databaseUrl),
	).toEqual({ automaticAgentIds: [], legacyAgentIds: ["agent-a", "agent-b"] });
	const source = new PostgresConnectionAssociationSourceV1({
		databaseUrl: database.databaseUrl,
	});
	try {
		const shared = createStartupConnectionSelectionGuardV1({ source });
		await expect(shared("agent-a")).resolves.toBe(true);
		// The Owner associates agent-a while the Worker keeps its startup selection.
		await sql`insert into platform.connection_association_generations(agent_id,last_revision) values ('agent-a',1)`;
		await expect(shared("agent-a")).resolves.toBe(false);
		// Disconnect keeps the durable generation: the shared Consumer stays closed.
		await sql`update platform.connection_association_generations set last_revision=2`;
		await expect(shared("agent-a")).resolves.toBe(false);
		await expect(shared("agent-b")).resolves.toBe(true);
		// With a startup legacy set, Agents outside it already fail closed elsewhere.
		const legacy = createStartupConnectionSelectionGuardV1({
			source,
			startupLegacyAgentIds: new Set(["agent-b"]),
		});
		await expect(legacy("agent-a")).resolves.toBe(true);
		await sql`insert into platform.connection_association_generations(agent_id,last_revision) values ('agent-b',1)`;
		await expect(legacy("agent-b")).resolves.toBe(false);
	} finally {
		await source.close();
	}
	// An unavailable source throws; delivery callers fail closed on it.
	const broken = createStartupConnectionSelectionGuardV1({
		source: {
			persistent: async () => {
				throw new Error("down");
			},
		},
	});
	await expect(broken("agent-b")).rejects.toThrow("down");
	await sql`delete from platform.connection_association_generations`;
});

// The real HTTP parser, outbox lease, transaction and ADR 0002 encryption meet here.
const v2Secret = `conn_consumer_${"s".repeat(43)}`;
const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicDer = keys.publicKey.export({ type: "spki", format: "der" });
const wrapping = {
	schemaVersion: 1,
	keyVersion: "registration-key",
	wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
	publicKeySpkiDerBase64: publicDer.toString("base64"),
	publicKeyFingerprint: createHash("sha256").update(publicDer).digest("hex"),
	rsaModulusBits: 3072,
	status: "active",
};
const encryptor = createSecretEncryptorV1({
	encryptionKeys: {
		schemaVersion: 1,
		activeWrappingKeyVersion: wrapping.keyVersion,
		keys: [wrapping],
	},
});
const encryptCredential = (
	binding: Parameters<typeof connectionServiceCredentialSecretInputV1>[0],
	plaintext: string,
) =>
	encryptor.encrypt(
		connectionServiceCredentialSecretInputV1(
			binding,
			plaintext,
			new Date().toISOString(),
		),
	);
function responseAdapterV2() {
	const calls: string[] = [];
	const adapter = createConnectionConsumerRegistrationHttpAdapterV2({
		publicOrigin: "https://connection.example.test",
		policy,
		resolveOwnerBinding: async (intent) => ({
			sourceNamespace: intent.sourceNamespace,
			platformAgentId: intent.platformAgentId,
			platformOwnerId: intent.platformOwnerId,
			ownerPrincipalId: "principal-owner",
			companyId: "company",
		}),
		authenticatedRequest: async (request) => {
			calls.push(request.method);
			const intent = planConnectionConsumerRegistrationV1({
				policy,
				platformAgentId: "agent-a",
				platformOwnerId: "owner-a",
				consumerName: "Agent A",
			});
			const payload = {
				callbackUrl: policy.callbackUrl,
				consumerName: intent.consumerName,
				executionMode: "USER",
				owner: { companyId: "company", principalId: "principal-owner" },
				platformAgentId: intent.platformAgentId,
				policyRevision: policy.revision,
				resource: policy.resource,
				schemaVersion: 2,
				scopes: [policy.scope],
				sourceNamespace: policy.sourceNamespace,
				version: "platform-agent-consumer-v2",
			};
			const requestDigest = `connection-json-v2:${createHash("sha256")
				.update(`connection-json-v2:${JSON.stringify(payload)}`)
				.digest("hex")}`;
			const common = {
				schemaVersion: 2,
				registrationId: "registration-a",
				sourceNamespace: policy.sourceNamespace,
				platformAgentId: intent.platformAgentId,
				consumerId: "consumer-agent-a",
				requestKeyHash: createHash("sha256")
					.update(intent.idempotencyKey)
					.digest("hex"),
				requestDigestVersion: "platform-agent-consumer-v2/connection-json-v2",
				requestDigest,
			};
			return Response.json(
				{
					receipt: {
						...common,
						sourceReceipt: "source-a",
						executionMode: "USER",
						ownerPrincipalId: "principal-owner",
						companyId: "company",
						consumerName: intent.consumerName,
						callbackUrl: policy.callbackUrl,
						resource: policy.resource,
						scopes: [policy.scope],
						policyRevision: policy.revision,
						status: "ACTIVE",
						revision: "1",
					},
					operation: {
						...common,
						kind: "create",
						expectedRevision: null,
						resultRevision: "1",
						status: "APPLIED",
						failureCode: null,
					},
					...(request.method === "POST" ? { secret: v2Secret } : {}),
				},
				{
					status: request.method === "POST" ? 201 : 200,
					headers: { "cache-control": "no-store" },
				},
			);
		},
	});
	if (!adapter) throw new Error("v2 fixture unavailable");
	return { adapter, calls };
}
it("v2 without approved encryption stays unsent", async () => {
	const { adapter, calls } = responseAdapterV2();
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter,
	});
	try {
		await worker.runOnce();
		expect(calls).toEqual([]);
		expect(
			(
				await sql`select status from platform.connection_consumer_registrations`
			)[0]?.status,
		).toBe("pending");
	} finally {
		await worker.close();
	}
});
it("v2 atomically commits private ciphertext and registration and supplies the existing Host reader", async () => {
	const { adapter, calls } = responseAdapterV2();
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter,
		encryptCredential,
	});
	const reader = new PostgresConnectionManualAssociationReaderV1({
		databaseUrl: database.databaseUrl,
	});
	try {
		await worker.runOnce();
		expect(calls).toEqual(["POST"]);
		const [registration] =
			await sql`select status,consumer_id,association_revision,receipt from platform.connection_consumer_registrations`;
		expect(registration).toMatchObject({
			status: "registered",
			consumer_id: "consumer-agent-a",
		});
		const material = await reader.currentOne("agent-a");
		expect(material).toBeDefined();
		expect(await reader.associated("agent-a")).toBe(true);
		expect(await reader.associated("other-agent")).toBe(false);
		const decryptor = createWorkloadSecretKeyringDecryptorV1({
			keys: [
				{
					keyVersion: wrapping.keyVersion,
					privateKeyPkcs8DerBase64: keys.privateKey
						.export({ type: "pkcs8", format: "der" })
						.toString("base64"),
				},
			],
		});
		const opened = await decryptor.decrypt({
			encryptedRecord: material?.credentialCiphertext,
			traceId: "v2-supply",
		});
		expect(opened.outcome).toBe("decrypted");
		if (opened.outcome === "decrypted") {
			try {
				expect(Buffer.from(opened.plaintext).toString()).toBe(v2Secret);
			} finally {
				opened.plaintext.fill(0);
			}
		}
		const stored =
			await sql`select to_jsonb(r)::text as data from platform.connection_consumer_registrations r
			union all select to_jsonb(m)::text from platform.connection_manual_associations m
			union all select to_jsonb(o)::text from platform.outbox_items o`;
		expect(JSON.stringify(stored)).not.toContain(v2Secret);
		const association = new PostgresAgentConnectionAssociationStoreV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			expect(
				await association.execute((tx) => tx.current("agent-a")),
			).toMatchObject({ source: "automatic", status: "registered" });
		} finally {
			await association.close();
		}
		await disableAgent();
		expect(await reader.associated("agent-a")).toBe(false);

		await sql`update platform.agent_owners set owner_id='other' where agent_id='agent-a'`;
		expect(await reader.associated("agent-a")).toBe(false);
	} finally {
		await worker.close();
		await reader.close();
	}
});
it("v2 deferred COMMIT failure rolls back custody; restart GET cannot recreate the lost credential", async () => {
	const { adapter, calls } = responseAdapterV2();
	await sql`create function platform.synthetic_custody_commit_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic commit failure'; end $$`;
	await sql`create constraint trigger synthetic_custody_commit_failure after update on platform.connection_consumer_registrations
		deferrable initially deferred for each row when (new.status='registered') execute function platform.synthetic_custody_commit_failure()`;
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter,
		encryptCredential,
	});
	try {
		await worker.runOnce();
	} finally {
		await worker.close();
		await sql`drop trigger synthetic_custody_commit_failure on platform.connection_consumer_registrations`;
		await sql`drop function platform.synthetic_custody_commit_failure()`;
	}
	expect(
		(
			await sql`select status from platform.connection_consumer_registrations`
		)[0]?.status,
	).toBe("unknown");
	expect(
		await sql`select agent_id from platform.connection_manual_associations`,
	).toEqual([]);
	expect(
		await sql`select agent_id from platform.connection_association_generations`,
	).toEqual([]);
	await sql`update platform.outbox_items set available_at=clock_timestamp() where status='retry_scheduled'`;
	const restarted = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter,
		encryptCredential,
	});
	try {
		await restarted.runOnce();
		expect(calls).toEqual(["POST", "GET"]);
		expect(
			(
				await sql`select status from platform.connection_consumer_registrations`
			)[0]?.status,
		).toBe("unknown");
		expect(
			await sql`select agent_id from platform.connection_manual_associations`,
		).toEqual([]);
	} finally {
		await restarted.close();
	}
});
it("v2 committed custody survives a lost adapter result and restart never POSTs again", async () => {
	const { adapter, calls } = responseAdapterV2();
	const worker = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		encryptCredential,
		adapter: {
			...adapter,
			register: async (...args) => {
				await adapter.register(...args);
				throw new Error("lost local result");
			},
		},
	});
	try {
		await worker.runOnce();
	} finally {
		await worker.close();
	}
	await sql`update platform.outbox_items set available_at=clock_timestamp() where status='retry_scheduled'`;
	const restarted = createConnectionConsumerRegistrationWorkerV1({
		databaseUrl: database.databaseUrl,
		policy,
		adapter,
		encryptCredential,
	});
	try {
		await restarted.runOnce();
		expect(calls).toEqual(["POST"]);
		expect(
			(
				await sql`select status from platform.outbox_items where operation='agent.connection.consumer.register.v1'`
			)[0]?.status,
		).toBe("succeeded");
		expect(
			await sql`select agent_id from platform.connection_manual_associations`,
		).toHaveLength(1);
	} finally {
		await restarted.close();
	}
});
