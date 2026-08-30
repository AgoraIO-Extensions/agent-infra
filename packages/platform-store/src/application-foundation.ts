import { randomUUID } from "node:crypto";

import {
	ApplicationFoundationError,
	type ApplicationFoundationTransactionV1,
	assertApplicationFoundationCommandV1,
	type CommitApplicationFoundationCommandV1,
	type CommitApplicationFoundationResultV1,
} from "@agent-infra/platform-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

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
	implements ApplicationFoundationTransactionV1
{
	readonly #client;
	readonly #database;

	constructor(options: PostgresApplicationFoundationOptions) {
		this.#client = postgres(options.databaseUrl, { max: 10 });
		this.#database = drizzle(this.#client);
	}

	async commit(
		command: CommitApplicationFoundationCommandV1,
	): Promise<CommitApplicationFoundationResultV1> {
		assertApplicationFoundationCommandV1(command);
		try {
			return await this.#database.transaction(async (transaction) => {
				await transaction.insert(agents).values({
					id: command.agentId,
					currentConfigurationRevision: 1,
					createdAt: command.submittedAt,
				});
				await transaction.insert(agentApplications).values({
					id: command.applicationId,
					agentId: command.agentId,
					applicantId: command.applicantId,
					name: command.name,
					description: command.description,
					status: "pending_approval",
					traceId: command.traceId,
					submittedAt: command.submittedAt,
				});
				await transaction.insert(agentConfigurationRevisions).values({
					agentId: command.agentId,
					revision: 1,
					sourceReference: command.sourceReference,
					createdAt: command.submittedAt,
				});
				await transaction.insert(agentOwners).values({
					agentId: command.agentId,
					ownerId: command.applicantId,
					createdAt: command.submittedAt,
				});
				await transaction.insert(outboxItems).values({
					id: randomUUID(),
					scopeType: "agent",
					scopeId: command.agentId,
					operation: "agent.application.submitted.v1",
					payload: {
						schemaVersion: 1,
						applicationId: command.applicationId,
						agentId: command.agentId,
						configurationRevision: 1,
					},
					traceId: command.traceId,
					availableAt: command.submittedAt,
					createdAt: command.submittedAt,
					updatedAt: command.submittedAt,
				});
				await transaction.insert(auditEvents).values({
					id: randomUUID(),
					traceId: command.traceId,
					actorType: "user",
					actorId: command.applicantId,
					action: "agent.application.submitted",
					targetType: "agent_application",
					targetId: command.applicationId,
					outcome: "succeeded",
					occurredAt: command.submittedAt,
				});
				return {
					schemaVersion: 1,
					applicationId: command.applicationId,
					agentId: command.agentId,
					configurationRevision: 1,
					status: "pending_approval",
				};
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

function isPostgresError(error: unknown, code: string): boolean {
	let current = error;
	for (let depth = 0; depth < 4; depth += 1) {
		if (typeof current !== "object" || current === null) return false;
		if ("code" in current && current.code === code) return true;
		current = "cause" in current ? current.cause : undefined;
	}
	return false;
}
