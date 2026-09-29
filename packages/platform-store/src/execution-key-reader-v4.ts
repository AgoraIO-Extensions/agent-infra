import {
	type RuntimeBusinessRequestV4,
	RuntimePinnedExecutionKeyScopeV4Schema,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSupplementRequestV4Schema,
} from "@agent-infra/contracts/runtime";
import { parseTaskAuthorizationBoundaryV1 } from "@agent-infra/platform-core";
import postgres from "postgres";

import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import {
	type RelayKeyVersionBindingV1,
	readRelayKeyVersionInTransaction,
} from "./relay-key-versions.js";

interface AcceptedExecutionRowV4 {
	readonly actor_id: string;
	readonly agent_id: string;
	readonly conversation_id: string;
	readonly execution_id: string;
	readonly turn_id: string;
	readonly channel_id: string;
	readonly session_generation: string;
	readonly execution_source: string | null;
	readonly relay_key_purpose: string | null;
	readonly relay_key_subject_id: string | null;
	readonly relay_key_id: string | null;
	readonly relay_key_version: string | null;
	readonly host_session_ref: string | null;
	readonly boundary: unknown;
	readonly revoked_at: Date | null;
}

function safeVersion(value: string | null) {
	if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
	const version = Number(value);
	return Number.isSafeInteger(version) ? version : null;
}

/** Reads the accepted Execution's immutable Key identity, never its subject's current alias. */
export class PostgresExecutionKeyReaderV4 {
	readonly #client: ReturnType<typeof postgres>;

	constructor(options: { readonly databaseUrl: string }) {
		this.#client = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: options.databaseUrl,
			}),
			{ max: 4 },
		);
	}

	async close() {
		await this.#client.end();
	}

	async readAcceptedExecution(request: RuntimeBusinessRequestV4) {
		const parsed =
			"selection" in request
				? RuntimeSubmitTurnRequestV4Schema.parse(request)
				: RuntimeSupplementRequestV4Schema.parse(request);
		return this.#client.begin(async (sql) => {
			const rows = await sql<AcceptedExecutionRowV4[]>`
					select e.actor_id, e.agent_id, e.conversation_id, e.execution_id,
						e.turn_id, e.channel_id, e.session_generation::text,
						e.execution_source, e.relay_key_purpose,
						e.relay_key_subject_id, e.relay_key_id,
						e.relay_key_version::text, c.host_session_ref,
						a.boundary, a.revoked_at
					from platform.conversation_executions e
					join platform.conversations c on c.id = e.conversation_id
					join platform.task_authorization_records a on a.execution_id = e.execution_id
					where e.execution_id = ${parsed.executionId}
					for share of e, c, a
				`;
			const row = rows[0];
			if (!row || rows.length !== 1 || row.revoked_at !== null) return null;
			try {
				const boundary = parseTaskAuthorizationBoundaryV1(row.boundary);
				const version = safeVersion(row.relay_key_version);
				if (
					!version ||
					boundary.principal.id !== row.actor_id ||
					boundary.agentId !== row.agent_id ||
					boundary.channelId !== row.channel_id
				)
					return null;
				const scope = RuntimePinnedExecutionKeyScopeV4Schema.parse({
					principal: boundary.principal,
					executionSource: row.execution_source,
					channelId: row.channel_id,
					agentId: row.agent_id,
					conversationId: row.conversation_id,
					executionId: row.execution_id,
					turnId: row.turn_id,
					sessionGeneration: safeVersion(row.session_generation),
					hostSessionRef: row.host_session_ref,
					keyBinding: {
						purpose: row.relay_key_purpose,
						subjectId: row.relay_key_subject_id,
						ciphertextRef: row.relay_key_id,
						version,
					},
				});
				return { scope, trustedHostSessionRef: row.host_session_ref };
			} catch {
				return null;
			}
		});
	}

	async readCiphertext(binding: RelayKeyVersionBindingV1) {
		return this.#client.begin((sql) =>
			readRelayKeyVersionInTransaction(sql, binding),
		);
	}
}
