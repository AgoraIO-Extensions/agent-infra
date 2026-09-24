import {
	type ActionCallRecord,
	type ActionCallStatus,
	type ActionExecutionRepository,
	type AuditEventStore,
	assertActionCallTransition,
	assertDispatchTransition,
	assertEffectTransition,
	type ConnectionAuditEvent,
	type ConnectionAuthorityRepository,
	consumerActorSentinel,
	type GrantRecord,
	isCurrentAuthority,
	outcomeStatuses,
} from "@agent-infra/connection-core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ConnectionDatabase } from "./database.js";
import {
	actionCalls,
	actionVersions,
	actors,
	auditEvents,
	connections,
	consumerInstances,
	consumers,
	credentialVersions,
	currentGrantActions,
	dispatches,
	effects,
	grants,
	principals,
	providerReleases,
	providers,
} from "./schema.js";

const authorityColumns = {
	grant: grants,
	principalStatus: principals.status,
	principalGeneration: principals.recoveryGeneration,
	consumerStatus: consumers.status,
	consumerActorRequired: consumers.actorRequired,
	instanceStatus: consumerInstances.status,
	instancePrincipalId: consumerInstances.principalId,
	instanceConsumerId: consumerInstances.consumerId,
	instanceGeneration: consumerInstances.recoveryGeneration,
	connectionStatus: connections.status,
	connectionProviderId: connections.providerId,
	currentCredentialVersionId: connections.currentCredentialVersionId,
	credentialStatus: credentialVersions.status,
	credentialConnectionId: credentialVersions.connectionId,
	actionStatus: actionVersions.status,
	actionProviderId: actionVersions.providerId,
	actionEffect: actionVersions.effect,
	providerStatus: providers.status,
	releaseStatus: providerReleases.status,
};

function grantRecord(row: typeof grants.$inferSelect): GrantRecord {
	return {
		id: row.id,
		principalId: row.principalId,
		consumerId: row.consumerId,
		consumerInstanceId: row.consumerInstanceId,
		actorId: row.actorId,
		connectionId: row.connectionId,
		credentialVersionId: row.credentialVersionId,
		actionVersionIds: row.approvedActionVersionIds,
		revision: row.revision,
		status: row.status as GrantRecord["status"],
		principalRecoveryGeneration: row.principalRecoveryGeneration,
		issuedAt: row.createdAt.getTime(),
		expiresAt: row.expiresAt.getTime(),
	};
}

function actionCallValues(record: ActionCallRecord) {
	return {
		id: record.id,
		requestId: record.requestId,
		traceId: record.traceId,
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
	};
}

function actionCallRecord(
	row: typeof actionCalls.$inferSelect,
): ActionCallRecord {
	return {
		id: row.id,
		requestId: row.requestId,
		traceId: row.traceId,
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

function auditValues(event: ConnectionAuditEvent) {
	return {
		id: event.id,
		traceId: event.traceId,
		principalId: event.principalId ?? null,
		consumerInstanceId: event.consumerInstanceId ?? null,
		actorId: event.actorId ?? null,
		action: event.action,
		targetType: event.targetType,
		targetId: event.targetId,
		outcome: event.outcome,
		metadata: event.metadata,
		occurredAt:
			event.occurredAt !== undefined ? new Date(event.occurredAt) : new Date(),
	};
}

function requireCallAudit(
	event: ConnectionAuditEvent,
	actionCallId: string,
): void {
	if (event.targetType !== "action_call" || event.targetId !== actionCallId)
		throw new Error("ActionCall audit target mismatch");
}

export function createAuditEventStore(db: ConnectionDatabase): AuditEventStore {
	return {
		async insert(event: ConnectionAuditEvent) {
			await db.insert(auditEvents).values(auditValues(event));
		},
	};
}

/** PostgreSQL adapter for the Connection authority boundary. */
export function createConnectionAuthorityRepository(
	db: ConnectionDatabase,
): ConnectionAuthorityRepository & ActionExecutionRepository {
	return {
		async findActiveGrant(context) {
			const actorId = context.actorId ?? consumerActorSentinel;
			const rows = await db
				.select(authorityColumns)
				.from(grants)
				.innerJoin(principals, eq(grants.principalId, principals.id))
				.innerJoin(consumers, eq(grants.consumerId, consumers.id))
				.innerJoin(
					consumerInstances,
					eq(grants.consumerInstanceId, consumerInstances.id),
				)
				.innerJoin(connections, eq(grants.connectionId, connections.id))
				.innerJoin(
					credentialVersions,
					eq(grants.credentialVersionId, credentialVersions.id),
				)
				.innerJoin(
					currentGrantActions,
					eq(currentGrantActions.grantId, grants.id),
				)
				.innerJoin(
					actionVersions,
					eq(currentGrantActions.actionVersionId, actionVersions.id),
				)
				.innerJoin(providers, eq(actionVersions.providerId, providers.id))
				.innerJoin(
					providerReleases,
					eq(actionVersions.providerReleaseId, providerReleases.id),
				)
				.where(
					and(
						eq(grants.principalId, context.principalId),
						eq(grants.consumerId, context.consumerId),
						eq(grants.consumerInstanceId, context.consumerInstanceId),
						eq(grants.actorId, actorId),
						eq(actionVersions.id, context.actionVersionId),
					),
				)
				.limit(2);
			const row = rows[0];
			if (rows.length !== 1 || !row) return undefined;
			let actorStatus: string | null = null;
			let actorInstanceId: string | null = null;
			if (actorId !== consumerActorSentinel) {
				const [actor] = await db
					.select({
						status: actors.status,
						instanceId: actors.consumerInstanceId,
					})
					.from(actors)
					.where(eq(actors.id, actorId))
					.limit(1);
				if (!actor) return undefined;
				actorStatus = actor.status;
				actorInstanceId = actor.instanceId;
			}
			const grant = grantRecord(row.grant);
			return isCurrentAuthority(
				grant,
				{ ...row, actorStatus, actorInstanceId },
				context,
			)
				? grant
				: undefined;
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

		async insert(record, audit) {
			requireCallAudit(audit, record.id);
			await db.transaction(async (tx) => {
				await tx.insert(actionCalls).values(actionCallValues(record));
				await tx.insert(auditEvents).values(auditValues(audit));
			});
		},

		async reserveExecution({ actionCall, dispatch, effect, audit }) {
			requireCallAudit(audit, actionCall.id);
			await db.transaction(async (tx) => {
				await tx.insert(actionCalls).values(actionCallValues(actionCall));
				await tx.insert(dispatches).values({
					id: dispatch.id,
					actionCallId: dispatch.actionCallId,
					status: dispatch.status,
					attemptCount: dispatch.attemptCount,
					leaseOwner: dispatch.leaseOwner,
					leaseExpiresAt:
						dispatch.leaseExpiresAt === null
							? null
							: new Date(dispatch.leaseExpiresAt),
				});
				if (effect)
					await tx.insert(effects).values({
						id: effect.id,
						actionCallId: effect.actionCallId,
						status: effect.status,
						providerRequestKey: effect.providerRequestKey,
						result: effect.result,
					});
				await tx.insert(auditEvents).values(auditValues(audit));
			});
		},

		async claimCurrentDispatchState({
			actionCallId,
			dispatchId,
			effectId,
			grantRevision,
			principalRecoveryGeneration,
			leaseOwner,
			leaseExpiresAt,
			audit,
		}) {
			requireCallAudit(audit, actionCallId);
			class ClaimLost extends Error {}
			try {
				return await db.transaction(async (tx) => {
					const authorized = await tx
						.select({
							...authorityColumns,
							actionCall: actionCalls,
						})
						.from(grants)
						.innerJoin(actionCalls, eq(actionCalls.grantId, grants.id))
						.innerJoin(principals, eq(grants.principalId, principals.id))
						.innerJoin(consumers, eq(grants.consumerId, consumers.id))
						.innerJoin(
							consumerInstances,
							eq(grants.consumerInstanceId, consumerInstances.id),
						)
						.innerJoin(connections, eq(grants.connectionId, connections.id))
						.innerJoin(
							credentialVersions,
							eq(grants.credentialVersionId, credentialVersions.id),
						)
						.innerJoin(
							currentGrantActions,
							eq(currentGrantActions.grantId, grants.id),
						)
						.innerJoin(
							actionVersions,
							eq(currentGrantActions.actionVersionId, actionVersions.id),
						)
						.innerJoin(providers, eq(actionVersions.providerId, providers.id))
						.innerJoin(
							providerReleases,
							eq(actionVersions.providerReleaseId, providerReleases.id),
						)
						.where(
							and(
								eq(actionCalls.id, actionCallId),
								eq(actionCalls.status, "created"),
								eq(grants.principalId, actionCalls.principalId),
								eq(grants.consumerId, actionCalls.consumerId),
								eq(grants.consumerInstanceId, actionCalls.consumerInstanceId),
								eq(grants.actorId, actionCalls.actorId),
								eq(grants.connectionId, actionCalls.connectionId),
								eq(grants.credentialVersionId, actionCalls.credentialVersionId),
								eq(actionVersions.id, actionCalls.actionVersionId),
							),
						)
						.limit(2)
						.for("update");
					if (authorized.length !== 1) return false;
					const authority = authorized[0];
					if (!authority) return false;
					let actorStatus: string | null = null;
					let actorInstanceId: string | null = null;
					if (authority.actionCall.actorId !== consumerActorSentinel) {
						const [actor] = await tx
							.select({
								status: actors.status,
								instanceId: actors.consumerInstanceId,
							})
							.from(actors)
							.where(eq(actors.id, authority.actionCall.actorId))
							.for("update");
						if (!actor) return false;
						actorStatus = actor.status;
						actorInstanceId = actor.instanceId;
					}
					if (
						!isCurrentAuthority(
							grantRecord(authority.grant),
							{ ...authority, actorStatus, actorInstanceId },
							{
								principalId: authority.actionCall.principalId,
								consumerId: authority.actionCall.consumerId,
								consumerInstanceId: authority.actionCall.consumerInstanceId,
								actorId:
									authority.actionCall.actorId === consumerActorSentinel
										? null
										: authority.actionCall.actorId,
								actionVersionId: authority.actionCall.actionVersionId,
								principalRecoveryGeneration,
								expectedGrantRevision: grantRevision,
								expectedEffectPresent: Boolean(effectId),
							},
						)
					)
						return false;
					const updatedDispatch = await tx
						.update(dispatches)
						.set({
							status: "claimed",
							attemptCount: sql`${dispatches.attemptCount} + 1`,
							leaseOwner,
							leaseExpiresAt: new Date(leaseExpiresAt),
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(dispatches.id, dispatchId),
								eq(dispatches.actionCallId, actionCallId),
								eq(dispatches.status, "pending"),
								isNull(dispatches.leaseOwner),
								isNull(dispatches.leaseExpiresAt),
							),
						)
						.returning({ id: dispatches.id });
					if (updatedDispatch.length !== 1) throw new ClaimLost();
					const updatedCall = await tx
						.update(actionCalls)
						.set({ status: "submission_started", updatedAt: new Date() })
						.where(
							and(
								eq(actionCalls.id, actionCallId),
								eq(actionCalls.status, "created"),
							),
						)
						.returning({ id: actionCalls.id });
					if (updatedCall.length !== 1) throw new ClaimLost();
					if (effectId) {
						const updatedEffect = await tx
							.update(effects)
							.set({ status: "submitted", updatedAt: new Date() })
							.where(
								and(
									eq(effects.id, effectId),
									eq(effects.actionCallId, actionCallId),
									eq(effects.status, "planned"),
								),
							)
							.returning({ id: effects.id });
						if (updatedEffect.length !== 1) throw new ClaimLost();
					}
					await tx.insert(auditEvents).values(auditValues(audit));
					return true;
				});
			} catch (error) {
				if (error instanceof ClaimLost) return false;
				throw error;
			}
		},

		async failPendingDispatch(id, audit) {
			return db.transaction(async (tx) => {
				const updated = await tx
					.update(dispatches)
					.set({
						status: "failed",
						leaseOwner: null,
						leaseExpiresAt: null,
						updatedAt: new Date(),
					})
					.where(and(eq(dispatches.id, id), eq(dispatches.status, "pending")))
					.returning({ actionCallId: dispatches.actionCallId });
				const row = updated[0];
				if (updated.length !== 1 || !row) return false;
				requireCallAudit(audit, row.actionCallId);
				await tx.insert(auditEvents).values(auditValues(audit));
				return true;
			});
		},

		async recordProviderOutcome({
			actionCallId,
			dispatchId,
			effectId,
			outcome,
			audit,
		}) {
			requireCallAudit(audit, actionCallId);
			const {
				action: actionStatus,
				dispatch: dispatchStatus,
				effect: effectStatus,
			} = outcomeStatuses(outcome);
			assertEffectTransition("submitted", effectStatus);
			assertDispatchTransition("claimed", dispatchStatus);
			assertActionCallTransition("submission_started", actionStatus);
			await db.transaction(async (tx) => {
				if (effectId) {
					const updatedEffect = await tx
						.update(effects)
						.set({
							status: effectStatus,
							...(outcome.kind === "succeeded" || outcome.kind === "failed"
								? { result: outcome.result ?? null }
								: {}),
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(effects.id, effectId),
								eq(effects.status, "submitted"),
								eq(effects.actionCallId, actionCallId),
							),
						)
						.returning({ id: effects.id });
					if (updatedEffect.length !== 1)
						throw new Error(
							"Effect outcome transition lost its compare-and-set race",
						);
				}
				const updatedDispatch = await tx
					.update(dispatches)
					.set({
						status: dispatchStatus,
						leaseOwner: null,
						leaseExpiresAt: null,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(dispatches.id, dispatchId),
							eq(dispatches.status, "claimed"),
							eq(dispatches.actionCallId, actionCallId),
						),
					)
					.returning({ id: dispatches.id });
				if (updatedDispatch.length !== 1)
					throw new Error(
						"Dispatch outcome transition lost its compare-and-set race",
					);
				const updatedCall = await tx
					.update(actionCalls)
					.set({ status: actionStatus, updatedAt: new Date() })
					.where(
						and(
							eq(actionCalls.id, actionCallId),
							eq(actionCalls.status, "submission_started"),
						),
					)
					.returning({ id: actionCalls.id });
				if (updatedCall.length !== 1)
					throw new Error(
						"ActionCall outcome transition lost its compare-and-set race",
					);
				await tx.insert(auditEvents).values(auditValues(audit));
			});
			return true;
		},

		async transition(id, from, to, audit) {
			requireCallAudit(audit, id);
			assertActionCallTransition(from, to);
			return db.transaction(async (tx) => {
				const updated = await tx
					.update(actionCalls)
					.set({ status: to, updatedAt: new Date() })
					.where(and(eq(actionCalls.id, id), eq(actionCalls.status, from)))
					.returning({ id: actionCalls.id });
				if (updated.length !== 1) return false;
				await tx.insert(auditEvents).values(auditValues(audit));
				return true;
			});
		},
	};
}
