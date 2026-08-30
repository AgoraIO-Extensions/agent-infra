import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type {
	ApplicationFoundationTransactionV1,
	CommitApplicationFoundationCommandV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe } from "vitest";

import {
	type ApplicationFoundationFailurePoint,
	applicationFoundationTransactionConformance,
} from "../../platform-core/src/application-foundation.conformance.ts";

const execFile = promisify(execFileCallback);
const postgresImage =
	"postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416";
const username = "platform_test";
const password = "platform_test_password";
const database = "platform_test";
const triggerName = "application_foundation_injected_failure";
const functionName = "platform.application_foundation_injected_failure";
type PostgresClient = ReturnType<typeof postgres>;
const builtStore: typeof import("./index.ts") = await import(
	new URL("../dist/index.mjs", import.meta.url).href
);

let containerName = "";
let databaseUrl = "";
let adminClient: PostgresClient;

async function removeContainer(): Promise<void> {
	if (containerName) {
		await execFile("docker", ["rm", "--force", containerName]).catch(() => {});
	}
}

async function startPostgres(): Promise<string> {
	containerName = `agent-infra-application-foundation-${randomUUID()}`;
	await execFile("docker", [
		"run",
		"--detach",
		"--rm",
		"--name",
		containerName,
		"--env",
		`POSTGRES_USER=${username}`,
		"--env",
		`POSTGRES_PASSWORD=${password}`,
		"--env",
		`POSTGRES_DB=${database}`,
		"--publish",
		"127.0.0.1::5432",
		postgresImage,
	]);
	const { stdout } = await execFile("docker", [
		"port",
		containerName,
		"5432/tcp",
	]);
	const port = stdout.trim().match(/:(\d+)$/)?.[1];
	if (!port)
		throw new Error("PostgreSQL test container did not publish a port");
	const url = `postgres://${username}:${password}@127.0.0.1:${port}/${database}`;

	for (let attempt = 0; attempt < 80; attempt += 1) {
		const client = postgres(url, { connect_timeout: 1, max: 1 });
		try {
			await client`select 1`;
			await client.end();
			return url;
		} catch {
			await client.end({ timeout: 0 });
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error("PostgreSQL test container did not become ready");
}

const failureTable: Record<
	Exclude<ApplicationFoundationFailurePoint, "commit">,
	string
> = {
	agent: "platform.agents",
	application: "platform.agent_applications",
	configuration_revision: "platform.agent_configuration_revisions",
	owner: "platform.agent_owners",
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
		outboxIntents,
		auditEvents,
	] = await Promise.all([
		adminClient`
			select id as agent_id, current_configuration_revision
			from platform.agents order by id
		`,
		adminClient`
			select id as application_id, agent_id, applicant_id, name, description,
				status, trace_id
			from platform.agent_applications order by id
		`,
		adminClient`
			select agent_id, revision, source_reference
			from platform.agent_configuration_revisions order by agent_id, revision
		`,
		adminClient`
			select agent_id, owner_id
			from platform.agent_owners order by agent_id, owner_id
		`,
		adminClient`
			select scope_type, scope_id, operation, payload, trace_id
			from platform.outbox_items order by id
		`,
		adminClient`
			select trace_id, actor_type, actor_id, action, target_type, target_id, outcome
			from platform.audit_events order by id
		`,
	]);
	return {
		agents: agents.map((row) => ({
			agentId: String(row.agent_id),
			currentConfigurationRevision: Number(row.current_configuration_revision),
		})),
		applications: applications.map((row) => ({
			applicationId: String(row.application_id),
			agentId: String(row.agent_id),
			applicantId: String(row.applicant_id),
			name: String(row.name),
			description: String(row.description),
			status: row.status as "pending_approval",
			traceId: String(row.trace_id),
		})),
		configurationRevisions: configurationRevisions.map((row) => ({
			agentId: String(row.agent_id),
			revision: Number(row.revision),
			sourceReference: String(row.source_reference),
		})),
		owners: owners.map((row) => ({
			agentId: String(row.agent_id),
			ownerId: String(row.owner_id),
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
		})),
		auditEvents: auditEvents.map((row) => ({
			traceId: String(row.trace_id),
			actorType: row.actor_type as "user",
			actorId: String(row.actor_id),
			action: row.action as "agent.application.submitted",
			targetType: row.target_type as "agent_application",
			targetId: String(row.target_id),
			outcome: row.outcome as "succeeded",
		})),
	};
}

beforeAll(async () => {
	databaseUrl = await startPostgres().catch(async (error) => {
		await removeContainer();
		throw error;
	});
	await builtStore.migratePlatformDatabase({ databaseUrl });
	adminClient = postgres(databaseUrl, { max: 1 });
}, 120_000);

afterAll(async () => {
	await adminClient?.end();
	await removeContainer();
});

describe("PostgreSQL application foundation transaction", () => {
	applicationFoundationTransactionConformance(async () => {
		await adminClient`truncate platform.audit_events, platform.outbox_items,
			platform.agent_owners, platform.agent_configuration_revisions,
			platform.agent_applications, platform.agents cascade`;
		const adapter = new builtStore.PostgresApplicationFoundationTransactionV1({
			databaseUrl,
		});
		let armedPoint: ApplicationFoundationFailurePoint | undefined;
		const transaction: ApplicationFoundationTransactionV1 = {
			async commit(command: CommitApplicationFoundationCommandV1) {
				try {
					return await adapter.commit(command);
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
			snapshot,
			async close() {
				await disarmFailure(armedPoint);
				await adapter.close();
			},
		};
	});
});
