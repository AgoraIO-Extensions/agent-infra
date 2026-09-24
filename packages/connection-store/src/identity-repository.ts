import {
	type BrowserSessionDirectory,
	type BrowserSessionPrincipal,
	type BrowserSessionPrincipalStore,
	type BrowserSessionRecord,
	type BrowserSessionStore,
	type PrincipalIdentityStore,
	PrincipalInactiveError,
} from "@agent-infra/connection-core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ConnectionDatabase } from "./database.js";
import { browserSessions, principals } from "./schema.js";

function principalRecord(
	row: typeof principals.$inferSelect,
): BrowserSessionPrincipal {
	return {
		id: row.id,
		issuer: row.issuer,
		uid: row.uid,
		status: row.status as BrowserSessionPrincipal["status"],
		recoveryGeneration: row.recoveryGeneration,
	};
}

function sessionRecord(
	row: typeof browserSessions.$inferSelect,
): BrowserSessionRecord {
	return {
		id: row.id,
		tokenHash: row.tokenHash,
		principalId: row.principalId,
		issuer: row.issuer,
		uid: row.uid,
		recoveryGeneration: row.recoveryGeneration,
		expiresAt: row.expiresAt.getTime(),
		revokedAt: row.revokedAt?.getTime() ?? null,
	};
}

export function createPrincipalIdentityStore(
	db: ConnectionDatabase,
): PrincipalIdentityStore & BrowserSessionPrincipalStore {
	return {
		async findByIssuerUid({ issuer, uid }) {
			const [row] = await db
				.select()
				.from(principals)
				.where(and(eq(principals.issuer, issuer), eq(principals.uid, uid)));
			return row ? principalRecord(row) : undefined;
		},
		async findById(id) {
			const [row] = await db
				.select()
				.from(principals)
				.where(eq(principals.id, id));
			return row ? principalRecord(row) : undefined;
		},
		async insert(input) {
			await db.insert(principals).values(input).onConflictDoNothing();
		},
		async disable(id) {
			await db
				.update(principals)
				.set({
					status: "disabled",
					recoveryGeneration: sql`${principals.recoveryGeneration} + 1`,
					updatedAt: new Date(),
				})
				.where(and(eq(principals.id, id), eq(principals.status, "active")));
		},
	};
}

export function createBrowserSessionStore(
	db: ConnectionDatabase,
): BrowserSessionStore {
	return {
		async insert(record) {
			await db.transaction(async (tx) => {
				const [principal] = await tx
					.select()
					.from(principals)
					.where(eq(principals.id, record.principalId))
					.for("update");
				if (
					principal?.status !== "active" ||
					principal.issuer !== record.issuer ||
					principal.uid !== record.uid ||
					principal.recoveryGeneration !== record.recoveryGeneration
				)
					throw new PrincipalInactiveError();
				await tx.insert(browserSessions).values({
					id: record.id,
					tokenHash: record.tokenHash,
					principalId: record.principalId,
					issuer: record.issuer,
					uid: record.uid,
					recoveryGeneration: record.recoveryGeneration,
					expiresAt: new Date(record.expiresAt),
					revokedAt:
						record.revokedAt === null ? null : new Date(record.revokedAt),
				});
			});
		},
		async findByTokenHash(tokenHash) {
			const [row] = await db
				.select()
				.from(browserSessions)
				.where(eq(browserSessions.tokenHash, tokenHash));
			return row ? sessionRecord(row) : undefined;
		},
		async revoke(id, at) {
			await db
				.update(browserSessions)
				.set({ revokedAt: new Date(at) })
				.where(
					and(eq(browserSessions.id, id), isNull(browserSessions.revokedAt)),
				);
		},
	};
}

/** A Principal row lock shares the 15-minute recheck across API replicas. */
export function createPostgresPrincipalDirectory(
	db: ConnectionDatabase,
	issuer: string,
	checker: { entryExists(uid: string): Promise<boolean> },
	now: () => number = Date.now,
): BrowserSessionDirectory {
	if (!issuer.trim()) throw new Error("LDAP issuer is required");
	return {
		async check(requestIssuer, uid) {
			if (requestIssuer !== issuer || !uid.trim())
				throw new PrincipalInactiveError();
			return db.transaction(async (tx) => {
				const [principal] = await tx
					.select()
					.from(principals)
					.where(and(eq(principals.issuer, issuer), eq(principals.uid, uid)))
					.for("update");
				if (principal?.status !== "active") return { exists: false };
				const age = principal.directoryCheckedAt
					? now() - principal.directoryCheckedAt.getTime()
					: undefined;
				if (age !== undefined && age >= 0 && age < 15 * 60_000)
					return { exists: true };
				const exists = await checker.entryExists(uid);
				if (exists) {
					await tx
						.update(principals)
						.set({ directoryCheckedAt: new Date(now()) })
						.where(eq(principals.id, principal.id));
				} else {
					await tx
						.update(principals)
						.set({
							status: "disabled",
							recoveryGeneration: sql`${principals.recoveryGeneration} + 1`,
							directoryCheckedAt: new Date(now()),
							updatedAt: new Date(now()),
						})
						.where(eq(principals.id, principal.id));
				}
				return { exists };
			});
		},
	};
}
