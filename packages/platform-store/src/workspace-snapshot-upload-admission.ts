import { createHash, randomUUID } from "node:crypto";
import {
	WorkspaceSnapshotErrorV1,
	type WorkspaceSnapshotPrincipalV1,
	type WorkspaceSnapshotUploadPolicyV1,
	workspaceSnapshotLimitsV1,
	workspaceSnapshotUploadPolicyV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { workspaceSnapshotUploadAdmissions as admissions } from "./schema-workspace-snapshots.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

// Callers take the owner lock first; this lock never waits for another owner lock.
async function lock(transaction: Transaction) {
	await transaction.execute(
		sql`select pg_advisory_xact_lock(hashtextextended('workspace_snapshot_upload_admission', 0))`,
	);
}

export async function admitWorkspaceSnapshotUploadV1(
	transaction: Transaction,
	owner: WorkspaceSnapshotPrincipalV1,
	input: WorkspaceSnapshotUploadPolicyV1,
) {
	const policy = workspaceSnapshotUploadPolicyV1.parse(input);
	await lock(transaction);
	const clock = await transaction.execute<{ now: string }>(
		sql`select clock_timestamp() as now`,
	);
	const instant = new Date(clock[0]?.now ?? "");
	if (!Number.isFinite(instant.getTime()))
		throw new WorkspaceSnapshotErrorV1("unavailable");
	const now = instant.toISOString();
	// Bounded opportunistic cleanup works even when the optional snapshot GC is disabled.
	await transaction.execute(sql`delete from ${admissions} where ${admissions.id} in (
		select id from platform.workspace_snapshot_upload_admissions where retain_until <= ${now}::timestamptz order by retain_until,id limit 1000
	)`);
	const policyHash = createHash("sha256")
		.update(JSON.stringify(policy))
		.digest("hex");
	const [differentPolicy] = await transaction
		.select({ id: admissions.id })
		.from(admissions)
		.where(
			and(
				sql`${admissions.retainUntil} > ${now}::timestamptz`,
				sql`${admissions.policyHash} <> ${policyHash}`,
			),
		)
		.limit(1);
	if (differentPolicy) throw new WorkspaceSnapshotErrorV1("unavailable");
	const cutoff = new Date(
		instant.getTime() - policy.rateWindowMs,
	).toISOString();
	const active = sql`${admissions.releasedAt} is null and ${admissions.expiresAt} > ${now}::timestamptz`;
	const owned = sql`${admissions.ownerType} = ${owner.kind} and ${admissions.ownerId} = ${owner.id}`;
	const [usage] = await transaction
		.select({
			activeUploads: sql<string>`count(*) filter (where ${active})`,
			activeOwnerUploads: sql<string>`count(*) filter (where ${active} and ${owned})`,
			ownerRequestsInWindow: sql<string>`count(*) filter (where ${owned} and ${admissions.createdAt} > ${cutoff}::timestamptz)`,
			requestsInWindow: sql<string>`count(*) filter (where ${admissions.createdAt} > ${cutoff}::timestamptz)`,
			temporaryBytes: sql<string>`coalesce(sum(${admissions.reservedBytes}) filter (where ${active}),0)`,
		})
		.from(admissions)
		.where(sql`${admissions.retainUntil} > ${now}::timestamptz`);
	if (!usage) throw new WorkspaceSnapshotErrorV1("unavailable");
	workspaceSnapshotUploadPolicyV1.assertAdmitted(policy, {
		activeUploads: Number(usage.activeUploads),
		activeOwnerUploads: Number(usage.activeOwnerUploads),
		ownerRequestsInWindow: Number(usage.ownerRequestsInWindow),
		requestsInWindow: Number(usage.requestsInWindow),
		temporaryBytes: Number(usage.temporaryBytes),
	});
	const leaseId = randomUUID();
	const expiresAt = new Date(instant.getTime() + policy.admissionLeaseMs);
	await transaction.insert(admissions).values({
		id: leaseId,
		ownerType: owner.kind,
		ownerId: owner.id,
		policyHash,
		reservedBytes: workspaceSnapshotLimitsV1.maxArchiveBytes,
		createdAt: instant,
		expiresAt,
		retainUntil: new Date(
			instant.getTime() +
				Math.max(policy.admissionLeaseMs, policy.rateWindowMs),
		),
	});
	return { leaseId, expiresAt: expiresAt.toISOString() };
}

export async function releaseWorkspaceSnapshotUploadAdmissionV1(
	transaction: Transaction,
	owner: WorkspaceSnapshotPrincipalV1,
	leaseId: string,
) {
	await lock(transaction);
	await transaction
		.update(admissions)
		.set({ releasedAt: sql`clock_timestamp()` })
		.where(
			and(
				eq(admissions.id, leaseId),
				eq(admissions.ownerType, owner.kind),
				eq(admissions.ownerId, owner.id),
				sql`${admissions.releasedAt} is null`,
			),
		);
}
