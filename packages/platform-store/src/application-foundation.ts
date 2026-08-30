import { randomUUID } from "node:crypto";

import {
	ApplicationFoundationError,
	type ApplicationFoundationTransactionPortV1,
	type ApplicationFoundationWritePlanV1,
} from "@agent-infra/platform-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { isPostgresError } from "./postgres-error.js";
import {
	agentApplications,
	agentConfigurationRevisions,
	agentOwners,
	agents,
	auditEvents,
	outboxItems,
} from "./schema.js";

export interface PostgresApplicationFoundationOptions {
	readonly databaseUrl: string;
}

export class PostgresApplicationFoundationTransactionV1
	implements ApplicationFoundationTransactionPortV1
{
	readonly #client;
	readonly #database;

	constructor(options: PostgresApplicationFoundationOptions) {
		this.#client = postgres(options.databaseUrl, { max: 10 });
		this.#database = drizzle(this.#client);
	}

	async commit(plan: ApplicationFoundationWritePlanV1): Promise<void> {
		try {
			await this.#database.transaction(async (transaction) => {
				await transaction.insert(agents).values({
					id: plan.agent.agentId,
					currentConfigurationRevision: plan.agent.currentConfigurationRevision,
					createdAt: plan.agent.createdAt,
				});
				await transaction.insert(agentApplications).values({
					id: plan.application.applicationId,
					agentId: plan.application.agentId,
					applicantId: plan.application.applicantId,
					name: plan.application.name,
					description: plan.application.description,
					status: plan.application.status,
					traceId: plan.application.traceId,
					requestId: plan.application.requestId,
					submittedAt: plan.application.submittedAt,
				});
				await transaction.insert(agentConfigurationRevisions).values({
					agentId: plan.configurationRevision.agentId,
					revision: plan.configurationRevision.revision,
					sourceReference: plan.configurationRevision.sourceReference,
					createdAt: plan.configurationRevision.createdAt,
				});
				await transaction.insert(agentOwners).values({
					agentId: plan.owner.agentId,
					ownerId: plan.owner.ownerId,
					createdAt: plan.owner.createdAt,
				});
				await transaction.insert(outboxItems).values({
					id: randomUUID(),
					scopeType: plan.outboxIntent.scopeType,
					scopeId: plan.outboxIntent.scopeId,
					operation: plan.outboxIntent.operation,
					payload: plan.outboxIntent.payload,
					traceId: plan.outboxIntent.traceId,
					requestId: plan.outboxIntent.requestId,
					availableAt: plan.outboxIntent.occurredAt,
					createdAt: plan.outboxIntent.occurredAt,
					updatedAt: plan.outboxIntent.occurredAt,
				});
				await transaction.insert(auditEvents).values({
					id: randomUUID(),
					traceId: plan.auditEvent.traceId,
					requestId: plan.auditEvent.requestId,
					agentId: plan.auditEvent.agentId,
					actorType: plan.auditEvent.actorType,
					actorId: plan.auditEvent.actorId,
					action: plan.auditEvent.action,
					targetType: plan.auditEvent.targetType,
					targetId: plan.auditEvent.targetId,
					outcome: plan.auditEvent.outcome,
					occurredAt: plan.auditEvent.occurredAt,
				});
			});
		} catch (error) {
			if (isPostgresError(error, "23505")) {
				throw new ApplicationFoundationError("conflict");
			}
			throw new ApplicationFoundationError("persistence_failed");
		}
	}

	async close(): Promise<void> {
		await this.#client.end();
	}
}
