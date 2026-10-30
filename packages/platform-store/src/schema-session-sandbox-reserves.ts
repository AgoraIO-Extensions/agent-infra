import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	jsonb,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { platformSchema } from "./schema-common";

export const sessionSandboxBudgets = platformSchema.table(
	"session_sandbox_budgets",
	{
		namespace: text("namespace").primaryKey(),
		revision: bigint("revision", { mode: "number" }).notNull(),
		configuration: jsonb("configuration").notNull(),
		reserveSizing: jsonb("reserve_sizing").notNull().default({}),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
);
export const sessionSandboxResourceCharges = platformSchema.table(
	"session_sandbox_resource_charges",
	{
		sandboxId: text("sandbox_id").primaryKey(),
		namespace: text("namespace").notNull(),
		resources: jsonb("resources").notNull(),
		computeReleased: boolean("compute_released").notNull().default(false),
		released: boolean("released").notNull().default(false),
	},
);
export const sessionSandboxReserves = platformSchema.table(
	"session_sandbox_reserves",
	{
		sandboxId: text("sandbox_id").primaryKey(),
		sessionId: text("session_id").notNull(),
		agentId: text("agent_id").notNull(),
		namespace: text("namespace").notNull(),
		profileDigest: text("profile_digest").notNull(),
		profile: jsonb("profile").notNull(),
		status: varchar("status", { length: 16 }).notNull(),
		operations: jsonb("operations").notNull().default([]),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		deliveryFence: bigint("delivery_fence", { mode: "number" })
			.notNull()
			.default(0),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		readyAt: timestamp("ready_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		retiredAt: timestamp("retired_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("session_sandbox_reserve_session_unique").on(table.sessionId),
		check(
			"session_sandbox_reserve_status_valid",
			sql`${table.status} in ('preparing','ready','claimed','retiring','unknown')`,
		),
		check(
			"session_sandbox_reserve_fence_safe",
			sql`${table.deliveryFence} between 0 and 9007199254740991`,
		),
		check(
			"session_sandbox_reserve_id_uuid",
			sql`${table.sandboxId} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'`,
		),
	],
);
