import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, primaryKey, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { agentConfigurationRevisions, agents } from "./schema-agents";
import { platformSchema } from "./schema-common";

export const workspaceSnapshots = platformSchema.table("workspace_snapshots", {
 id: text("id").primaryKey(), ownerType: varchar("owner_type", { length: 32 }).notNull(), ownerId: text("owner_id").notNull(), digest: varchar("digest", { length: 71 }).notNull(), sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(), unpackedSizeBytes: bigint("unpacked_size_bytes", { mode: "number" }).notNull(), fileCount: bigint("file_count", { mode: "number" }).notNull(), mediaType: varchar("media_type", { length: 64 }).notNull(), source: jsonb("source").$type<Record<string, unknown>>().notNull(), objectRef: text("object_ref").notNull(), objectVersion: text("object_version").notNull(), status: varchar("status", { length: 16 }).default("ready").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
 check("workspace_snapshot_owner_type", sql`${table.ownerType} in ('user','application')`), check("workspace_snapshot_digest_format", sql`${table.digest} ~ '^sha256:[a-f0-9]{64}$'`), check("workspace_snapshot_sizes_positive", sql`${table.sizeBytes} > 0 and ${table.unpackedSizeBytes} > 0 and ${table.fileCount} > 0`), check("workspace_snapshot_status", sql`${table.status} in ('ready','deleting','deleted')`), uniqueIndex("workspace_snapshot_owner_id_unique").on(table.ownerType, table.ownerId, table.id), index("workspace_snapshot_owner_idx").on(table.ownerType, table.ownerId),
]);

export const workspaceSnapshotBindings = platformSchema.table("workspace_snapshot_bindings", {
 snapshotId: text("snapshot_id").notNull().references(() => workspaceSnapshots.id), agentId: text("agent_id").notNull().references(() => agents.id), configurationRevision: bigint("configuration_revision", { mode: "number" }).notNull(), name: varchar("name", { length: 63 }).notNull(), digest: varchar("digest", { length: 71 }).notNull(), sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
 primaryKey({ columns: [table.snapshotId, table.agentId, table.configurationRevision] }), check("workspace_snapshot_binding_digest_format", sql`${table.digest} ~ '^sha256:[a-f0-9]{64}$'`), check("workspace_snapshot_binding_name", sql`${table.name} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'`), foreignKey({ columns: [table.agentId, table.configurationRevision], foreignColumns: [agentConfigurationRevisions.agentId, agentConfigurationRevisions.revision], name: "workspace_snapshot_binding_revision_fk" }), uniqueIndex("workspace_snapshot_agent_name_revision_unique").on(table.agentId, table.configurationRevision, table.name), index("workspace_snapshot_binding_agent_idx").on(table.agentId),
]);
