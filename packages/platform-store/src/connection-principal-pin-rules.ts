import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import {
	type ConnectionManualInstallationPolicyV1,
	connectionManualExceptionLiveV1,
} from "./connection-manual-installations.js";

// biome-ignore lint/suspicious/noExplicitAny: drizzle's transaction generics are internal here.
export type ConnectionPrincipalPinTransactionV1 = PgTransaction<any, any, any>;
type Transaction = ConnectionPrincipalPinTransactionV1;

function sha256(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * §13.5.1 exception items 4 and 8: whether a pin may still back new MCP permits
 * and new exception installations, at the database clock. A pin backs them
 * while it is neither released nor being released, not suspended by a
 * uniqueness conflict, not found inconsistent, verified or still inside its
 * verification window, and the exception's `notAfter` has not passed. The
 * permit write and the dynamic reader must AND this with their own checks.
 */
export function connectionPrincipalPinPermitsSql(
	pin: string,
	policy: ConnectionManualInstallationPolicyV1,
) {
	if (!/^[a-z_][a-z0-9_]*$/.test(pin)) throw new TypeError("pin alias");
	const p = sql.raw(pin);
	return sql`(${p}.released_at is null and ${p}.release_requested_at is null
		and ${p}.suspended_at is null and ${p}.verification_state <> 'mismatch'
		and (${p}.verification_state = 'verified' or ${p}.verification_deadline > clock_timestamp())
		and ${connectionManualExceptionLiveV1(policy)})`;
}

/** First-pin verification deadline: database clock plus the approved window. */
export function connectionPrincipalPinDeadlineSql(
	policy: ConnectionManualInstallationPolicyV1,
) {
	return sql`clock_timestamp() + make_interval(hours => ${policy.dynamic.principalMapping.verificationWindowHours}::int)`;
}

/**
 * The installation holds a registered Connection client and is not yet
 * closing: confirmed, or still awaiting the original user's confirmation.
 */
const closable = sql`a.status in ('awaiting_confirmation', 'confirmed') and m.revoke_state='not_required'
	and m.registration_state='registered'`;

/** The pin's user still has an installation this pass can close. */
const userHasClosable = sql`exists (select 1 from platform.connection_manual_installations m
	join platform.connection_installation_authorizations a on a.id=m.authorization_id
	where m.user_id=connection_principal_pins.user_id and ${closable})`;

/**
 * The pin's user still has an installation that may hold a client without a
 * settled revoke: an unsettled revoke, or a live installation whose
 * registration is in flight, unknown or registered. An unknown registration
 * waits for its original-key status verification; it never counts as absent.
 */
const userHasOutstanding = sql`exists (select 1 from platform.connection_manual_installations m
	join platform.connection_installation_authorizations a on a.id=m.authorization_id
	where m.user_id=connection_principal_pins.user_id
		and (m.revoke_state in ('pending', 'sending', 'unknown')
			or (m.revoke_state='not_required' and m.registration_state in ('sending', 'registered', 'unknown')
				and a.status in ('preparing', 'awaiting_confirmation', 'confirmed'))))`;

/**
 * Closes exception installations that hold a registered client and queues
 * their revoke with the original key (§13.5.7 per-installation revoke), as the
 * refused-candidate path does. Commands of the installation that were never
 * claimed are refused so they cannot hold the revoke behind them; a claimed
 * one settles or expires first. In-flight preparations meet the pin rules at
 * their own phase-1 CAS. The Worker drain sends the DELETE; an unknown result
 * is only verified with the same key, never resent under a new one.
 */
export async function closeConnectionExceptionInstallationsV1(
	tx: Transaction,
	input: {
		readonly userId?: string;
		readonly reason: string;
		readonly limit?: number;
	},
): Promise<number> {
	const closed = await tx.execute(sql`
		select a.id from platform.connection_installation_authorizations a
		join platform.connection_manual_installations m on m.authorization_id=a.id
		where ${closable}
			and (${input.userId ?? null}::text is null or m.user_id=${input.userId ?? null})
		order by a.id
		limit ${input.limit ?? 64}
		for update of a, m skip locked
	`);
	for (const { id } of closed) {
		const authorizationId = id as string;
		await tx.execute(sql`
			update platform.connection_installation_authorizations set status='revoked', revision=revision+1,
				updated_at=clock_timestamp() where id=${authorizationId} and status in ('awaiting_confirmation', 'confirmed')
		`);
		await tx.execute(sql`
			update platform.connection_installation_commands set status='rejected', updated_at=clock_timestamp()
			where authorization_id=${authorizationId} and status='pending' and attempt_id is null
				and command <> 'revoke'
		`);
		await tx.execute(sql`
			update platform.connection_manual_installations set revoke_state='pending', revision=revision+1,
				updated_at=clock_timestamp() where authorization_id=${authorizationId} and revoke_state='not_required'
		`);
		await tx.execute(sql`
			insert into platform.connection_installation_commands
				(id, authorization_id, command, idempotency_key, request_digest, status)
			values (${randomUUID()}, ${authorizationId}, 'revoke', ${`manual-revoke:${authorizationId}`},
				${sha256(JSON.stringify(["revoke", input.reason, authorizationId]))}, 'pending')
			on conflict (authorization_id, command, idempotency_key) do nothing
		`);
	}
	return closed.length;
}

export async function insertConnectionPrincipalPinAuditV1(
	tx: Transaction,
	input: {
		readonly action: string;
		readonly pinId: string;
		readonly actor: { readonly type: "user" | "system"; readonly id: string };
		readonly outcome: "succeeded" | "rejected" | "failed";
		readonly requestId?: string;
		readonly traceId?: string;
		readonly details: Record<string, unknown>;
	},
) {
	const id = randomUUID();
	await tx.execute(sql`
		insert into platform.audit_events
			(id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, details)
		values (${id}, ${input.traceId ?? id}, ${input.actor.type}, ${input.actor.id},
			${`connection.principal_pin.${input.action}`}, 'connection_principal_pin', ${input.pinId},
			${input.outcome}, ${input.requestId ?? id}, ${JSON.stringify(input.details)}::jsonb)
	`);
}

/**
 * One bounded pass of the exception item 4 and 8 rules, run with the drain's
 * recovery sweep (§13.5.1):
 *
 * - past `notAfter`, every confirmed exception installation closes and revokes;
 * - a pin still "主体待核对" past its deadline closes and revokes the user's
 *   exception installations and is marked overdue once; it stays pinned and is
 *   released only by the audited unpin (item 6);
 * - a requested release completes only after every installation of the user
 *   is closed and its revoke settled; an unknown revoke keeps the pin until it
 *   is verified with the original key.
 */
export async function sweepConnectionPrincipalPinRulesV1(
	tx: Transaction,
	policy: ConnectionManualInstallationPolicyV1,
) {
	const [expired] = await tx.execute(sql`
		select ${policy.dynamic.principalMapping.notAfter}::timestamptz <= clock_timestamp() as past
	`);
	if (expired?.past === true)
		await closeConnectionExceptionInstallationsV1(tx, {
			reason: "exception-expired",
		});
	// An overdue pin already marked and with nothing left to close drops out of
	// the candidates, so a batch never keeps re-selecting the same pins.
	const overdue = await tx.execute(sql`
		select id, user_id, overdue_at from platform.connection_principal_pins
		where released_at is null and verification_state='pending'
			and verification_deadline <= clock_timestamp()
			and (overdue_at is null or ${userHasClosable})
		order by id limit 32
		for update skip locked
	`);
	for (const pin of overdue) {
		await closeConnectionExceptionInstallationsV1(tx, {
			userId: pin.user_id as string,
			reason: "principal-verification-overdue",
		});
		if (pin.overdue_at === null) {
			await tx.execute(sql`
				update platform.connection_principal_pins set overdue_at=clock_timestamp()
				where id=${pin.id as string} and overdue_at is null
			`);
			await insertConnectionPrincipalPinAuditV1(tx, {
				action: "verification_overdue",
				pinId: pin.id as string,
				actor: { type: "system", id: "platform-worker" },
				outcome: "succeeded",
				details: { userId: pin.user_id },
			});
		}
	}
	// Only releases this pass can advance: something left to close, or nothing
	// outstanding. A pin waiting on an unsettled revoke does not hold a slot.
	const releasing = await tx.execute(sql`
		select id, user_id, release_reason from platform.connection_principal_pins
		where released_at is null and release_requested_at is not null
			and (${userHasClosable} or not ${userHasOutstanding})
		order by id limit 32
		for update skip locked
	`);
	for (const pin of releasing) {
		const userId = pin.user_id as string;
		await closeConnectionExceptionInstallationsV1(tx, {
			userId,
			reason: "principal-pin-release",
		});
		const [outstanding] = await tx.execute(sql`
			select ${userHasOutstanding} as open
			from platform.connection_principal_pins where id=${pin.id as string}
		`);
		if (outstanding?.open !== false) continue;
		const released = await tx.execute(sql`
			update platform.connection_principal_pins set released_at=clock_timestamp(), revision=revision+1
			where id=${pin.id as string} and released_at is null and release_requested_at is not null
			returning id
		`);
		if (released.length === 1)
			await insertConnectionPrincipalPinAuditV1(tx, {
				action: "released",
				pinId: pin.id as string,
				actor: { type: "system", id: "platform-worker" },
				outcome: "succeeded",
				details: { userId, reason: pin.release_reason },
			});
	}
}
