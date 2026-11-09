import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	jsonb,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { agentConfigurationRevisions, agents } from "./schema-agents";
import { platformSchema } from "./schema-common";

export const workspaceSnapshotUploadAdmissions = platformSchema.table(
	"workspace_snapshot_upload_admissions",
	{
		id: text("id").primaryKey(),
		ownerType: varchar("owner_type", { length: 32 }).notNull(),
		ownerId: text("owner_id").notNull(),
		policyHash: varchar("policy_hash", { length: 64 }).notNull(),
		reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
		releasedAt: timestamp("released_at", { withTimezone: true }),
	},
	(table) => [
		check(
			"snapshot_upload_admission_owner_type",
			sql`${table.ownerType} in ('user','application')`,
		),
		check(
			"snapshot_upload_admission_id",
			sql`${table.id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'`,
		),
		check(
			"snapshot_upload_admission_policy_hash",
			sql`${table.policyHash} ~ '^[a-f0-9]{64}$'`,
		),
		check("snapshot_upload_admission_bytes", sql`${table.reservedBytes} > 0`),
		check(
			"snapshot_upload_admission_times",
			sql`${table.expiresAt} > ${table.createdAt} and ${table.retainUntil} >= ${table.expiresAt} and (${table.releasedAt} is null or ${table.releasedAt} >= ${table.createdAt})`,
		),
		index("snapshot_upload_admission_retention_idx").on(table.retainUntil),
		index("snapshot_upload_admission_owner_created_idx").on(
			table.ownerType,
			table.ownerId,
			table.createdAt,
		),
	],
);

export const workspaceSnapshotUploadReservations = platformSchema.table(
	"workspace_snapshot_upload_reservations",
	{
		id: text("id").primaryKey(),
		ownerType: varchar("owner_type", { length: 32 }).notNull(),
		ownerId: text("owner_id").notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		requestDigest: varchar("request_digest", { length: 64 }).notNull(),
		reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
		status: varchar("status", { length: 16 }).default("reserved").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		snapshotId: text("snapshot_id"),
		objectRef: text("object_ref"),
		objectVersion: text("object_version"),
	},
	(table) => [
		check(
			"workspace_snapshot_upload_reservation_owner_type",
			sql`${table.ownerType} in ('user','application')`,
		),
		check(
			"workspace_snapshot_upload_reservation_digest_format",
			sql`${table.requestDigest} ~ '^[a-f0-9]{64}$'`,
		),
		check(
			"workspace_snapshot_upload_reservation_bytes_positive",
			sql`${table.reservedBytes} > 0`,
		),
		check(
			"workspace_snapshot_upload_reservation_status",
			sql`${table.status} in ('reserved','completed','released','expired')`,
		),
		uniqueIndex("workspace_snapshot_upload_reservation_key_unique").on(
			table.ownerType,
			table.ownerId,
			table.idempotencyKey,
		),
		index("workspace_snapshot_upload_reservation_owner_status_idx").on(
			table.ownerType,
			table.ownerId,
			table.status,
			table.expiresAt,
		),
	],
);

// Independent of a quota lease: a retry must never erase an old PUT's fence.
export const workspaceSnapshotUploadObjects = platformSchema.table(
	"workspace_snapshot_upload_objects",
	{
		objectRef: text("object_ref").primaryKey(),
		reservationId: text("reservation_id").notNull(),
		ownerType: varchar("owner_type", { length: 32 }).notNull(),
		ownerId: text("owner_id").notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
		requestDigest: varchar("request_digest", { length: 64 }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		state: varchar("state", { length: 16 }).default("pending").notNull(),
		objectVersion: text("object_version"),
		fenceVersion: text("fence_version"),
		scanCursor: text("scan_cursor"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		check(
			"snapshot_upload_object_owner_type",
			sql`${table.ownerType} in ('user','application')`,
		),
		check(
			"snapshot_upload_object_state",
			sql`${table.state} in ('pending','published','retired')`,
		),
		check(
			"snapshot_upload_object_request_digest",
			sql`${table.requestDigest} ~ '^[a-f0-9]{64}$'`,
		),
		index("snapshot_upload_object_recovery_idx").on(
			table.updatedAt,
			table.objectRef,
		),
		uniqueIndex("snapshot_upload_object_reservation_idx").on(
			table.reservationId,
		),
	],
);

export const workspaceSnapshots = platformSchema.table(
	"workspace_snapshots",
	{
		id: text("id").primaryKey(),
		ownerType: varchar("owner_type", { length: 32 }).notNull(),
		ownerId: text("owner_id").notNull(),
		digest: varchar("digest", { length: 71 }).notNull(),
		sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
		unpackedSizeBytes: bigint("unpacked_size_bytes", {
			mode: "number",
		}).notNull(),
		fileCount: bigint("file_count", { mode: "number" }).notNull(),
		mediaType: varchar("media_type", { length: 64 }).notNull(),
		source: jsonb("source").$type<Record<string, unknown>>().notNull(),
		objectRef: text("object_ref").notNull(),
		objectVersion: text("object_version").notNull(),
		status: varchar("status", { length: 16 }).default("ready").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
	},
	(table) => [
		check(
			"workspace_snapshot_owner_type",
			sql`${table.ownerType} in ('user','application')`,
		),
		check(
			"workspace_snapshot_digest_format",
			sql`${table.digest} ~ '^sha256:[a-f0-9]{64}$'`,
		),
		check(
			"workspace_snapshot_sizes_positive",
			sql`${table.sizeBytes} > 0 and ${table.unpackedSizeBytes} > 0 and ${table.fileCount} > 0`,
		),
		check(
			"workspace_snapshot_status",
			sql`${table.status} in ('ready','deleting','deleted')`,
		),
		uniqueIndex("workspace_snapshot_owner_id_unique").on(
			table.ownerType,
			table.ownerId,
			table.id,
		),
		index("workspace_snapshot_owner_idx").on(table.ownerType, table.ownerId),
	],
);

export const workspaceSnapshotBindings = platformSchema.table(
	"workspace_snapshot_bindings",
	{
		snapshotId: text("snapshot_id")
			.notNull()
			.references(() => workspaceSnapshots.id),
		agentId: text("agent_id")
			.notNull()
			.references(() => agents.id),
		configurationRevision: bigint("configuration_revision", {
			mode: "number",
		}).notNull(),
		name: varchar("name", { length: 63 }).notNull(),
		digest: varchar("digest", { length: 71 }).notNull(),
		sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.snapshotId, table.agentId, table.configurationRevision],
		}),
		check(
			"workspace_snapshot_binding_digest_format",
			sql`${table.digest} ~ '^sha256:[a-f0-9]{64}$'`,
		),
		check(
			"workspace_snapshot_binding_name",
			sql`${table.name} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'`,
		),
		foreignKey({
			columns: [table.agentId, table.configurationRevision],
			foreignColumns: [
				agentConfigurationRevisions.agentId,
				agentConfigurationRevisions.revision,
			],
			name: "workspace_snapshot_binding_revision_fk",
		}),
		uniqueIndex("workspace_snapshot_agent_name_revision_unique").on(
			table.agentId,
			table.configurationRevision,
			table.name,
		),
		index("workspace_snapshot_binding_agent_idx").on(table.agentId),
	],
);
