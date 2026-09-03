import type {
	ApplicationFoundationTransactionPortV1,
	ApplicationFoundationWritePlanV1,
} from "@agent-infra/platform-core";
import { createApplicationFoundationUseCaseV1 } from "@agent-infra/platform-core";
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
	await adminClient`truncate platform.audit_events, platform.outbox_items,
		platform.idempotency_records, platform.agent_availability,
		platform.agent_owners, platform.agent_configuration_revisions,
		platform.agent_applications, platform.agents cascade`;
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
