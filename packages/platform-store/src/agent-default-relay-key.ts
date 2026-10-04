import { randomUUID } from "node:crypto";
import {
	type AgentDefaultRelayKeyAuditV1,
	type AgentDefaultRelayKeyDependenciesV1,
	AgentDefaultRelayKeyErrorV1,
	type AgentDefaultRelayKeyTransactionV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import {
	currentRelayKeyVersionInTransaction,
	replaceRelayKeyVersionInTransaction,
} from "./relay-key-versions.js";

async function audit(
	sql: postgres.TransactionSql,
	event: AgentDefaultRelayKeyAuditV1,
) {
	const details = {
		schemaVersion: 1,
		...(event.reason === undefined ? {} : { reason: event.reason }),
		...(event.configurationRevision === undefined
			? {}
			: { configurationRevision: event.configurationRevision }),
		...(event.previousVersion === undefined
			? {}
			: { previousVersion: event.previousVersion }),
		...(event.keyVersion === undefined ? {} : { keyVersion: event.keyVersion }),
	};
	await sql`insert into platform.audit_events (id, trace_id, request_id, actor_type, actor_id, action, target_type, target_id, outcome, details)
	values (${randomUUID()}, ${event.traceId}, ${event.requestId}, 'user', ${event.userId}, ${`relay_key.agent_default.${event.operation}`}, 'agent', ${event.agentId}, ${event.outcome}, ${sql.json(details)})`;
}
function operations(
	sql: postgres.TransactionSql,
): AgentDefaultRelayKeyTransactionV1 {
	return {
		async ownedConfiguration(request) {
			// Same D-first order as credential governance; Agent lock serializes Owner/config edits.
			await sql`lock table platform.platform_user_disables in share mode`;
			const disabled =
				await sql`select user_id from platform.platform_user_disables where user_id = ${request.userId}`;
			if (disabled.length) return null;
			const agents =
				await sql`select current_configuration_revision from platform.agents where id = ${request.agentId} for update`;
			if (!agents.length) return null;
			const owners =
				await sql`select owner_id from platform.agent_owners where agent_id = ${request.agentId} and owner_id = ${request.userId} for share`;
			if (!owners.length) return null;
			const rows =
				await sql`select configuration from platform.agent_configuration_revisions where agent_id = ${request.agentId} and revision = ${agents[0]?.current_configuration_revision}`;
			if (!rows[0]) throw new AgentDefaultRelayKeyErrorV1("unavailable");
			const configuration = decodeAgentConfigurationRecord(
				rows[0].configuration,
			);
			if (
				configuration.agentId !== request.agentId ||
				configuration.revision !==
					Number(agents[0]?.current_configuration_revision)
			)
				throw new AgentDefaultRelayKeyErrorV1("unavailable");
			return configuration;
		},
		async current(agentId) {
			return (
				(
					await currentRelayKeyVersionInTransaction(sql, {
						purpose: "agent-default",
						subjectId: agentId,
					})
				)?.keyVersion ?? null
			);
		},
		async replace(agentId, expectedVersion, encrypt) {
			const result = await replaceRelayKeyVersionInTransaction(sql, {
				purpose: "agent-default",
				subjectId: agentId,
				expectedCurrentVersion: expectedVersion,
				encrypt: (binding) => encrypt({ ...binding, purpose: "agent-default" }),
			});
			return result.outcome === "replaced" ? result.binding.keyVersion : null;
		},
		audit: (event) => audit(sql, event),
	};
}
/** Uses the original Relay Key tables and configuration authority; no second repository. */
type TransactionPort = AgentDefaultRelayKeyDependenciesV1["transaction"];
export class PostgresAgentDefaultRelayKeyStoreV1 implements TransactionPort {
	readonly #client;
	constructor(input: { readonly databaseUrl: string }) {
		this.#client = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: input.databaseUrl,
			}),
			{ max: 4 },
		);
	}
	async execute<T>(
		work: (transaction: AgentDefaultRelayKeyTransactionV1) => Promise<T>,
	): Promise<T> {
		try {
			const result = await this.#client.begin(
				"isolation level read committed",
				async (sql) => {
					await sql`set local lock_timeout = '5s'`;
					await sql`set local statement_timeout = '15s'`;
					return { value: await work(operations(sql)) };
				},
			);
			return result.value;
		} catch (error) {
			if (error instanceof AgentDefaultRelayKeyErrorV1) throw error;
			throw new AgentDefaultRelayKeyErrorV1("unavailable");
		}
	}
	async recordRefusal(event: AgentDefaultRelayKeyAuditV1) {
		await this.execute((tx) => tx.audit(event));
	}
	async close() {
		await this.#client.end();
	}
}
