import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresPlatformAuditQueryV1 } from "./audit.js";
import {
	PostgresLdapIdentityIdsV1,
	PostgresPlatformUserDisablesV1,
} from "./ldap-identity.js";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

let database: Awaited<ReturnType<typeof startPostgresTestDatabase>>;

beforeAll(async () => {
	database = await startPostgresTestDatabase("ldap-identity-authority");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
}, 120_000);

afterAll(async () => database?.stop());

describe("PostgreSQL LDAP identity authority", () => {
	it("keeps a one-to-one opaque ID stable across replicas and concurrent logins", async () => {
		const first = new PostgresLdapIdentityIdsV1(database.databaseUrl);
		const second = new PostgresLdapIdentityIdsV1(database.databaseUrl);
		const candidates = Array.from({ length: 10 }, () => randomUUID());
		try {
			const ids = await Promise.all(
				candidates.map((candidate, index) =>
					(index % 2 === 0 ? first : second).getOrCreate(
						"issuer-a",
						"uid-a",
						candidate,
					),
				),
			);
			expect(new Set(ids).size).toBe(1);
			const id = ids[0];
			if (!id) throw new Error("Expected a persisted LDAP user ID");
			expect(id).toMatch(/^[0-9a-f-]{36}$/u);
			expect(await second.findByUid("issuer-a", "uid-a")).toBe(id);
			expect(await first.findUidByUserId("issuer-a", id)).toBe("uid-a");
			expect(await first.findByUid("issuer-b", "uid-a")).toBeNull();
			expect(await second.findUidByUserId("issuer-b", id)).toBeNull();
			await expect(
				first.getOrCreate("issuer-b", "uid-b", id),
			).rejects.toThrow();
			expect(await second.findByUid("issuer-b", "uid-b")).toBeNull();
			const other = randomUUID();
			expect(await second.getOrCreate("issuer-b", "uid-b", other)).toBe(other);
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});

	it("rejects malformed identity inputs before storage", async () => {
		const store = new PostgresLdapIdentityIdsV1(database.databaseUrl);
		try {
			await expect(
				store.getOrCreate("issuer", "uid", "uid-not-uuid"),
			).rejects.toThrow("LDAP_IDENTITY_INPUT_INVALID");
			await expect(store.findByUid("issuer\n", "uid")).rejects.toThrow(
				"LDAP_IDENTITY_INPUT_INVALID",
			);
		} finally {
			await store.close();
		}
	});

	it("reads the current Platform disable fact across replicas", async () => {
		const first = new PostgresPlatformUserDisablesV1(database.databaseUrl);
		const second = new PostgresPlatformUserDisablesV1(database.databaseUrl);
		const sql = postgres(database.databaseUrl, { max: 1 });
		const userId = randomUUID();
		try {
			expect(await first.isPlatformDisabled(userId)).toBe(false);
			await sql`
				insert into platform.platform_user_disables (user_id, disabled_by)
				values (${userId}, ${randomUUID()})
			`;
			expect(await second.isPlatformDisabled(userId)).toBe(true);
			await sql`delete from platform.platform_user_disables where user_id = ${userId}`;
			expect(await first.isPlatformDisabled(userId)).toBe(false);
			await expect(
				first.isPlatformDisabled("caller-controlled-name"),
			).rejects.toThrow("LDAP_IDENTITY_INPUT_INVALID");
		} finally {
			await Promise.all([first.close(), second.close(), sql.end()]);
		}
	});

	it("rechecks current LDAP administrator authority and audits disable and enable", async () => {
		const ids = new PostgresLdapIdentityIdsV1(database.databaseUrl);
		const sql = postgres(database.databaseUrl, { max: 1 });
		const administrator = randomUUID();
		const target = randomUUID();
		let administratorActive = true;
		let administratorAllowed = true;
		let targetActive = true;
		const users = new PostgresPlatformUserDisablesV1(
			database.databaseUrl,
			async (userId) => ({
				userId,
				accountStatus:
					userId === target
						? targetActive
							? "active"
							: "disabled"
						: administratorActive
							? "active"
							: "disabled",
				roles:
					userId === administrator && administratorAllowed
						? ["employee", "system_admin"]
						: ["employee"],
			}),
		);
		const command = (disabled: boolean) => ({
			actorUserId: administrator,
			targetUserId: target,
			disabled,
			traceId: "ldap-admin-governance",
			requestId: "request-1",
		});
		try {
			await ids.getOrCreate("issuer-a", "admin-uid", administrator);
			await ids.getOrCreate("issuer-a", "target-uid", target);
			administratorAllowed = false;
			await expect(
				users.setPlatformDisabled(command(true)),
			).rejects.toMatchObject({
				code: "not_authorized",
			});
			administratorAllowed = true;
			administratorActive = false;
			await expect(
				users.setPlatformDisabled(command(true)),
			).rejects.toMatchObject({
				code: "not_authorized",
			});
			administratorActive = true;
			expect(await users.setPlatformDisabled(command(true))).toBe(true);
			expect(await users.isPlatformDisabled(target)).toBe(true);
			expect(await users.setPlatformDisabled(command(true))).toBe(false);
			targetActive = false;
			await expect(
				users.setPlatformDisabled(command(false)),
			).rejects.toMatchObject({
				code: "resource_unavailable",
			});
			targetActive = true;
			expect(await users.setPlatformDisabled(command(false))).toBe(true);
			expect(await users.isPlatformDisabled(target)).toBe(false);
			expect(
				await sql`
					select actor_id, action, target_id from platform.audit_events
					where trace_id = 'ldap-admin-governance' order by occurred_at, action
				`,
			).toEqual([
				{
					actor_id: administrator,
					action: "platform.user.disabled",
					target_id: target,
				},
				{
					actor_id: administrator,
					action: "platform.user.disabled",
					target_id: target,
				},
				{
					actor_id: administrator,
					action: "platform.user.enabled",
					target_id: target,
				},
			]);
			await sql`
				insert into platform.platform_user_disables (user_id, disabled_by)
				values (${administrator}, ${administrator})
			`;
			await expect(
				users.setPlatformDisabled(command(true)),
			).rejects.toMatchObject({
				code: "not_authorized",
			});
		} finally {
			await Promise.all([ids.close(), users.close(), sql.end()]);
		}
	});

	it("rolls back a disable when its audit insert fails", async () => {
		const ids = new PostgresLdapIdentityIdsV1(database.databaseUrl);
		const sql = postgres(database.databaseUrl, { max: 1 });
		const administrator = randomUUID();
		const target = randomUUID();
		const users = new PostgresPlatformUserDisablesV1(
			database.databaseUrl,
			async (userId) => ({
				userId,
				accountStatus: "active",
				roles: ["employee", "system_admin"],
			}),
		);
		try {
			await ids.getOrCreate("issuer-b", "admin-uid", administrator);
			await ids.getOrCreate("issuer-b", "target-uid", target);
			await sql.unsafe(`
				create function platform.reject_user_disable_audit() returns trigger
				language plpgsql as $$ begin
					if new.action = 'platform.user.disabled' then
						raise exception 'audit unavailable';
					end if;
					return new;
				end $$
			`);
			await sql.unsafe(`
				create trigger reject_user_disable_audit before insert
				on platform.audit_events for each row
				execute function platform.reject_user_disable_audit()
			`);
			await expect(
				users.setPlatformDisabled({
					actorUserId: administrator,
					targetUserId: target,
					disabled: true,
					traceId: "audit-failure",
				}),
			).rejects.toThrow("audit unavailable");
			expect(await users.isPlatformDisabled(target)).toBe(false);
		} finally {
			await sql.unsafe(
				"drop trigger if exists reject_user_disable_audit on platform.audit_events",
			);
			await sql.unsafe(
				"drop function if exists platform.reject_user_disable_audit()",
			);
			await Promise.all([ids.close(), users.close(), sql.end()]);
		}
	});

	it("persists a bounded refusal without request values or false success", async () => {
		const users = new PostgresPlatformUserDisablesV1(database.databaseUrl);
		const audit = new PostgresPlatformAuditQueryV1({
			databaseUrl: database.databaseUrl,
		});
		const sql = postgres(database.databaseUrl, { max: 1 });
		const actorUserId = randomUUID();
		const targetUserId = randomUUID();
		try {
			await users.recordRejected({
				actorUserId,
				targetUserId,
				traceId: "governance-refusal",
				requestId: "request-refusal",
				reason: "RESOURCE_UNAVAILABLE",
				outcome: "rejected",
			});
			const [record] = await sql`
				select actor_type, actor_id, action, target_type, target_id,
					outcome, details
				from platform.audit_events where trace_id = 'governance-refusal'
			`;
			expect(record).toEqual({
				actor_type: "user",
				actor_id: actorUserId,
				action: "platform.user.disable.rejected",
				target_type: "user",
				target_id: targetUserId,
				outcome: "rejected",
				details: { reason: "RESOURCE_UNAVAILABLE" },
			});
			const page = await audit.listAudit(
				{
					schemaVersion: 1,
					kind: "administrator",
					administratorId: actorUserId,
				},
				{ schemaVersion: 1, limit: 100 },
			);
			expect(
				page.items.find((item) => item.traceId === "governance-refusal"),
			).toMatchObject({
				action: "platform.user.disable.rejected",
				result: "failed",
				summary: "platform.user.disable.rejected: RESOURCE_UNAVAILABLE",
			});
			await users.recordRejected({
				actorUserId: null,
				targetUserId: null,
				traceId: "governance-anonymous-refusal",
				requestId: "request-anonymous-refusal",
				reason: "AUTHENTICATION_REQUIRED",
				outcome: "rejected",
			});
			const [anonymous] = await sql`
				select actor_type, actor_id, target_id, details
				from platform.audit_events
				where trace_id = 'governance-anonymous-refusal'
			`;
			expect(anonymous).toEqual({
				actor_type: "unknown",
				actor_id: "unresolved",
				target_id: "unresolved",
				details: { reason: "AUTHENTICATION_REQUIRED" },
			});
			const anonymousPage = await audit.listAudit(
				{
					schemaVersion: 1,
					kind: "administrator",
					administratorId: actorUserId,
				},
				{ schemaVersion: 1, limit: 100 },
			);
			expect(
				anonymousPage.items.find(
					(item) => item.traceId === "governance-anonymous-refusal",
				),
			).toMatchObject({ actor: { kind: "unknown", actorId: "unresolved" } });
		} finally {
			await Promise.all([users.close(), audit.close(), sql.end()]);
		}
	});
});
