import { randomUUID } from "node:crypto";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type {
	WecomSetupRecordV1,
	WecomSetupStoreV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { secretKeyAdvisoryLockName } from "./secret-key-lock.js";
import type { WecomConnectionClaimV1 } from "./wecom-connections.js";

type Row = {
	kind: "wecom_bot" | "wecom_app";
	application: WecomSetupRecordV1["application"];
	encrypted_callback: unknown;
	callback_verified_at: Date | null;
	session_id: string;
	agent_id: string;
	actor_id: string;
	configuration_revision: string;
	authorization_revision: string;
	state_digest: string;
	expires_at: Date;
	status: WecomSetupRecordV1["status"];
	bot_id: string | null;
	encrypted_credential: unknown;
	connection_status?:
		| "verifying"
		| "connected"
		| "disconnected"
		| "auth_failed";
};
function record(row: Row): WecomSetupRecordV1 {
	return {
		sessionId: row.session_id,
		kind: row.kind,
		application: row.application,
		encryptedCallback: row.encrypted_callback,
		callbackVerifiedAt: row.callback_verified_at?.toISOString() ?? null,
		agentId: row.agent_id,
		actorId: row.actor_id,
		configurationRevision: Number(row.configuration_revision),
		authorizationRevision: row.authorization_revision,
		stateDigest: row.state_digest,
		expiresAt: row.expires_at.toISOString(),
		status: row.status,
		botId: row.bot_id,
		encryptedCredential: row.encrypted_credential,
		...(row.connection_status
			? { connectionStatus: row.connection_status }
			: {}),
	};
}
async function audit(
	sql: postgres.Sql | postgres.TransactionSql,
	session: WecomSetupRecordV1,
	action: string,
) {
	await sql`insert into platform.audit_events (id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,request_id,agent_id,details)
 values (${randomUUID()},${session.sessionId},${action === "wecom.setup_failed" || action === "wecom.setup_expired" ? "system" : "user"},${action === "wecom.setup_failed" || action === "wecom.setup_expired" ? "platform-worker" : session.actorId},${action},'agent',${session.agentId},${action === "wecom.setup_failed" || action === "wecom.setup_expired" ? "failed" : "succeeded"},${session.sessionId},${session.agentId},NULL)`;
}
export class PostgresWecomSetupV1 implements WecomSetupStoreV1 {
	readonly #sql: ReturnType<typeof postgres>;
	readonly #observe: (status: "expired" | "conflict" | "auth_failed") => void;
	constructor(options: {
		readonly databaseUrl: string;
		readonly observeSetup?: (
			status: "expired" | "conflict" | "auth_failed",
		) => void;
	}) {
		this.#observe = (status) => {
			try {
				options.observeSetup?.(status);
			} catch {
				/* Observation only. */
			}
		};
		this.#sql = postgres(options.databaseUrl, { max: 3 });
	}
	close() {
		return this.#sql.end();
	}
	async create(session: WecomSetupRecordV1) {
		await this.#sql.begin(async (sql) => {
			const rows =
				await sql`insert into platform.wecom_setup_sessions (session_id,agent_id,actor_id,configuration_revision,authorization_revision,state_digest,expires_at,status,kind)
    select ${session.sessionId},a.id,${session.actorId},${session.configurationRevision},${session.authorizationRevision},${session.stateDigest},${new Date(session.expiresAt)},'awaiting_input',${session.kind ?? "wecom_bot"}
    from platform.agents a where a.id=${session.agentId} and a.current_configuration_revision=${session.configurationRevision} and a.authorization_revision=${session.authorizationRevision}
    and exists(select 1 from platform.agent_owners o where o.agent_id=a.id and o.owner_id=${session.actorId}) returning session_id`;
			if (rows.length !== 1) throw new Error("WeCom setup unavailable");
			await audit(sql, session, "wecom.setup_started");
		});
	}
	async pendingApplication(agentId: string, actorId: string) {
		const [row] = await this.#sql<
			Row[]
		>`select * from platform.wecom_setup_sessions where kind='wecom_app' and agent_id=${agentId} and actor_id=${actorId} and status='verifying' and expires_at>clock_timestamp() order by expires_at desc,session_id limit 1`;
		return row ? record(row) : null;
	}
	async read(sessionId: string) {
		const [row] = await this.#sql<
			Row[]
		>`select s.*,case when w.status='auth_failed' then 'auth_failed' when w.lease_until>clock_timestamp() then w.status else 'disconnected' end as connection_status from platform.wecom_setup_sessions s left join platform.wecom_connections w on w.binding_reference=s.session_id and w.bot_id=s.bot_id where s.session_id=${sessionId}`;
		return row ? record(row) : null;
	}
	async consume(input: Parameters<WecomSetupStoreV1["consume"]>[0]) {
		const { session } = input;
		const credential = validatePlatformSecretRecordV1(
			input.encryptedCredential,
		);
		if (
			credential.agentId !== session.agentId ||
			credential.ownerId !== session.actorId ||
			credential.ownerType !== "agent-owner" ||
			credential.secretId !== session.sessionId ||
			credential.name !== (session.kind ?? "wecom_bot") ||
			credential.configRevision !== session.configurationRevision ||
			credential.secretVersion !== 1
		)
			throw new Error("WeCom credential binding invalid");
		return this.#sql.begin(async (sql) => {
			// Use the same key lock as retirement so a retired key cannot gain references.
			await sql`select pg_advisory_xact_lock(hashtextextended(${secretKeyAdvisoryLockName(credential.crypto.wrappingKeyVersion)},0))`;
			const retired =
				await sql`select 1 from platform.retired_secret_wrapping_keys where key_version=${credential.crypto.wrappingKeyVersion}`;
			if (retired.length) return false;
			// Serialize contenders for the provider identity before consuming either session.
			await sql`select pg_advisory_xact_lock(hashtextextended(${`wecom-setup:${input.botId}`},0))`;
			const [conflict] =
				await sql`select 1 from platform.wecom_setup_sessions s join platform.agents a on a.id=s.agent_id join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision
    where s.bot_id=${input.botId} and s.session_id!=${session.sessionId} and ((s.status='verifying' and s.expires_at>clock_timestamp()) or (s.agent_id!=${session.agentId} and c.configuration->'channels' @> jsonb_build_array(jsonb_build_object('kind',s.kind,'bindingReference',s.session_id))))`;
			if (conflict) return false;
			const rows =
				await sql`update platform.wecom_setup_sessions s set bot_id=${input.botId},application=${input.application ? sql.json(input.application) : null},encrypted_callback=${input.encryptedCallback ? sql.json(input.encryptedCallback as postgres.JSONValue) : null},encrypted_credential=${sql.json(credential as unknown as postgres.JSONValue)},status='verifying'
    from platform.agents a where s.session_id=${session.sessionId} and s.agent_id=${session.agentId} and s.actor_id=${session.actorId} and s.state_digest=${session.stateDigest} and s.kind=${session.kind ?? "wecom_bot"} and s.status='awaiting_input' and s.expires_at>clock_timestamp()
    and a.id=s.agent_id and a.current_configuration_revision=s.configuration_revision and a.authorization_revision=s.authorization_revision
    and exists(select 1 from platform.agent_owners o where o.agent_id=a.id and o.owner_id=s.actor_id) returning s.session_id`;
			if (!rows.length) return false;
			await audit(sql, session, "wecom.credentials_submitted");
			return true;
		});
	}
	async cancel(session: WecomSetupRecordV1) {
		return this.#sql.begin(async (sql) => {
			const rows =
				await sql`update platform.wecom_setup_sessions set status='cancelled',encrypted_credential=null,encrypted_callback=null where session_id=${session.sessionId} and actor_id=${session.actorId} and agent_id=${session.agentId} and status in ('awaiting_input','verifying') returning session_id`;
			if (!rows.length) return false;
			await audit(sql, session, "wecom.setup_cancelled");
			return true;
		});
	}
	async candidates(kind: "wecom_bot" | "wecom_app" = "wecom_bot") {
		const result = await this.#sql.begin(async (sql) => {
			const ended = await sql<
				Row[]
			>`update platform.wecom_setup_sessions s set status=case when s.expires_at<=clock_timestamp() then 'expired' else 'conflict' end,encrypted_credential=null,encrypted_callback=null from platform.agents a
    where s.agent_id=a.id and s.status in ('awaiting_input','verifying') and (s.expires_at<=clock_timestamp() or a.current_configuration_revision!=s.configuration_revision or a.authorization_revision!=s.authorization_revision or not exists(select 1 from platform.agent_owners o where o.agent_id=s.agent_id and o.owner_id=s.actor_id)) returning s.*`;
			for (const row of ended)
				await audit(
					sql,
					record(row),
					row.status === "expired"
						? "wecom.setup_expired"
						: "wecom.setup_failed",
				);
			const rows = await sql<
				Row[]
			>`select s.* from platform.wecom_setup_sessions s left join platform.wecom_connections w on w.bot_id=s.bot_id and w.binding_reference=s.session_id where s.kind=${kind} and (s.kind='wecom_bot' or s.callback_verified_at is not null) and s.status='verifying' and s.expires_at>clock_timestamp() and (w.lease_until is null or w.lease_until<=clock_timestamp()) order by w.lease_until nulls first,s.expires_at,s.session_id limit 25`;
			return {
				rows: rows.map(record),
				ended: ended.map((row) => row.status as "expired" | "conflict"),
			};
		});
		for (const status of result.ended) this.#observe(status);
		return result.rows;
	}
	async fail(
		sessionId: string,
		status: "auth_failed" | "conflict",
		claim: WecomConnectionClaimV1,
	) {
		const changed = await this.#sql.begin(async (sql) => {
			if (claim) {
				const owned =
					await sql`select 1 from platform.wecom_connections where bot_id=${claim.botId} and binding_reference=${sessionId} and agent_id=${claim.agentId} and holder_id=${claim.holderId} and fence=${claim.fence} and lease_until>clock_timestamp() for update`;
				if (!owned.length) return;
			}
			const rows = await sql<
				Row[]
			>`update platform.wecom_setup_sessions set status=${status},encrypted_credential=null,encrypted_callback=null where session_id=${sessionId} and status='verifying' returning *`;
			for (const row of rows)
				await audit(sql, record(row), "wecom.setup_failed");
			return rows.length > 0;
		});
		if (changed) this.#observe(status);
	}

	async verifyCallback(sessionId: string) {
		const rows = await this
			.#sql`update platform.wecom_setup_sessions s set callback_verified_at=clock_timestamp() from platform.agents a where s.session_id=${sessionId} and s.kind='wecom_app' and s.status='verifying' and s.expires_at>clock_timestamp() and a.id=s.agent_id and a.current_configuration_revision=s.configuration_revision and a.authorization_revision=s.authorization_revision and exists(select 1 from platform.agent_owners o where o.agent_id=a.id and o.owner_id=s.actor_id) returning s.session_id`;
		return rows.length === 1;
	}
	async callbackKeyIds() {
		const rows = await this
			.#sql`select distinct encrypted_callback->>'keyId' as key_id from platform.wecom_setup_sessions where encrypted_callback is not null`;
		return rows.map((row) => String(row.key_id));
	}

	async bindings(kind: "wecom_bot" | "wecom_app" = "wecom_bot") {
		const rows = await this.#sql<
			Row[]
		>`select s.* from platform.wecom_setup_sessions s join platform.agents a on a.id=s.agent_id join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision where s.kind=${kind} and s.status='active' and c.configuration->'channels' @> jsonb_build_array(jsonb_build_object('kind',s.kind,'bindingReference',s.session_id)) order by s.session_id`;
		return rows.map(record);
	}
}
