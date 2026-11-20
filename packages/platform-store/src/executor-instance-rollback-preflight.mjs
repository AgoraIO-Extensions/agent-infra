#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ExecutorInstanceStateV2Schema } from "@agent-infra/contracts/runtime";
import postgres from "postgres";

/** Only returns aggregate compatibility, never identities, public keys or connection inputs. */
export function executorInstanceRollbackCompatibilityV2(
	rows,
	namespace,
	consumerProtocol,
	liveLeases = 0,
) {
	if (
		!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace) ||
		![1, 2].includes(consumerProtocol) ||
		!Array.isArray(rows) ||
		!Number.isSafeInteger(liveLeases) ||
		liveLeases < 0
	)
		throw new Error("EXECUTOR_INSTANCE_ROLLBACK_UNPROVEN");
	const states = rows
		.map((row) => ExecutorInstanceStateV2Schema.parse(row.state))
		.filter((row) => row.namespace === namespace);
	const active = states.filter((state) => state.phase !== "retired");
	return {
		schemaVersion: 2,
		compatible:
			consumerProtocol === 2 || (active.length === 0 && liveLeases === 0),
		consumerProtocol,
		instances: states.length,
		liveLeases,
		active: active.length,
		pendingDelivery: active.filter((state) =>
			["delivery-pending", "published"].includes(state.phase),
		).length,
	};
}
export async function readExecutorInstanceRollbackV2(
	sql,
	namespace,
	consumerProtocol,
) {
	executorInstanceRollbackCompatibilityV2([], namespace, consumerProtocol);
	return sql.begin("read only", async (transaction) => {
		await transaction`set local lock_timeout='5000ms'`;
		await transaction`set local statement_timeout='10000ms'`;
		await transaction`select pg_advisory_xact_lock(hashtextextended(${`agent-infra/executor-instance-v2/${namespace}`},0))`;
		const rows =
			await transaction`select distinct on (conversation_id,details->>'sandboxId',details->>'sessionGeneration',details->>'resourceFence') details->'state' as state
   from platform.conversation_audit_events where action='conversation.sandbox.observed' and details->>'checkpoint'='executor-instance-v2'
   order by conversation_id,details->>'sandboxId',details->>'sessionGeneration',details->>'resourceFence',(details->'state'->>'sequence')::numeric desc`;
		// Unclaimed reserves have their own durable V2 ledger, not a business Conversation audit.
		const reserves =
			await transaction`select executor_startup->'instance' as state
			from platform.session_sandbox_reserves where namespace=${namespace}
			and retired_at is null and executor_startup->'instance' is not null`;
		const [leases] =
			await transaction`select ((select count(*) from platform.outbox_items o join platform.session_sandbox_allocations s on s.conversation_id=o.scope_id
   where o.operation='conversation.sandbox.reconcile.v1' and o.status='processing' and o.lease_expires_at>clock_timestamp() and s.resource_policy->>'namespace'=${namespace})
   + (select count(*) from platform.session_sandbox_reserves where namespace=${namespace} and status<>'claimed'
   and retired_at is null and lease_owner is not null and lease_expires_at>clock_timestamp()))::int as count`;
		return executorInstanceRollbackCompatibilityV2(
			[...rows, ...reserves],
			namespace,
			consumerProtocol,
			leases?.count ?? -1,
		);
	});
}
async function run(args) {
	if (
		args.length !== 6 ||
		args[0] !== "--database-url-file" ||
		args[2] !== "--namespace" ||
		args[4] !== "--consumer-protocol"
	)
		throw new Error("EXECUTOR_INSTANCE_ROLLBACK_INPUT_INVALID");
	const file = await open(
		args[1],
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	let url;
	try {
		const stat = await file.stat();
		if (
			!stat.isFile() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0 ||
			stat.nlink !== 1 ||
			stat.size > 8192
		)
			throw new Error("EXECUTOR_INSTANCE_ROLLBACK_INPUT_INVALID");
		url = (await file.readFile("utf8")).trim();
	} finally {
		await file.close();
	}
	const parsed = new URL(url);
	if (
		!["postgres:", "postgresql:"].includes(parsed.protocol) ||
		!parsed.hostname ||
		!parsed.username ||
		!parsed.password ||
		parsed.pathname.length < 2
	)
		throw new Error("EXECUTOR_INSTANCE_ROLLBACK_INPUT_INVALID");
	const sql = postgres(url, {
		max: 1,
		connect_timeout: 2,
		onnotice: () => {},
		debug: false,
	});
	try {
		const result = await readExecutorInstanceRollbackV2(
			sql,
			args[3],
			Number(args[5]),
		);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		if (!result.compatible) process.exitCode = 1;
	} finally {
		await sql.end();
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	void run(process.argv.slice(2)).catch(() => {
		process.stderr.write('{"code":"EXECUTOR_INSTANCE_ROLLBACK_UNPROVEN"}\n');
		process.exitCode = 1;
	});
