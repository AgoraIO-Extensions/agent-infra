import {
	type AccessTokenRecord,
	type ActionCallRecord,
	type ActionCallStatus,
	type ActionExecutionRepository,
	type AuditEventStore,
	type AuthorizationCodeRecord,
	type AuthorizationCodeStore,
	assertActionCallTransition,
	assertDispatchTransition,
	assertEffectTransition,
	type CatalogEntry,
	type CatalogReader,
	type ConnectionAuditEvent,
	type ConnectionAuthorityRepository,
	type ConnectionTokenStore,
	type ConsumerTokenStore,
	consumerActorSentinel,
	type DpopReplayStore,
	type GrantRecord,
	type InstallationBinding,
	type InstallationRegistrar,
	type InstallationStore,
	newInstallationId,
	type PrincipalTokenStore,
	type RefreshTokenRecord,
	type RefreshTokenStore,
} from "@agent-infra/connection-core";
import type {
	BrowserSessionPrincipal,
	BrowserSessionPrincipalStore,
	BrowserSessionRecord,
	BrowserSessionStore,
	PrincipalIdentityStore,
} from "@agent-infra/connection-identity";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { ConnectionDatabase } from "./database.js";
import {
	accessTokens,
	actionCalls,
	actionVersions,
	actors,
	auditEvents,
	authorizationCodes,
	browserSessions,
	connections,
	consumerInstances,
	consumers,
	credentialVersions,
	currentGrantActions,
	dispatches,
	dpopReplay,
	effects,
	grants,
	principals,
	providerReleases,
	providers,
	refreshTokens,
} from "./schema.js";

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

export function createAuditEventStore(db: ConnectionDatabase): AuditEventStore {
	return {
		async insert(event: ConnectionAuditEvent) {
			await db.insert(auditEvents).values({
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
					event.occurredAt !== undefined
						? new Date(event.occurredAt)
						: new Date(),
			});
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
				.select({ grant: grants })
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
						eq(
							grants.principalRecoveryGeneration,
							context.principalRecoveryGeneration,
						),
						eq(grants.status, "active"),
						eq(principals.status, "active"),
						eq(
							principals.recoveryGeneration,
							context.principalRecoveryGeneration,
						),
						eq(consumers.status, "active"),
						eq(consumerInstances.status, "active"),
						eq(
							consumerInstances.recoveryGeneration,
							context.principalRecoveryGeneration,
						),
						eq(connections.status, "active"),
						eq(
							connections.currentCredentialVersionId,
							grants.credentialVersionId,
						),
						eq(credentialVersions.connectionId, grants.connectionId),
						eq(credentialVersions.status, "active"),
						eq(actionVersions.id, context.actionVersionId),
						eq(actionVersions.providerId, connections.providerId),
						eq(actionVersions.status, "published"),
						eq(providerReleases.status, "active"),
						eq(providers.status, "active"),
					),
				)
				.limit(2);
			const row = rows[0]?.grant;
			if (rows.length !== 1 || !row) return undefined;
			if (actorId !== consumerActorSentinel) {
				const [actor] = await db
					.select({ id: actors.id })
					.from(actors)
					.where(
						and(
							eq(actors.id, actorId),
							eq(actors.consumerInstanceId, context.consumerInstanceId),
							eq(actors.status, "active"),
						),
					)
					.limit(1);
				if (!actor) return undefined;
			}
			return grantRecord(row);
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
			});
		},

		async reserveExecution({ actionCall, dispatch, effect }) {
			await db.transaction(async (tx) => {
				await tx.insert(actionCalls).values({
					id: actionCall.id,
					requestId: actionCall.requestId,
					traceId: actionCall.traceId,
					callId: actionCall.callId,
					idempotencyKey: actionCall.idempotencyKey,
					namespaceKey: actionCall.namespaceKey,
					principalId: actionCall.principalId,
					consumerId: actionCall.consumerId,
					consumerInstanceId: actionCall.consumerInstanceId,
					actorId: actionCall.actorId,
					grantId: actionCall.grantId,
					connectionId: actionCall.connectionId,
					credentialVersionId: actionCall.credentialVersionId,
					actionVersionId: actionCall.actionVersionId,
					requestDigest: actionCall.requestDigest,
					status: actionCall.status,
				});
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
			});
		},

		async claimAuthorizedDispatch({
			actionCallId,
			dispatchId,
			effectId,
			grantRevision,
			principalRecoveryGeneration,
			leaseOwner,
			leaseExpiresAt,
		}) {
			class ClaimLost extends Error {}
			try {
				return await db.transaction(async (tx) => {
					const authorized = await tx
						.select({
							effect: actionVersions.effect,
							actorId: actionCalls.actorId,
							consumerInstanceId: actionCalls.consumerInstanceId,
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
								eq(grants.revision, grantRevision),
								eq(
									grants.principalRecoveryGeneration,
									principalRecoveryGeneration,
								),
								eq(grants.status, "active"),
								eq(principals.status, "active"),
								eq(principals.recoveryGeneration, principalRecoveryGeneration),
								eq(consumers.status, "active"),
								eq(consumerInstances.status, "active"),
								eq(
									consumerInstances.recoveryGeneration,
									principalRecoveryGeneration,
								),
								eq(connections.status, "active"),
								eq(
									connections.currentCredentialVersionId,
									grants.credentialVersionId,
								),
								eq(credentialVersions.connectionId, grants.connectionId),
								eq(credentialVersions.status, "active"),
								eq(actionVersions.id, actionCalls.actionVersionId),
								eq(actionVersions.providerId, connections.providerId),
								eq(actionVersions.status, "published"),
								eq(providerReleases.status, "active"),
								eq(providers.status, "active"),
							),
						)
						.limit(2)
						.for("update");
					if (
						authorized.length !== 1 ||
						(authorized[0]?.effect === "write") !== Boolean(effectId)
					)
						return false;
					const authority = authorized[0];
					if (!authority) return false;
					if (authority.actorId !== consumerActorSentinel) {
						const activeActor = await tx
							.select({ id: actors.id })
							.from(actors)
							.where(
								and(
									eq(actors.id, authority.actorId),
									eq(actors.consumerInstanceId, authority.consumerInstanceId),
									eq(actors.status, "active"),
								),
							)
							.for("update");
						if (activeActor.length !== 1) return false;
					}
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
					return true;
				});
			} catch (error) {
				if (error instanceof ClaimLost) return false;
				throw error;
			}
		},

		async failPendingDispatch(id) {
			const updated = await db
				.update(dispatches)
				.set({
					status: "failed",
					leaseOwner: null,
					leaseExpiresAt: null,
					updatedAt: new Date(),
				})
				.where(and(eq(dispatches.id, id), eq(dispatches.status, "pending")))
				.returning({ id: dispatches.id });
			return updated.length === 1;
		},

		async recordProviderOutcome({
			actionCallId,
			dispatchId,
			effectId,
			outcome,
		}) {
			const effectStatus =
				outcome.kind === "succeeded"
					? "succeeded"
					: outcome.kind === "failed"
						? "failed"
						: "unknown";
			const dispatchStatus =
				outcome.kind === "succeeded"
					? "completed"
					: outcome.kind === "failed"
						? "failed"
						: "unknown";
			const actionStatus =
				outcome.kind === "succeeded"
					? "provider_succeeded"
					: outcome.kind === "failed"
						? "provider_failed"
						: "result_pending";
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
			});
			return true;
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

export function createBrowserSessionStore(
	db: ConnectionDatabase,
): BrowserSessionStore {
	return {
		async insert(record: BrowserSessionRecord) {
			await db.insert(browserSessions).values({
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
		},
		async findByTokenHash(tokenHash) {
			const [row] = await db
				.select()
				.from(browserSessions)
				.where(eq(browserSessions.tokenHash, tokenHash))
				.limit(1);
			if (!row) return undefined;
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
		},
		async revoke(id, at) {
			await db
				.update(browserSessions)
				.set({ revokedAt: new Date(at) })
				.where(eq(browserSessions.id, id));
		},
	};
}

export function createPrincipalIdentityStore(
	db: ConnectionDatabase,
): PrincipalIdentityStore {
	return {
		async findByIssuerUid({ issuer, uid }) {
			const [row] = await db
				.select({
					id: principals.id,
					issuer: principals.issuer,
					uid: principals.uid,
					status: principals.status,
					recoveryGeneration: principals.recoveryGeneration,
				})
				.from(principals)
				.where(and(eq(principals.issuer, issuer), eq(principals.uid, uid)))
				.limit(1);
			if (!row) return undefined;
			return {
				...row,
				status: row.status as BrowserSessionPrincipal["status"],
			};
		},
		async insert(record) {
			await db.insert(principals).values({
				id: record.id,
				issuer: record.issuer,
				uid: record.uid,
				status: record.status,
				recoveryGeneration: record.recoveryGeneration,
			});
		},
	};
}

export function createBrowserSessionPrincipalStore(
	db: ConnectionDatabase,
): BrowserSessionPrincipalStore {
	return {
		async findById(id): Promise<BrowserSessionPrincipal | undefined> {
			const [row] = await db
				.select({
					id: principals.id,
					issuer: principals.issuer,
					uid: principals.uid,
					status: principals.status,
					recoveryGeneration: principals.recoveryGeneration,
				})
				.from(principals)
				.where(eq(principals.id, id))
				.limit(1);
			if (!row) return undefined;
			return {
				...row,
				status: row.status as BrowserSessionPrincipal["status"],
			};
		},
		async disable(id) {
			await db
				.update(principals)
				.set({ status: "disabled" })
				.where(eq(principals.id, id));
		},
	};
}

function tokenRecord(row: typeof accessTokens.$inferSelect): AccessTokenRecord {
	return {
		id: row.id,
		kind: row.kind as AccessTokenRecord["kind"],
		tokenHash: row.tokenHash,
		principalId: row.principalId,
		consumerId: row.consumerId,
		consumerInstanceId: row.consumerInstanceId,
		actorId: row.actorId === consumerActorSentinel ? null : row.actorId,
		audience: row.audience,
		scopes: row.scopes,
		recoveryGeneration: row.recoveryGeneration,
		issuedAt: row.issuedAt.getTime(),
		expiresAt: row.expiresAt.getTime(),
		revokedAt: row.revokedAt?.getTime() ?? null,
		familyId: row.familyId,
	};
}

export function createConnectionTokenStore(
	db: ConnectionDatabase,
): ConnectionTokenStore {
	return {
		async insert(record) {
			await db.insert(accessTokens).values({
				id: record.id,
				kind: record.kind,
				tokenHash: record.tokenHash,
				principalId: record.principalId,
				consumerId: record.consumerId,
				consumerInstanceId: record.consumerInstanceId,
				actorId: record.actorId ?? consumerActorSentinel,
				audience: record.audience,
				scopes: record.scopes,
				recoveryGeneration: record.recoveryGeneration,
				issuedAt: new Date(record.issuedAt),
				expiresAt: new Date(record.expiresAt),
				revokedAt:
					record.revokedAt === null ? null : new Date(record.revokedAt),
				familyId: record.familyId,
			});
		},
		async findByHash(tokenHash) {
			const [row] = await db
				.select()
				.from(accessTokens)
				.where(eq(accessTokens.tokenHash, tokenHash))
				.limit(1);
			return row ? tokenRecord(row) : undefined;
		},
		async revoke(id, at) {
			await db
				.update(accessTokens)
				.set({ revokedAt: new Date(at) })
				.where(eq(accessTokens.id, id));
		},
		async revokeFamily(familyId, at) {
			await db
				.update(accessTokens)
				.set({ revokedAt: new Date(at) })
				.where(eq(accessTokens.familyId, familyId));
		},
	};
}

export function createInstallationStore(
	db: ConnectionDatabase,
): InstallationStore {
	return {
		async findById(id): Promise<InstallationBinding | undefined> {
			const [row] = await db
				.select()
				.from(consumerInstances)
				.where(eq(consumerInstances.id, id))
				.limit(1);
			if (!row) return undefined;
			const actorRows = await db
				.select({ id: actors.id })
				.from(actors)
				.where(
					and(eq(actors.consumerInstanceId, id), eq(actors.status, "active")),
				);
			if (actorRows.length > 1) return undefined;
			return {
				id: row.id,
				consumerId: row.consumerId,
				principalId: row.principalId,
				actorId: actorRows[0]?.id ?? null,
				status: row.status as InstallationBinding["status"],
				recoveryGeneration: row.recoveryGeneration,
				keyFingerprint: row.installationKey,
				publicKeyJwk: row.installationPublicKey ?? undefined,
			};
		},
	};
}

export function createInstallationRegistrar(
	db: ConnectionDatabase,
): InstallationRegistrar {
	return {
		async register(input) {
			if (!input.publicKeyJwk.trim())
				throw new Error("installation public key is required");
			return db.transaction(async (tx) => {
				const [principal] = await tx
					.select({
						id: principals.id,
						recoveryGeneration: principals.recoveryGeneration,
					})
					.from(principals)
					.where(
						and(
							eq(principals.id, input.principalId),
							eq(principals.status, "active"),
						),
					)
					.limit(1);
				const [consumer] = await tx
					.select({ id: consumers.id })
					.from(consumers)
					.where(
						and(
							eq(consumers.id, input.consumerId),
							eq(consumers.status, "active"),
						),
					)
					.limit(1);
				if (!principal || !consumer)
					throw new Error("installation binding is not active");
				const id = newInstallationId();
				await tx.insert(consumerInstances).values({
					id,
					consumerId: input.consumerId,
					principalId: input.principalId,
					installationKey: input.keyFingerprint,
					installationPublicKey: input.publicKeyJwk,
					recoveryGeneration: principal.recoveryGeneration,
				});
				return {
					id,
					consumerId: input.consumerId,
					principalId: input.principalId,
					actorId: null,
					status: "active" as const,
					recoveryGeneration: principal.recoveryGeneration,
					keyFingerprint: input.keyFingerprint,
					publicKeyJwk: input.publicKeyJwk,
				};
			});
		},
	};
}

export function createDpopReplayStore(db: ConnectionDatabase): DpopReplayStore {
	return {
		async consume(jti, expiresAt) {
			const now = new Date();
			await db.delete(dpopReplay).where(lte(dpopReplay.expiresAt, now));
			const inserted = await db
				.insert(dpopReplay)
				.values({ jti, expiresAt: new Date(expiresAt) })
				.onConflictDoNothing()
				.returning({ jti: dpopReplay.jti });
			return inserted.length === 1;
		},
	};
}

function authorizationCodeRecord(
	row: typeof authorizationCodes.$inferSelect,
): AuthorizationCodeRecord {
	return {
		id: row.id,
		codeHash: row.codeHash,
		clientId: row.clientId,
		principalId: row.principalId,
		consumerId: row.consumerId,
		consumerInstanceId: row.consumerInstanceId,
		actorId: row.actorId === consumerActorSentinel ? null : row.actorId,
		redirectUri: row.redirectUri,
		codeChallenge: row.codeChallenge,
		codeChallengeMethod: "S256",
		audience: row.audience,
		scopes: row.scopes,
		recoveryGeneration: row.recoveryGeneration,
		issuedAt: row.issuedAt.getTime(),
		expiresAt: row.expiresAt.getTime(),
		consumedAt: row.consumedAt?.getTime() ?? null,
	};
}

export function createAuthorizationCodeStore(
	db: ConnectionDatabase,
): AuthorizationCodeStore {
	return {
		async insert(record) {
			await db.insert(authorizationCodes).values({
				id: record.id,
				codeHash: record.codeHash,
				clientId: record.clientId,
				principalId: record.principalId,
				consumerId: record.consumerId,
				consumerInstanceId: record.consumerInstanceId,
				actorId: record.actorId ?? consumerActorSentinel,
				redirectUri: record.redirectUri,
				codeChallenge: record.codeChallenge,
				codeChallengeMethod: record.codeChallengeMethod,
				audience: record.audience,
				scopes: record.scopes,
				recoveryGeneration: record.recoveryGeneration,
				issuedAt: new Date(record.issuedAt),
				expiresAt: new Date(record.expiresAt),
				consumedAt:
					record.consumedAt === null ? null : new Date(record.consumedAt),
			});
		},
		async findByHash(codeHash) {
			const [row] = await db
				.select()
				.from(authorizationCodes)
				.where(eq(authorizationCodes.codeHash, codeHash))
				.limit(1);
			return row ? authorizationCodeRecord(row) : undefined;
		},
		async consume(id, at) {
			const updated = await db
				.update(authorizationCodes)
				.set({ consumedAt: new Date(at) })
				.where(
					and(
						eq(authorizationCodes.id, id),
						isNull(authorizationCodes.consumedAt),
					),
				)
				.returning({ id: authorizationCodes.id });
			return updated.length === 1;
		},
	};
}

function refreshTokenRecord(
	row: typeof refreshTokens.$inferSelect,
): RefreshTokenRecord {
	return {
		id: row.id,
		tokenHash: row.tokenHash,
		familyId: row.familyId,
		principalId: row.principalId,
		consumerId: row.consumerId,
		consumerInstanceId: row.consumerInstanceId,
		actorId: row.actorId === consumerActorSentinel ? null : row.actorId,
		audience: row.audience,
		scopes: row.scopes,
		recoveryGeneration: row.recoveryGeneration,
		issuedAt: row.issuedAt.getTime(),
		expiresAt: row.expiresAt.getTime(),
		usedAt: row.usedAt?.getTime() ?? null,
		revokedAt: row.revokedAt?.getTime() ?? null,
	};
}

export function createRefreshTokenStore(
	db: ConnectionDatabase,
): RefreshTokenStore {
	return {
		async insert(record) {
			await db.insert(refreshTokens).values({
				id: record.id,
				tokenHash: record.tokenHash,
				familyId: record.familyId,
				principalId: record.principalId,
				consumerId: record.consumerId,
				consumerInstanceId: record.consumerInstanceId,
				actorId: record.actorId ?? consumerActorSentinel,
				audience: record.audience,
				scopes: record.scopes,
				recoveryGeneration: record.recoveryGeneration,
				issuedAt: new Date(record.issuedAt),
				expiresAt: new Date(record.expiresAt),
				usedAt: record.usedAt === null ? null : new Date(record.usedAt),
				revokedAt:
					record.revokedAt === null ? null : new Date(record.revokedAt),
			});
		},
		async findByHash(tokenHash) {
			const [row] = await db
				.select()
				.from(refreshTokens)
				.where(eq(refreshTokens.tokenHash, tokenHash))
				.limit(1);
			return row ? refreshTokenRecord(row) : undefined;
		},
		async consume(id, at) {
			const updated = await db
				.update(refreshTokens)
				.set({ usedAt: new Date(at) })
				.where(
					and(
						eq(refreshTokens.id, id),
						isNull(refreshTokens.usedAt),
						isNull(refreshTokens.revokedAt),
					),
				)
				.returning({ id: refreshTokens.id });
			return updated.length === 1;
		},
		async revokeFamily(familyId, at) {
			await db
				.update(refreshTokens)
				.set({ revokedAt: new Date(at) })
				.where(eq(refreshTokens.familyId, familyId));
		},
	};
}

export function createPrincipalTokenStore(
	db: ConnectionDatabase,
): PrincipalTokenStore {
	return {
		async findById(id) {
			const [row] = await db
				.select({
					id: principals.id,
					status: principals.status,
					recoveryGeneration: principals.recoveryGeneration,
				})
				.from(principals)
				.where(eq(principals.id, id))
				.limit(1);
			return row
				? { ...row, status: row.status as "active" | "disabled" | "revoked" }
				: undefined;
		},
	};
}

export function createConsumerTokenStore(
	db: ConnectionDatabase,
): ConsumerTokenStore {
	return {
		async findById(id) {
			const [row] = await db
				.select({ id: consumers.id, status: consumers.status })
				.from(consumers)
				.where(eq(consumers.id, id))
				.limit(1);
			return row
				? { ...row, status: row.status as "active" | "disabled" }
				: undefined;
		},
	};
}

export function createCatalogReader(db: ConnectionDatabase): CatalogReader {
	return {
		async list(context) {
			const actorId = context.actorId ?? consumerActorSentinel;
			const rows = await db
				.select({
					providerId: providers.id,
					providerName: providers.name,
					providerStatus: providers.status,
					actionVersionId: actionVersions.id,
					actionId: actionVersions.actionId,
					version: actionVersions.version,
					effect: actionVersions.effect,
					inputSchema: actionVersions.inputSchema,
					outputSchema: actionVersions.outputSchema,
					requiredScopes: actionVersions.requiredScopes,
					actionStatus: actionVersions.status,
				})
				.from(currentGrantActions)
				.innerJoin(
					actionVersions,
					eq(currentGrantActions.actionVersionId, actionVersions.id),
				)
				.innerJoin(providers, eq(actionVersions.providerId, providers.id))
				.innerJoin(
					providerReleases,
					eq(actionVersions.providerReleaseId, providerReleases.id),
				)
				.innerJoin(grants, eq(currentGrantActions.grantId, grants.id))
				.where(
					and(
						eq(grants.principalId, context.principalId),
						eq(grants.consumerId, context.consumerId),
						eq(grants.consumerInstanceId, context.consumerInstanceId),
						eq(grants.actorId, actorId),
						eq(grants.status, "active"),
						eq(actionVersions.status, "published"),
						eq(providerReleases.status, "active"),
						eq(providers.status, "active"),
					),
				);
			return rows
				.filter((row) =>
					row.requiredScopes.every((scope) => context.scopes.includes(scope)),
				)
				.map(
					(row): CatalogEntry => ({
						provider: {
							id: row.providerId,
							name: row.providerName,
							status: row.providerStatus as "active" | "disabled",
						},
						actionVersion: {
							id: row.actionVersionId,
							actionId: row.actionId,
							version: row.version,
							effect: row.effect as "read" | "write",
							inputSchema: row.inputSchema,
							outputSchema: row.outputSchema,
							requiredScopes: row.requiredScopes,
							status: row.actionStatus as "published" | "disabled",
						},
					}),
				);
		},
	};
}
