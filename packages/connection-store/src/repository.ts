import {
	type ActionCallRecord,
	type ActionCallStatus,
	assertActionCallTransition,
	type ConnectionAuthorityRepository,
	consumerActorSentinel,
	type GrantRecord,
} from "@agent-infra/connection-core";
import { and, eq } from "drizzle-orm";

import type { ConnectionDatabase } from "./database.js";
import {
	actionCalls,
	credentialVersions,
	grantActions,
	grants,
} from "./schema.js";

function grantRecord(
	row: typeof grants.$inferSelect,
	actionVersionIds: readonly string[],
): GrantRecord {
	return {
		id: row.id,
		principalId: row.principalId,
		consumerId: row.consumerId,
		consumerInstanceId: row.consumerInstanceId,
		actorId: row.actorId,
		connectionId: row.connectionId,
		credentialVersionId: row.credentialVersionId,
		actionVersionIds,
		revision: row.revision,
		status: row.status as GrantRecord["status"],
		principalRecoveryGeneration: row.principalRecoveryGeneration,
	};
}

function actionCallRecord(
	row: typeof actionCalls.$inferSelect,
): ActionCallRecord {
	return {
		id: row.id,
		requestId: row.requestId,
		callId: row.callId,
		idempotencyKey: row.idempotencyKey,
		namespaceKey: row.namespaceKey,
		principalId: row.principalId,
		consumerId: row.consumerId,
		consumerInstanceId: row.consumerInstanceId,
		actorId: row.actorId,
		grantId: row.grantId,
		connectionId: row.connectionId,
		credentialVersionId: row.credentialVersionId,
		actionVersionId: row.actionVersionId,
		requestDigest: row.requestDigest,
		status: row.status as ActionCallStatus,
	};
}

/** PostgreSQL adapter for the Connection authority boundary. */
export function createConnectionAuthorityRepository(
	db: ConnectionDatabase,
): ConnectionAuthorityRepository {
	return {
		async findActiveGrant(context) {
			const actorId = context.actorId ?? consumerActorSentinel;
			const rows = await db
				.select()
				.from(grants)
				.where(
					and(
						eq(grants.principalId, context.principalId),
						eq(grants.consumerId, context.consumerId),
						eq(grants.consumerInstanceId, context.consumerInstanceId),
						eq(grants.actorId, actorId),
						eq(grants.connectionId, context.connectionId),
						eq(
							grants.principalRecoveryGeneration,
							context.principalRecoveryGeneration,
						),
						eq(grants.status, "active"),
					),
				)
				.limit(2);
			const row = rows[0];
			if (rows.length !== 1 || !row) return undefined;
			const [credential] = await db
				.select({ id: credentialVersions.id })
				.from(credentialVersions)
				.where(
					and(
						eq(credentialVersions.id, row.credentialVersionId),
						eq(credentialVersions.connectionId, context.connectionId),
						eq(credentialVersions.status, "active"),
					),
				)
				.limit(1);
			if (!credential) return undefined;
			const actions = await db
				.select({ actionVersionId: grantActions.actionVersionId })
				.from(grantActions)
				.where(eq(grantActions.grantId, row.id));
			if (
				!actions.some(
					(action) => action.actionVersionId === context.actionVersionId,
				)
			)
				return undefined;
			return grantRecord(
				row,
				actions.map((action) => action.actionVersionId),
			);
		},

		async findByIdempotency(namespaceKey, idempotencyKey) {
			const rows = await db
				.select()
				.from(actionCalls)
				.where(
					and(
						eq(actionCalls.namespaceKey, namespaceKey),
						eq(actionCalls.idempotencyKey, idempotencyKey),
					),
				)
				.limit(2);
			const row = rows[0];
			return rows.length === 1 && row ? actionCallRecord(row) : undefined;
		},

		async insert(record) {
			await db.insert(actionCalls).values({
				id: record.id,
				requestId: record.requestId,
				callId: record.callId,
				idempotencyKey: record.idempotencyKey,
				namespaceKey: record.namespaceKey,
				principalId: record.principalId,
				consumerId: record.consumerId,
				consumerInstanceId: record.consumerInstanceId,
				actorId: record.actorId,
				grantId: record.grantId,
				connectionId: record.connectionId,
				credentialVersionId: record.credentialVersionId,
				actionVersionId: record.actionVersionId,
				requestDigest: record.requestDigest,
				status: record.status,
			});
		},

		async transition(id, from, to) {
			assertActionCallTransition(from, to);
			const updated = await db
				.update(actionCalls)
				.set({ status: to, updatedAt: new Date() })
				.where(and(eq(actionCalls.id, id), eq(actionCalls.status, from)))
				.returning({ id: actionCalls.id });
			return updated.length === 1;
		},
	};
}
