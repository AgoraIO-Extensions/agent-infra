import { createHash, generateKeyPairSync } from "node:crypto";
import type {
	ApplicationFoundationTransactionPortV1,
	ApplicationFoundationWritePlanV1,
} from "@agent-infra/platform-core";
import { createApplicationFoundationUseCaseV1 } from "@agent-infra/platform-core";
import { createRelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type ApplicationFoundationFailurePoint,
	applicationFoundationActorContextV1,
	applicationFoundationAdmissionDependenciesV1,
	applicationFoundationCommandV1,
	applicationFoundationConfigurationV1,
	applicationFoundationTransactionConformance,
	captureApplicationFoundationSubmission,
	captureApplicationFoundationWritePlan,
	emptyApplicationFoundationSnapshot,
} from "../../platform-core/src/application-foundation.conformance.ts";
import { PostgresAgentDefaultRelayKeyStoreV1 } from "./agent-default-relay-key.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import {
	createSecretRecordFixtureResolver,
	materializeSecretRecordFixtureAttachments,
} from "./secret-record-fixture.ts";

const triggerName = "application_foundation_injected_failure";
const functionName = "platform.application_foundation_injected_failure";
const apiRecipientUserId = "3f183a1b-a865-452b-88c9-a47159072b68";
type PostgresClient = ReturnType<typeof postgres>;
const builtStore: typeof import("./index.ts") = await import(
	new URL("../dist/index.mjs", import.meta.url).href
);

let databaseUrl = "";
let adminClient: PostgresClient;
let testDatabase: PostgresTestDatabase | undefined;

const failureTable: Record<
	Exclude<ApplicationFoundationFailurePoint, "commit">,
	string
> = {
	agent: "platform.agents",
	application: "platform.agent_applications",
	configuration_revision: "platform.agent_configuration_revisions",
	owner: "platform.agent_owners",
	availability: "platform.agent_availability",
	idempotency: "platform.idempotency_records",
	outbox: "platform.outbox_items",
	audit: "platform.audit_events",
};

async function disarmFailure(point?: ApplicationFoundationFailurePoint) {
	if (!point) return;
	const table =
		point === "commit" ? "platform.audit_events" : failureTable[point];
	await adminClient.unsafe(`drop trigger if exists ${triggerName} on ${table}`);
	await adminClient.unsafe(`drop function if exists ${functionName}()`);
}

async function armFailure(point: ApplicationFoundationFailurePoint) {
	await adminClient.unsafe(`
		create function ${functionName}() returns trigger language plpgsql as $$
		begin
			raise exception 'injected application foundation failure';
		end
		$$
	`);
	const table =
		point === "commit" ? "platform.audit_events" : failureTable[point];
	const timing = point === "commit" ? "after" : "before";
	const constraint = point === "commit" ? "constraint " : "";
	const deferred = point === "commit" ? "deferrable initially deferred " : "";
	await adminClient.unsafe(
		`create ${constraint}trigger ${triggerName} ${timing} insert on ${table} ${deferred}for each row execute function ${functionName}()`,
	);
}

async function snapshot() {
	const [
		agents,
		applications,
		configurationRevisions,
		owners,
		availability,
		idempotencyResults,
		outboxIntents,
		auditEvents,
	] = await Promise.all([
		adminClient`
			select id as agent_id, current_configuration_revision,
				authorization_revision, created_at
			from platform.agents order by id
		`,
		adminClient`
			select id as application_id, agent_id, applicant_id, name, description,
				status, trace_id, request_id, submitted_at
			from platform.agent_applications order by id
		`,
		adminClient`
			select agent_id, revision, configuration, created_at
			from platform.agent_configuration_revisions order by agent_id, revision
		`,
		adminClient`
			select agent_id, owner_id, created_at
			from platform.agent_owners order by agent_id, owner_id
		`,
		adminClient`
			select agent_id, target_type, target_id
			from platform.agent_availability
			order by agent_id, target_type::text, target_id
		`,
		adminClient`
			select scope_id, actor_id, idempotency_key, request_digest, result,
				created_at
			from platform.idempotency_records
			where command_type = 'agent.application.submit.v1'
			order by id
		`,
		adminClient`
			select scope_type, scope_id, operation, payload, trace_id, request_id,
				available_at
			from platform.outbox_items order by id
		`,
		adminClient`
			select trace_id, request_id, agent_id, actor_type, actor_id, action,
				target_type, target_id, outcome, occurred_at
			from platform.audit_events order by id
		`,
	]);
	return {
		agents: agents.map((row) => ({
			agentId: String(row.agent_id),
			currentConfigurationRevision: Number(row.current_configuration_revision),
			authorizationRevision: String(row.authorization_revision),
			createdAt: row.created_at as Date,
		})),
		applications: applications.map((row) => ({
			applicationId: String(row.application_id),
			agentId: String(row.agent_id),
			applicantId: String(row.applicant_id),
			name: String(row.name),
			description: String(row.description),
			status: row.status as "pending_approval",
			traceId: String(row.trace_id),
			requestId: String(row.request_id),
			submittedAt: row.submitted_at as Date,
		})),
		configurationRevisions: configurationRevisions.map((row) => ({
			agentId: String(row.agent_id),
			revision: Number(row.revision),
			configuration:
				row.configuration as ApplicationFoundationWritePlanV1["configurationRevision"]["configuration"],
			createdAt: row.created_at as Date,
		})),
		owners: owners.map((row) => ({
			agentId: String(row.agent_id),
			ownerId: String(row.owner_id),
			createdAt: row.created_at as Date,
		})),
		availability: availability.map((row) => ({
			agentId: String(row.agent_id),
			target:
				row.target_type === "user"
					? { kind: "user" as const, userId: String(row.target_id) }
					: {
							kind: "organization" as const,
							organizationId: String(row.target_id),
						},
		})),
		idempotencyResults: idempotencyResults.map((row) => ({
			agentId: String(row.scope_id),
			actorId: String(row.actor_id),
			key: String(row.idempotency_key),
			requestDigest: String(row.request_digest),
			result: row.result,
			createdAt: row.created_at as Date,
		})),
		outboxIntents: outboxIntents.map((row) => ({
			scopeType: row.scope_type as "agent",
			scopeId: String(row.scope_id),
			operation: row.operation as "agent.application.submitted.v1",
			payload: row.payload as {
				schemaVersion: 1;
				applicationId: string;
				agentId: string;
				configurationRevision: 1;
			},
			traceId: String(row.trace_id),
			requestId: String(row.request_id),
			availableAt: row.available_at as Date,
		})),
		auditEvents: auditEvents.map((row) => ({
			traceId: String(row.trace_id),
			requestId: String(row.request_id),
			agentId: String(row.agent_id),
			actorType: row.actor_type as "user",
			actorId: String(row.actor_id),
			action: row.action as "agent.application.submitted",
			targetType: row.target_type as "agent_application",
			targetId: String(row.target_id),
			outcome: row.outcome as "succeeded",
			occurredAt: row.occurred_at as Date,
		})),
	};
}

async function resetDatabase(): Promise<void> {
	await adminClient`truncate platform.relay_key_versions,
		platform.relay_key_subjects, platform.audit_events, platform.outbox_items,
		platform.idempotency_records, platform.agent_availability,
		platform.agent_owners, platform.agent_configuration_revisions,
		platform.agent_applications, platform.agents,
		platform.platform_user_disables,
		platform.ldap_identity_ids,
		platform.platform_api_credentials, platform.platform_applications cascade`;
}

async function seedApiCreationAuthority() {
	await adminClient`
		insert into platform.ldap_identity_ids (issuer, uid, user_id)
		values ('fixture', 'api-recipient', ${apiRecipientUserId})
	`;
	await adminClient`
		insert into platform.platform_applications
			(id, name, responsible_user_id, status, authorization_revision)
		values ('application-caller', 'Caller', ${apiRecipientUserId}, 'active', 'app-7')
	`;
	await adminClient`
		insert into platform.platform_api_credentials
			(id, principal_type, principal_id, recipient_user_id, credential_hash, scopes)
		values ('credential-caller', 'application', 'application-caller',
			${apiRecipientUserId}, ${"a".repeat(64)},
			${adminClient.json(["agent:create"])})
	`;
	await adminClient`
		insert into platform.api_credential_delivery_grants
			(application_id, principal_type, principal_id, authorization_revision)
		values ('application-caller', 'user',
			${apiRecipientUserId}, 'app-7')
	`;
}

async function resolveApiCreationRecipient(userId: string) {
	return userId === apiRecipientUserId
		? {
				schemaVersion: 1 as const,
				userId,
				accountStatus: "active" as const,
				organizationIds: [],
				authorizationRevision: "user-revision-1",
			}
		: null;
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("application-foundation");
	databaseUrl = testDatabase.databaseUrl;
	await builtStore.migratePlatformDatabase({ databaseUrl });
	adminClient = postgres(databaseUrl, { max: 1 });
}, 120_000);

afterAll(async () => {
	await adminClient?.end();
	await testDatabase?.stop();
});

describe("PostgreSQL application foundation transaction", () => {
	applicationFoundationTransactionConformance(async () => {
		await resetDatabase();
		const adapter = new builtStore.PostgresApplicationFoundationTransactionV1({
			databaseUrl,
		});
		let armedPoint: ApplicationFoundationFailurePoint | undefined;
		const transaction: ApplicationFoundationTransactionPortV1 = {
			read: (input) => adapter.read(input),
			async commit(plan: ApplicationFoundationWritePlanV1, attachments) {
				try {
					return await adapter.commit(
						plan,
						await materializeSecretRecordFixtureAttachments(attachments),
					);
				} finally {
					await disarmFailure(armedPoint);
					armedPoint = undefined;
				}
			},
		};
		return {
			transaction,
			async failNextBefore(point) {
				armedPoint = point;
				await armFailure(point);
			},
			async advanceConfiguration() {
				const configuration = {
					...structuredClone(applicationFoundationConfigurationV1),
					revision: 2,
				};
				await adminClient.begin(async (sql) => {
					await sql`
						insert into platform.agent_configuration_revisions
							(agent_id, revision, source_reference, configuration, created_at)
						values (${applicationFoundationCommandV1.agentId}, 2, 'template_01',
							${sql.json(configuration as never)},
							${new Date("2026-08-30T12:00:00.001Z")})
					`;
					const updated = await sql`
						update platform.agents set current_configuration_revision = 2
						where id = ${applicationFoundationCommandV1.agentId}
					`;
					if (updated.count !== 1)
						throw new Error("Expected one advanced Agent");
				});
			},
			snapshot,
			async close() {
				await disarmFailure(armedPoint);
				await adapter.close();
			},
		};
	});

	it("atomically persists final pending Secret ciphertext records", async () => {
		await resetDatabase();
		const adapter = new builtStore.PostgresApplicationFoundationTransactionV1({
			databaseUrl,
		});
		try {
			const foundation = createApplicationFoundationUseCaseV1({
				transaction: adapter,
				...applicationFoundationAdmissionDependenciesV1(),
			});
			await foundation.submit(
				applicationFoundationCommandV1,
				applicationFoundationActorContextV1,
				createSecretRecordFixtureResolver(),
			);
			const records = await adminClient`
				select agent_id, secret_id, secret_version, configuration_revision,
					owner_id, name, lifecycle_state, record
				from platform.secret_records
				order by secret_id
			`;
			expect(records).toHaveLength(2);
			expect(records).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						agent_id: applicationFoundationCommandV1.agentId,
						configuration_revision: "1",
						owner_id: applicationFoundationActorContextV1.userId,
						lifecycle_state: "pending",
					}),
				]),
			);
			expect(JSON.stringify(records)).not.toContain("fixture:");
		} finally {
			await adapter.close();
		}
	});

	it("rejects malicious canonical plans before any write", async () => {
		await resetDatabase();
		const adapter = new builtStore.PostgresApplicationFoundationTransactionV1({
			databaseUrl,
		});
		const plan = await captureApplicationFoundationWritePlan();
		const malicious = [
			{
				...structuredClone(plan),
				access: {
					...structuredClone(plan.access),
					ownerIds: Array.from({ length: 257 }, (_, index) => `owner_${index}`),
				},
			},
			{
				...structuredClone(plan),
				agent: {
					...structuredClone(plan.agent),
					authorizationRevision: "",
				},
			},
		] as readonly ApplicationFoundationWritePlanV1[];
		try {
			for (const invalid of malicious) {
				await expect(adapter.commit(invalid)).rejects.toMatchObject({
					name: "ApplicationFoundationError",
					code: "persistence_failed",
				});
			}
			await expect(snapshot()).resolves.toEqual(
				emptyApplicationFoundationSnapshot,
			);
		} finally {
			await adapter.close();
		}
	});

	it("makes the initial state readable through management and configuration Interfaces", async () => {
		await resetDatabase();
		const submission =
			new builtStore.PostgresApplicationFoundationTransactionV1({
				databaseUrl,
			});
		const management = new builtStore.PostgresAgentManagementTransactionV1({
			databaseUrl,
		});
		const configuration =
			new builtStore.PostgresAgentConfigurationTransactionV1({ databaseUrl });
		const query = new builtStore.PostgresAgentConfigurationQueryV1({
			databaseUrl,
		});
		try {
			const { plan, attachments } =
				await captureApplicationFoundationSubmission();
			await expect(
				submission.commit(
					plan,
					await materializeSecretRecordFixtureAttachments(attachments),
				),
			).resolves.toMatchObject({
				outcome: "committed",
			});
			await expect(
				management.resolveAgentAccessState(plan.agent.agentId),
			).resolves.toMatchObject({
				agentId: plan.agent.agentId,
				applicationId: plan.application.applicationId,
				applicantId: plan.application.applicantId,
				status: "pending_approval",
				revision: 0,
				ownerIds: plan.access.ownerIds,
				availability: expect.arrayContaining([...plan.access.availability]),
			});
			await expect(
				configuration.read({
					schemaVersion: 1,
					agentId: plan.agent.agentId,
					actorId: plan.application.applicantId,
					idempotencyKey: "read-initial-configuration",
					requestDigest: "0".repeat(64),
				}),
			).resolves.toEqual({
				outcome: "ready",
				record: {
					schemaVersion: 1,
					configuration: plan.configurationRevision.configuration,
					authorizationRevision: plan.agent.authorizationRevision,
				},
			});
			await expect(
				query.read({
					agentId: plan.agent.agentId,
					actorId: plan.application.applicantId,
					organizationIds: [],
					isAdministrator: false,
					intent: "manage",
				}),
			).resolves.toMatchObject({
				outcome: "found",
				configuration: {
					agentId: plan.agent.agentId,
					revision: 1,
					ownerIds: plan.access.ownerIds,
					availability: plan.access.availability,
					secrets: [{ name: "BOT_TOKEN", isSet: true, version: 3 }],
				},
			});
		} finally {
			await Promise.all([
				submission.close(),
				management.close(),
				configuration.close(),
				query.close(),
			]);
		}
	});

	it("marks API-created applications eligible for workload reconciliation", async () => {
		await resetDatabase();
		await seedApiCreationAuthority();
		const submission =
			new builtStore.PostgresApplicationFoundationTransactionV1({
				databaseUrl,
				resolveUser: resolveApiCreationRecipient,
			});
		try {
			const foundation = createApplicationFoundationUseCaseV1({
				transaction: submission,
				...applicationFoundationAdmissionDependenciesV1(),
			});
			const actor = {
				...applicationFoundationActorContextV1,
				userId: apiRecipientUserId,
				principal: { kind: "application" as const, id: "application-caller" },
				creationMode: "api" as const,
				apiAuthority: {
					credentialId: "credential-caller",
					identityRevision: "app-7",
				},
			};
			const first = await foundation.submit(
				applicationFoundationCommandV1,
				actor,
				createSecretRecordFixtureResolver(),
			);
			const replayQuery = {
				schemaVersion: 1 as const,
				applicationId: applicationFoundationCommandV1.applicationId,
				agentId: applicationFoundationCommandV1.agentId,
				idempotencyKey: applicationFoundationCommandV1.idempotencyKey,
			};
			const replay = createApplicationFoundationUseCaseV1({
				transaction: submission,
				...applicationFoundationAdmissionDependenciesV1(),
				imageAdmission: {
					async admitImage() {
						throw new Error("mutable admission is unavailable");
					},
				},
			});
			await expect(
				replay.prepareApiCreation(replayQuery, actor, async () => {
					throw new Error("replay must not prepare");
				}),
			).resolves.toEqual({ outcome: "replayed", result: first });
			await expect(
				replay.prepareApiCreation(
					replayQuery,
					{ ...actor, rawRequestDigest: "c".repeat(64) },
					async () => {
						throw new Error("conflict must not prepare");
					},
				),
			).rejects.toMatchObject({ code: "idempotency_conflict" });
			const [application] = await adminClient`
				select status, management_revision, approval_revision
				from platform.agent_applications
				where id = ${applicationFoundationCommandV1.applicationId}
			`;
			expect(application).toMatchObject({
				status: "creating",
				management_revision: "1",
				approval_revision: "1",
			});
		} finally {
			await submission.close();
		}
	});

	it.each(["user", "application"] as const)(
		"accepts a current non-LDAP %s API principal without an LDAP mapping",
		async (kind) => {
			await resetDatabase();
			await seedApiCreationAuthority();
			await adminClient`
				delete from platform.ldap_identity_ids
				where user_id = ${apiRecipientUserId}
			`;
			if (kind === "user")
				await adminClient`
					insert into platform.platform_api_credentials
						(id, principal_type, principal_id, credential_hash, scopes)
					values ('credential-user-caller', 'user', ${apiRecipientUserId},
						${"b".repeat(64)}, ${adminClient.json(["agent:create"])})
				`;
			const submission =
				new builtStore.PostgresApplicationFoundationTransactionV1({
					databaseUrl,
					resolveUser: resolveApiCreationRecipient,
				});
			const actor = {
				...applicationFoundationActorContextV1,
				userId: apiRecipientUserId,
				principal:
					kind === "user"
						? { kind, id: apiRecipientUserId }
						: { kind, id: "application-caller" },
				creationMode: "api" as const,
				apiAuthority: {
					credentialId:
						kind === "user" ? "credential-user-caller" : "credential-caller",
					identityRevision: kind === "user" ? "user-revision-1" : "app-7",
				},
			};
			try {
				const foundation = createApplicationFoundationUseCaseV1({
					transaction: submission,
					...applicationFoundationAdmissionDependenciesV1(),
				});
				await expect(
					foundation.submit(
						applicationFoundationCommandV1,
						actor,
						createSecretRecordFixtureResolver(),
					),
				).resolves.toMatchObject({ status: "creating" });
				await expect(
					adminClient`
						select id from platform.agents
						where id = ${applicationFoundationCommandV1.agentId}
					`,
				).resolves.toHaveLength(1);
			} finally {
				await submission.close();
			}
		},
	);

	it("commits the Agent default Relay Key with API creation and rolls it back on audit failure", async () => {
		await resetDatabase();
		await seedApiCreationAuthority();
		const { modelConfiguration: _legacyModel, ...keylessCommand } =
			applicationFoundationCommandV1;
		const runtime = {
			schemaVersion: 4,
			configVersion: "synthetic-keyless-v4",
			defaultModelOptionId: "model_primary",
			defaultReasoningLevel: "low",
			modelOptions: [
				{
					modelOptionId: "model_primary",
					endpoint: "https://relay.example/v1",
					model: "gpt-5",
					reasoningLevels: ["low"],
					protocol: "openai-responses-v1",
					authentication: "bearer",
				},
			],
		};
		const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
		const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
		const encryptor = createRelayKeyEncryptorV1({
			encryptionKeys: {
				schemaVersion: 1,
				activeWrappingKeyVersion: "test-wrapping-key",
				keys: [
					{
						schemaVersion: 1,
						keyVersion: "test-wrapping-key",
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						publicKeySpkiDerBase64: publicKeyDer.toString("base64"),
						publicKeyFingerprint: createHash("sha256")
							.update(publicKeyDer)
							.digest("hex"),
						rsaModulusBits: 3072,
						status: "active",
					},
				],
			},
		});
		const keyValue = "synthetic-agent-default-key";
		let encryptions = 0;
		const keyAttachment = {
			admitModels: async () => ({
				catalogRevision: "catalog_1",
				runtime,
			}),
			encrypt: (binding: {
				readonly purpose: "agent-default";
				readonly subjectId: string;
				readonly keyId: string;
				readonly keyVersion: 1;
			}) => {
				encryptions += 1;
				return encryptor.encrypt({ ...binding, plaintext: keyValue });
			},
		};
		const submission =
			new builtStore.PostgresApplicationFoundationTransactionV1({
				databaseUrl,
				resolveUser: resolveApiCreationRecipient,
			});
		const foundation = createApplicationFoundationUseCaseV1({
			transaction: submission,
			...applicationFoundationAdmissionDependenciesV1(),
		});
		const actor = {
			...applicationFoundationActorContextV1,
			userId: apiRecipientUserId,
			principal: { kind: "application" as const, id: "application-caller" },
			creationMode: "api" as const,
			apiAuthority: {
				credentialId: "credential-caller",
				identityRevision: "app-7",
			},
		};
		try {
			const first = await foundation.submit(
				keylessCommand,
				actor,
				createSecretRecordFixtureResolver(),
				keyAttachment,
			);
			expect(first.status).toBe("creating");
			const [key] = await adminClient`
				select s.purpose, s.subject_id, s.last_version, s.current_version,
					v.key_id, v.key_version, v.ciphertext
				from platform.relay_key_subjects s
				join platform.relay_key_versions v
					on v.purpose = s.purpose and v.subject_id = s.subject_id
				where s.subject_id = ${first.agentId}
			`;
			expect(key).toMatchObject({
				purpose: "agent-default",
				subject_id: first.agentId,
				last_version: "1",
				current_version: "1",
				key_version: "1",
				ciphertext: {
					purpose: "agent-default",
					subjectId: first.agentId,
					keyVersion: 1,
					keyId: key?.key_id,
				},
			});
			expect(JSON.stringify(key)).not.toContain(keyValue);
			const [storedConfiguration] = await adminClient`
				select configuration from platform.agent_configuration_revisions
				where agent_id = ${first.agentId} and revision = 1
			`;
			expect(storedConfiguration?.configuration).toMatchObject({
				modelConfiguration: null,
				modelCatalogRevision: "catalog_1",
				runtimeModelConfigurationV4: runtime,
			});
			expect(
				await adminClient`select name from platform.secret_records
				where agent_id = ${first.agentId} and name like 'model:%'`,
			).toEqual([]);
			expect(
				await adminClient`select action, actor_type, actor_id, details
				from platform.audit_events
				where action = 'relay_key.agent_default.created'`,
			).toEqual([
				{
					action: "relay_key.agent_default.created",
					actor_type: "application",
					actor_id: "application-caller",
					details: { keyVersion: 1 },
				},
			]);
			const keys = new PostgresAgentDefaultRelayKeyStoreV1(
				databaseUrl,
				async (userId) => ({
					userId,
					accountStatus: "active",
					authorizationRevision: "user-revision-1",
				}),
				encryptor,
			);
			try {
				const metadata = {
					traceId: "replacement-trace",
					requestId: "replacement-request",
				};
				expect(
					await keys.current({
						agentId: first.agentId,
						actorUserId: apiRecipientUserId,
						...metadata,
					}),
				).toMatchObject({ keyVersion: 1, configurationRevision: 1 });
				expect(
					await keys.current({
						agentId: first.agentId,
						actorUserId: "other-user",
						...metadata,
					}),
				).toBeNull();
				expect(
					await keys.replace({
						agentId: first.agentId,
						actorUserId: apiRecipientUserId,
						expectedVersion: 1,
						expectedConfigurationRevision: 1,
						keyValue: "synthetic-replacement-key",
						...metadata,
					}),
				).toBe(2);
				expect(
					await keys.replace({
						agentId: first.agentId,
						actorUserId: apiRecipientUserId,
						expectedVersion: 1,
						expectedConfigurationRevision: 1,
						keyValue: "stale-replacement-key",
						...metadata,
					}),
				).toBeNull();
				const [agentAuthorization] = await adminClient<
					{ authorization_revision: string }[]
				>`select authorization_revision from platform.agents
					where id = ${first.agentId}`;
				if (!agentAuthorization?.authorization_revision)
					throw new Error("Agent authorization revision is missing");
				await adminClient`
					insert into platform.platform_api_credentials
						(id, principal_type, principal_id, credential_hash, scopes)
					values ('credential-owner', 'user', ${apiRecipientUserId},
						${"b".repeat(64)}, ${adminClient.json(["agent:manage"])})
				`;
				await adminClient`
					insert into platform.agent_principal_grants
						(agent_id, principal_type, principal_id, grant_type,
						 authorization_revision)
					values (${first.agentId}, 'user', ${apiRecipientUserId}, 'manage',
						${agentAuthorization.authorization_revision})
				`;
				const api = {
					credentialId: "credential-owner",
					identityRevision: "user-revision-1",
				};
				expect(
					await keys.current({
						agentId: first.agentId,
						actorUserId: apiRecipientUserId,
						api,
						...metadata,
					}),
				).toMatchObject({ keyVersion: 2 });
				await adminClient`
					update platform.agent_principal_grants set revoked_at = now()
					where agent_id = ${first.agentId} and principal_type = 'user'
						and principal_id = ${apiRecipientUserId} and grant_type = 'manage'
				`;
				expect(
					await keys.current({
						agentId: first.agentId,
						actorUserId: apiRecipientUserId,
						api,
						...metadata,
					}),
				).toBeNull();
				await expect(
					keys.replace({
						agentId: first.agentId,
						actorUserId: apiRecipientUserId,
						api,
						expectedVersion: 2,
						expectedConfigurationRevision: 1,
						keyValue: "revoked-owner-key",
						...metadata,
					}),
				).rejects.toMatchObject({ code: "resource_unavailable" });
				const versions = await adminClient`
					select key_version, ciphertext from platform.relay_key_versions
					where purpose = 'agent-default' and subject_id = ${first.agentId}
					order by key_version
				`;
				expect(versions.map((version) => version.key_version)).toEqual([
					"1",
					"2",
				]);
				expect(JSON.stringify(versions)).not.toContain(
					"synthetic-replacement-key",
				);
				const replacementAudits = await adminClient`
						select action, outcome from platform.audit_events
						where target_id = ${first.agentId}
						and action in ('relay_key.agent_default.replaced', 'relay_key.agent_default.rejected')
					`;
				expect(replacementAudits).toHaveLength(2);
				expect(replacementAudits).toContainEqual({
					action: "relay_key.agent_default.replaced",
					outcome: "succeeded",
				});
				expect(replacementAudits).toContainEqual({
					action: "relay_key.agent_default.rejected",
					outcome: "rejected",
				});
			} finally {
				await keys.close();
			}
			await expect(
				foundation.submit(
					keylessCommand,
					actor,
					createSecretRecordFixtureResolver(),
					{
						admitModels: () => {
							throw new Error("replay admitted twice");
						},
						encrypt: () => {
							throw new Error("replay encrypted twice");
						},
					},
				),
			).resolves.toEqual(first);
			expect(encryptions).toBe(1);

			await resetDatabase();
			await seedApiCreationAuthority();
			await armFailure("audit");
			await expect(
				foundation.submit(
					keylessCommand,
					actor,
					createSecretRecordFixtureResolver(),
					keyAttachment,
				),
			).rejects.toMatchObject({ code: "persistence_failed" });
			for (const table of [
				"agents",
				"relay_key_subjects",
				"relay_key_versions",
				"idempotency_records",
			]) {
				expect(
					await adminClient.unsafe(`select * from platform.${table}`),
				).toEqual([]);
			}
		} finally {
			await disarmFailure("audit");
			await submission.close();
		}
	});

	it.each([
		["disabled", { accountStatus: "disabled" as const }],
		["stale directory revision", { authorizationRevision: "user-revision-2" }],
	])(
		"rejects API user creation when the current directory is %s before commit",
		async (_label, change) => {
			await resetDatabase();
			await adminClient`
				insert into platform.ldap_identity_ids (issuer, uid, user_id)
				values ('fixture', 'api-recipient', ${apiRecipientUserId})
			`;
			await adminClient`
				insert into platform.platform_api_credentials
					(id, principal_type, principal_id, credential_hash, scopes)
				values ('credential-user-caller', 'user', ${apiRecipientUserId}, ${"b".repeat(64)}, ${adminClient.json(["agent:create"])})
			`;
			let currentUser: Record<string, unknown> = {
				schemaVersion: 1,
				userId: apiRecipientUserId,
				accountStatus: "active",
				organizationIds: [],
				authorizationRevision: "user-revision-1",
			};
			const submission =
				new builtStore.PostgresApplicationFoundationTransactionV1({
					databaseUrl,
					resolveUser: async () => currentUser,
				});
			try {
				const foundation = createApplicationFoundationUseCaseV1({
					...applicationFoundationAdmissionDependenciesV1(),
					transaction: {
						read: (input) => submission.read(input),
						commit(plan, attachments) {
							currentUser = { ...currentUser, ...change };
							return submission.commit(plan, attachments);
						},
					},
				});
				await expect(
					foundation.submit(
						{
							...applicationFoundationCommandV1,
							applicationId: `application-user-${_label.replaceAll(" ", "-")}`,
							agentId: `agent-user-${_label.replaceAll(" ", "-")}`,
							idempotencyKey: `user-${_label.replaceAll(" ", "-")}`,
						},
						{
							...applicationFoundationActorContextV1,
							userId: apiRecipientUserId,
							principal: { kind: "user", id: apiRecipientUserId },
							creationMode: "api",
							apiAuthority: {
								credentialId: "credential-user-caller",
								identityRevision: "user-revision-1",
							},
						},
						createSecretRecordFixtureResolver(),
					),
				).rejects.toMatchObject({ code: "not_authorized" });
				await expect(
					adminClient`select id from platform.agents where id like 'agent-user-%'`,
				).resolves.toEqual([]);
			} finally {
				await submission.close();
			}
		},
	);

	it("rejects an API replay after its credential is revoked", async () => {
		await resetDatabase();
		await seedApiCreationAuthority();
		const submission =
			new builtStore.PostgresApplicationFoundationTransactionV1({
				databaseUrl,
				resolveUser: resolveApiCreationRecipient,
			});
		const actor = {
			...applicationFoundationActorContextV1,
			userId: apiRecipientUserId,
			principal: { kind: "application" as const, id: "application-caller" },
			creationMode: "api" as const,
			apiAuthority: {
				credentialId: "credential-caller",
				identityRevision: "app-7",
			},
		};
		try {
			const foundation = createApplicationFoundationUseCaseV1({
				transaction: submission,
				...applicationFoundationAdmissionDependenciesV1(),
			});
			await foundation.submit(
				applicationFoundationCommandV1,
				actor,
				createSecretRecordFixtureResolver(),
			);
			await adminClient`
				update platform.platform_api_credentials
				set revoked_at = clock_timestamp()
				where id = 'credential-caller'
			`;
			await expect(
				foundation.prepareApiCreation(
					{
						schemaVersion: 1,
						applicationId: applicationFoundationCommandV1.applicationId,
						agentId: applicationFoundationCommandV1.agentId,
						idempotencyKey: applicationFoundationCommandV1.idempotencyKey,
					},
					actor,
					async () => {
						throw new Error("revoked authority must not prepare");
					},
				),
			).rejects.toMatchObject({ code: "not_authorized" });
			await expect(
				foundation.submit(
					applicationFoundationCommandV1,
					actor,
					createSecretRecordFixtureResolver(),
				),
			).rejects.toMatchObject({ code: "not_authorized" });
			const [counts] = await adminClient`
				select
					(select count(*) from platform.agents) as agents,
					(select count(*) from platform.agent_applications) as applications,
					(select count(*) from platform.idempotency_records
						where command_type = 'agent.application.submit.v1') as reservations
			`;
			expect(counts).toEqual({
				agents: "1",
				applications: "1",
				reservations: "1",
			});
		} finally {
			await submission.close();
		}
	});

	it("orders creation locks before concurrent delivery and credential revocation", async () => {
		await resetDatabase();
		await seedApiCreationAuthority();
		const submission =
			new builtStore.PostgresApplicationFoundationTransactionV1({
				databaseUrl,
				resolveUser: resolveApiCreationRecipient,
			});
		const revoker = postgres(databaseUrl, { max: 1 });
		let markLocked: (() => void) | undefined;
		const locked = new Promise<void>((resolve) => {
			markLocked = resolve;
		});
		let allowRevocation: (() => void) | undefined;
		const revokeNow = new Promise<void>((resolve) => {
			allowRevocation = resolve;
		});
		const revocation = Promise.resolve(
			revoker.begin(async (transaction) => {
				await transaction`set local lock_timeout = '3s'`;
				await transaction`select id from platform.platform_applications where id = 'application-caller' for update`;
				markLocked?.();
				await revokeNow;
				// Both delivery mutations serialize via the application before credentials.
				await transaction`update platform.platform_api_credentials set revoked_at = clock_timestamp() where id = 'credential-caller'`;
				await transaction`update platform.api_credential_delivery_grants set revoked_at = clock_timestamp() where application_id = 'application-caller'`;
			}),
		);
		let pending:
			| ReturnType<ApplicationFoundationTransactionPortV1["read"]>
			| undefined;
		try {
			await locked;
			pending = submission.read({
				schemaVersion: 1,
				applicationId: applicationFoundationCommandV1.applicationId,
				agentId: applicationFoundationCommandV1.agentId,
				actorId: "application-caller",
				principal: { kind: "application", id: "application-caller" },
				applicantId: apiRecipientUserId,
				apiAuthority: {
					credentialId: "credential-caller",
					identityRevision: "app-7",
				},
				idempotencyKey: "creation-delivery-race",
				requestDigest: "a".repeat(64),
			});
			// Observe the actual blocked application lock before the revoker touches credentials.
			let creationBlocked = false;
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const rows = await adminClient<
					{ query: string }[]
				>`select query from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
				if (
					rows.some(
						({ query }) =>
							query.includes('"platform_applications"') &&
							query.includes("for share"),
					)
				) {
					creationBlocked = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(creationBlocked).toBe(true);
			allowRevocation?.();
			await revocation;
			await expect(pending).rejects.toMatchObject({ code: "not_authorized" });
			expect(await adminClient`select id from platform.agents`).toEqual([]);
		} finally {
			allowRevocation?.();
			await revocation.catch(() => undefined);
			await pending?.catch(() => undefined);
			await revoker.end();
			await submission.close();
		}
	});

	it("rejects a creating plan without a proven principal", async () => {
		await resetDatabase();
		const adapter = new builtStore.PostgresApplicationFoundationTransactionV1({
			databaseUrl,
		});
		const { plan, attachments } =
			await captureApplicationFoundationSubmission();
		const invalid = {
			...structuredClone(plan),
			application: { ...structuredClone(plan.application), status: "creating" },
			result: { ...structuredClone(plan.result), status: "creating" },
			auditEvent: {
				...structuredClone(plan.auditEvent),
				actorType: "application",
				actorId: "application-caller",
			},
			principal: undefined,
			apiAuthority: undefined,
		} satisfies ApplicationFoundationWritePlanV1;
		try {
			await expect(adapter.commit(invalid, attachments)).rejects.toMatchObject({
				code: "persistence_failed",
			});
			await expect(
				adminClient`select id from platform.agents`,
			).resolves.toEqual([]);
		} finally {
			await adapter.close();
		}
	});

	it.each([
		"credential revoked",
		"credential principal mismatch",
		"scope narrowed",
		"application disabled",
		"recipient disabled",
		"delivery revoked",
		"platform disabled",
		"recipient unmapped",
	])(
		"rejects API creation when %s after admission but before commit",
		async (change) => {
			await resetDatabase();
			await seedApiCreationAuthority();
			let recipientStatus: "active" | "disabled" = "active";
			const submission =
				new builtStore.PostgresApplicationFoundationTransactionV1({
					databaseUrl,
					resolveUser: async (userId) => {
						const [mapping] = await adminClient`
							select user_id from platform.ldap_identity_ids
							where user_id = ${userId}
						`;
						if (!mapping) return null;
						const recipient = await resolveApiCreationRecipient(userId);
						return (
							recipient && { ...recipient, accountStatus: recipientStatus }
						);
					},
				});
			try {
				const foundation = createApplicationFoundationUseCaseV1({
					...applicationFoundationAdmissionDependenciesV1(),
					transaction: {
						read: (input) => submission.read(input),
						async commit(plan, attachments) {
							if (change === "credential revoked")
								await adminClient`
								update platform.platform_api_credentials
								set revoked_at = clock_timestamp()
								where id = 'credential-caller'
							`;
							else if (change === "credential principal mismatch")
								await adminClient`
								update platform.platform_api_credentials
								set principal_id = 'other-application'
								where id = 'credential-caller'
							`;
							else if (change === "scope narrowed")
								await adminClient`
								update platform.platform_api_credentials
								set scopes = ${adminClient.json(["agent:read"])}
								where id = 'credential-caller'
							`;
							else if (change === "recipient disabled")
								recipientStatus = "disabled";
							else if (change === "delivery revoked")
								await adminClient`
								update platform.api_credential_delivery_grants
								set revoked_at = clock_timestamp()
								where application_id = 'application-caller'
								`;
							else if (change === "platform disabled")
								await adminClient`
								insert into platform.platform_user_disables (user_id, disabled_by)
								values (${apiRecipientUserId}, 'administrator')
								`;
							else if (change === "recipient unmapped")
								await adminClient`
								delete from platform.ldap_identity_ids
								where user_id = ${apiRecipientUserId}
								`;
							else
								await adminClient`
								update platform.platform_applications
								set status = 'disabled'
								where id = 'application-caller'
							`;
							return submission.commit(plan, attachments);
						},
					},
				});
				await expect(
					foundation.submit(
						applicationFoundationCommandV1,
						{
							...applicationFoundationActorContextV1,
							userId: apiRecipientUserId,
							principal: { kind: "application", id: "application-caller" },
							creationMode: "api",
							apiAuthority: {
								credentialId: "credential-caller",
								identityRevision: "app-7",
							},
						},
						createSecretRecordFixtureResolver(),
					),
				).rejects.toMatchObject({ code: "not_authorized" });
				const [counts] = await adminClient`
				select (select count(*) from platform.agents) as agents,
					(select count(*) from platform.idempotency_records
						where command_type = 'agent.application.submit.v1') as reservations
			`;
				expect(counts).toMatchObject({ agents: "0", reservations: "0" });
			} finally {
				await submission.close();
			}
		},
	);

	it("serializes concurrent exact submissions into one commit and one replay", async () => {
		await resetDatabase();
		const first = new builtStore.PostgresApplicationFoundationTransactionV1({
			databaseUrl,
		});
		const second = new builtStore.PostgresApplicationFoundationTransactionV1({
			databaseUrl,
		});
		try {
			const { plan, attachments } =
				await captureApplicationFoundationSubmission();
			const decisions = await Promise.all([
				first.commit(
					structuredClone(plan),
					await materializeSecretRecordFixtureAttachments(attachments),
				),
				second.commit(
					structuredClone(plan),
					await materializeSecretRecordFixtureAttachments(attachments),
				),
			]);
			expect(decisions.map(({ outcome }) => outcome).toSorted()).toEqual([
				"committed",
				"replayed",
			]);
			const state = await snapshot();
			expect(state.agents).toHaveLength(1);
			expect(state.configurationRevisions).toHaveLength(1);
			expect(state.idempotencyResults).toHaveLength(1);
			expect(state.outboxIntents).toHaveLength(1);
			expect(state.auditEvents).toHaveLength(1);
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});
});
