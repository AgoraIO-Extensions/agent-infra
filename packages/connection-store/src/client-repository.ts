import { randomUUID } from "node:crypto";
import {
	assertAuthorizationCodeExchange,
	assertCurrentClientBinding,
	assertCurrentClientCredential,
	assertInstallationConsentAvailable,
	assertInstanceRevocable,
	assertPatRevocable,
	ClientAuthorizationDenied,
	clientCredentialLifetimeMs,
	consumerActorSentinel,
	decideInstallationApproval,
	decidePatIssueScopes,
	decideRefreshTokenUse,
	hashClientSecret,
	type InstallationAuthorizationInput,
	opaqueClientSecret,
	type VerifiedDpopProof,
	validateInstallationAuthorization,
} from "@agent-infra/connection-core";
import { and, eq } from "drizzle-orm";
import type { ConnectionDatabase } from "./database.js";
import {
	actors,
	auditEvents,
	clientCredentials,
	clientTokenFamilies,
	consumerInstances,
	consumers,
	dpopProofs,
	oauthAuthorizationCodes,
	oauthInstallationRequests,
	principals,
} from "./schema.js";

type ConnectionTransaction = Parameters<
	Parameters<ConnectionDatabase["transaction"]>[0]
>[0];
type Credential = typeof clientCredentials.$inferSelect;

type OAuthBinding = Pick<
	Credential,
	| "principalId"
	| "consumerId"
	| "consumerInstanceId"
	| "actorId"
	| "audience"
	| "scopes"
	| "keyThumbprint"
	| "principalGeneration"
	| "instanceGeneration"
>;

function oauthBinding(row: OAuthBinding): OAuthBinding {
	return {
		principalId: row.principalId,
		consumerId: row.consumerId,
		consumerInstanceId: row.consumerInstanceId,
		actorId: row.actorId,
		audience: row.audience,
		scopes: row.scopes,
		keyThumbprint: row.keyThumbprint,
		principalGeneration: row.principalGeneration,
		instanceGeneration: row.instanceGeneration,
	};
}

async function insertOAuthPair(
	tx: ConnectionTransaction,
	binding: OAuthBinding,
	familyId: string,
	accessToken: string,
	refreshToken: string,
) {
	for (const [kind, secret] of [
		["access", accessToken],
		["refresh", refreshToken],
	] as const)
		await tx.insert(clientCredentials).values({
			id: randomUUID(),
			tokenHash: hashClientSecret(secret),
			kind,
			familyId,
			...binding,
			expiresAt: new Date(Date.now() + clientCredentialLifetimeMs[kind]),
		});
}

async function insertPatCredential(
	tx: ConnectionTransaction,
	binding: OAuthBinding,
	secret: string,
	scopes: readonly string[],
) {
	const id = randomUUID();
	await tx.insert(clientCredentials).values({
		id,
		tokenHash: hashClientSecret(secret),
		kind: "pat",
		...oauthBinding(binding),
		scopes: [...scopes],
		expiresAt: new Date(Date.now() + clientCredentialLifetimeMs.pat),
	});
	return id;
}

async function recordProof(
	tx: ConnectionTransaction,
	proof: VerifiedDpopProof,
) {
	const inserted = await tx
		.insert(dpopProofs)
		.values({
			keyThumbprint: proof.thumbprint,
			jti: proof.jti,
			expiresAt: new Date(proof.iat * 1000 + 300_000),
		})
		.onConflictDoNothing()
		.returning({ jti: dpopProofs.jti });
	if (inserted.length !== 1) throw new ClientAuthorizationDenied();
}

async function audit(
	tx: ConnectionTransaction,
	action: string,
	targetType: string,
	targetId: string,
	principalId?: string,
	consumerInstanceId?: string,
	actorId?: string,
) {
	await tx.insert(auditEvents).values({
		id: randomUUID(),
		traceId: randomUUID(),
		principalId: principalId ?? null,
		consumerInstanceId: consumerInstanceId ?? null,
		actorId: actorId === consumerActorSentinel ? null : (actorId ?? null),
		action,
		targetType,
		targetId,
		outcome: "succeeded",
		metadata: {},
	});
}

async function currentBinding(
	tx: ConnectionTransaction,
	binding: {
		principalId: string;
		consumerId: string;
		consumerInstanceId: string;
		actorId: string;
		familyId?: string | null;
	},
) {
	const [principal] = await tx
		.select()
		.from(principals)
		.where(eq(principals.id, binding.principalId))
		.for("update");
	const [consumer] = await tx
		.select()
		.from(consumers)
		.where(eq(consumers.id, binding.consumerId))
		.for("update");
	const [instance] = await tx
		.select()
		.from(consumerInstances)
		.where(eq(consumerInstances.id, binding.consumerInstanceId))
		.for("update");
	const [actor] =
		binding.actorId === consumerActorSentinel
			? []
			: await tx
					.select()
					.from(actors)
					.where(eq(actors.id, binding.actorId))
					.for("update");
	const [family] = binding.familyId
		? await tx
				.select()
				.from(clientTokenFamilies)
				.where(eq(clientTokenFamilies.id, binding.familyId))
				.for("update")
		: [];
	if (!principal || !consumer || !instance)
		throw new ClientAuthorizationDenied();
	return {
		principalStatus: principal.status,
		principalGeneration: principal.recoveryGeneration,
		consumerStatus: consumer.status,
		consumerPatApproved: consumer.patApproved,
		instanceStatus: instance.status,
		instancePrincipalId: instance.principalId,
		instanceConsumerId: instance.consumerId,
		instanceGeneration: instance.recoveryGeneration,
		instanceKeyThumbprint: instance.installationKeyThumbprint,
		actorRequired: consumer.actorRequired,
		actorStatus: actor?.status ?? null,
		actorInstanceId: actor?.consumerInstanceId ?? null,
		familyStatus: family?.status ?? null,
	};
}

function credentialClaims(row: Credential) {
	return {
		kind: row.kind,
		principalId: row.principalId,
		consumerId: row.consumerId,
		consumerInstanceId: row.consumerInstanceId,
		actorId: row.actorId,
		audience: row.audience,
		scopes: row.scopes,
		keyThumbprint: row.keyThumbprint,
		principalGeneration: row.principalGeneration,
		instanceGeneration: row.instanceGeneration,
		expiresAt: row.expiresAt.getTime(),
		revokedAt: row.revokedAt?.getTime() ?? null,
		consumedAt: row.consumedAt?.getTime() ?? null,
	};
}

export function createConnectionClientRepository(db: ConnectionDatabase) {
	return {
		async beginInstallation(
			input: InstallationAuthorizationInput,
			proof: VerifiedDpopProof,
			audience: string,
		) {
			return db.transaction(async (tx) => {
				const [consumer] = await tx
					.select()
					.from(consumers)
					.where(eq(consumers.id, input.consumerId))
					.for("update");
				if (!consumer) throw new ClientAuthorizationDenied();
				const scopes = validateInstallationAuthorization(input, consumer);
				await recordProof(tx, proof);
				const id = opaqueClientSecret();
				await tx.insert(oauthInstallationRequests).values({
					id,
					consumerId: consumer.id,
					redirectUri: input.redirectUri,
					clientState: input.state,
					codeChallenge: input.codeChallenge,
					audience,
					scopes,
					installationKey: proof.publicKey,
					keyThumbprint: proof.thumbprint,
					expiresAt: new Date(Date.now() + 5 * 60_000),
				});
				await audit(
					tx,
					"oauth.installation_requested",
					"installation_request",
					hashClientSecret(id),
				);
				return id;
			});
		},

		async installationForConsent(id: string) {
			const [row] = await db
				.select()
				.from(oauthInstallationRequests)
				.where(eq(oauthInstallationRequests.id, id));
			if (!row) throw new ClientAuthorizationDenied();
			const [consumer] = await db
				.select()
				.from(consumers)
				.where(eq(consumers.id, row.consumerId));
			if (!consumer) throw new ClientAuthorizationDenied();
			assertInstallationConsentAvailable(row, consumer);
			return {
				consumerId: consumer.id,
				consumerName: consumer.name,
				redirectUri: row.redirectUri,
				scopes: row.scopes,
			};
		},

		async approveInstallation(
			id: string,
			principalId: string,
			browserSessionHash: string,
			code: string,
		) {
			return db.transaction(async (tx) => {
				const [request] = await tx
					.select()
					.from(oauthInstallationRequests)
					.where(eq(oauthInstallationRequests.id, id))
					.for("update");
				if (!request) throw new ClientAuthorizationDenied();
				const [principal] = await tx
					.select()
					.from(principals)
					.where(eq(principals.id, principalId))
					.for("update");
				const [consumer] = await tx
					.select()
					.from(consumers)
					.where(eq(consumers.id, request.consumerId))
					.for("update");
				if (!principal || !consumer) throw new ClientAuthorizationDenied();
				const actorId = decideInstallationApproval(
					request,
					principal,
					consumer,
				);
				const instanceId = randomUUID();
				await tx.insert(consumerInstances).values({
					id: instanceId,
					consumerId: consumer.id,
					principalId,
					installationKey: JSON.stringify(request.installationKey),
					installationKeyThumbprint: request.keyThumbprint,
					recoveryGeneration: principal.recoveryGeneration,
				});
				if (actorId !== consumerActorSentinel)
					await tx
						.insert(actors)
						.values({ id: actorId, consumerInstanceId: instanceId });
				await tx.insert(oauthAuthorizationCodes).values({
					codeHash: hashClientSecret(code),
					principalId,
					consumerId: consumer.id,
					consumerInstanceId: instanceId,
					actorId,
					redirectUri: request.redirectUri,
					codeChallenge: request.codeChallenge,
					audience: request.audience,
					scopes: request.scopes,
					keyThumbprint: request.keyThumbprint,
					principalGeneration: principal.recoveryGeneration,
					instanceGeneration: principal.recoveryGeneration,
					expiresAt: new Date(Date.now() + 60_000),
				});
				await tx
					.update(oauthInstallationRequests)
					.set({ consumedAt: new Date(), principalId, browserSessionHash })
					.where(eq(oauthInstallationRequests.id, id));
				await audit(
					tx,
					"oauth.installation_approved",
					"consumer_instance",
					instanceId,
					principalId,
					instanceId,
					actorId,
				);
				const redirect = new URL(request.redirectUri);
				redirect.searchParams.set("code", code);
				redirect.searchParams.set("state", request.clientState);
				return redirect.toString();
			});
		},

		async authorizationCode(code: string) {
			const [row] = await db
				.select()
				.from(oauthAuthorizationCodes)
				.where(eq(oauthAuthorizationCodes.codeHash, hashClientSecret(code)));
			return row;
		},

		async redeemCode(input: {
			code: string;
			verifier: string;
			consumerId: string;
			redirectUri: string;
			proof: VerifiedDpopProof;
			accessToken: string;
			refreshToken: string;
		}) {
			return db.transaction(async (tx) => {
				const [code] = await tx
					.select()
					.from(oauthAuthorizationCodes)
					.where(
						eq(oauthAuthorizationCodes.codeHash, hashClientSecret(input.code)),
					)
					.for("update");
				if (!code) throw new ClientAuthorizationDenied();
				assertAuthorizationCodeExchange(code, {
					consumerId: input.consumerId,
					redirectUri: input.redirectUri,
					keyThumbprint: input.proof.thumbprint,
					verifier: input.verifier,
				});
				const state = await currentBinding(tx, code);
				assertCurrentClientBinding(code, state);
				await recordProof(tx, input.proof);
				await tx
					.update(oauthAuthorizationCodes)
					.set({ consumedAt: new Date() })
					.where(eq(oauthAuthorizationCodes.codeHash, code.codeHash));
				const familyId = randomUUID();
				await tx.insert(clientTokenFamilies).values({ id: familyId });
				await insertOAuthPair(
					tx,
					oauthBinding(code),
					familyId,
					input.accessToken,
					input.refreshToken,
				);
				await audit(
					tx,
					"oauth.code_redeemed",
					"token_family",
					familyId,
					code.principalId,
					code.consumerInstanceId,
					code.actorId,
				);
				return { scopes: code.scopes, audience: code.audience };
			});
		},

		async credentialByToken(token: string) {
			const [row] = await db
				.select()
				.from(clientCredentials)
				.where(eq(clientCredentials.tokenHash, hashClientSecret(token)));
			return row;
		},

		async useCredential(input: {
			token: string;
			proof: VerifiedDpopProof;
			kind: "access" | "pat";
			audience: string;
			requiredScope?: string;
		}) {
			return db.transaction(async (tx) => {
				const [row] = await tx
					.select()
					.from(clientCredentials)
					.where(eq(clientCredentials.tokenHash, hashClientSecret(input.token)))
					.for("update");
				if (!row || row.keyThumbprint !== input.proof.thumbprint)
					throw new ClientAuthorizationDenied();
				const state = await currentBinding(tx, row);
				assertCurrentClientCredential(credentialClaims(row), state, {
					kind: input.kind,
					audience: input.audience,
					requiredScope: input.requiredScope,
				});
				await recordProof(tx, input.proof);
				await audit(
					tx,
					"client.credential_used",
					"client_credential",
					row.id,
					row.principalId,
					row.consumerInstanceId,
					row.actorId,
				);
				return {
					principalId: row.principalId,
					consumerId: row.consumerId,
					consumerInstanceId: row.consumerInstanceId,
					actorId: row.actorId === consumerActorSentinel ? null : row.actorId,
					scopes: row.scopes,
					credentialId: row.id,
				};
			});
		},

		async rotateRefresh(input: {
			refreshToken: string;
			proof: VerifiedDpopProof;
			audience: string;
			consumerId: string;
			accessToken: string;
			nextRefreshToken: string;
		}) {
			return db.transaction(async (tx) => {
				const [row] = await tx
					.select()
					.from(clientCredentials)
					.where(
						eq(
							clientCredentials.tokenHash,
							hashClientSecret(input.refreshToken),
						),
					)
					.for("update");
				if (!row) throw new ClientAuthorizationDenied();
				const decision = decideRefreshTokenUse(row, {
					consumerId: input.consumerId,
					keyThumbprint: input.proof.thumbprint,
				});
				if (decision.replayed) {
					await tx
						.update(clientTokenFamilies)
						.set({ status: "revoked", revokedAt: new Date() })
						.where(
							and(
								eq(clientTokenFamilies.id, decision.familyId),
								eq(clientTokenFamilies.status, "active"),
							),
						);
					await audit(
						tx,
						"oauth.refresh_replayed",
						"token_family",
						decision.familyId,
						row.principalId,
						row.consumerInstanceId,
						row.actorId,
					);
					return undefined;
				}
				const state = await currentBinding(tx, row);
				assertCurrentClientCredential(credentialClaims(row), state, {
					kind: "refresh",
					audience: input.audience,
				});
				await recordProof(tx, input.proof);
				await tx
					.update(clientCredentials)
					.set({ consumedAt: new Date() })
					.where(eq(clientCredentials.id, row.id));
				await insertOAuthPair(
					tx,
					oauthBinding(row),
					decision.familyId,
					input.accessToken,
					input.nextRefreshToken,
				);
				await audit(
					tx,
					"oauth.refresh_rotated",
					"token_family",
					decision.familyId,
					row.principalId,
					row.consumerInstanceId,
					row.actorId,
				);
				return { scopes: row.scopes };
			});
		},

		async issuePat(input: {
			accessToken: string;
			pat: string;
			audience: string;
		}) {
			return db.transaction(async (tx) => {
				const [row] = await tx
					.select()
					.from(clientCredentials)
					.where(
						eq(
							clientCredentials.tokenHash,
							hashClientSecret(input.accessToken),
						),
					)
					.for("update");
				if (!row) throw new ClientAuthorizationDenied();
				const state = await currentBinding(tx, row);
				const scopes = decidePatIssueScopes(
					credentialClaims(row),
					state,
					input.audience,
				);
				const id = await insertPatCredential(tx, row, input.pat, scopes);
				await audit(
					tx,
					"pat.issued",
					"client_credential",
					id,
					row.principalId,
					row.consumerInstanceId,
					row.actorId,
				);
				return id;
			});
		},

		async rotatePat(input: {
			currentPat: string;
			nextPat: string;
			audience: string;
		}) {
			return db.transaction(async (tx) => {
				const [row] = await tx
					.select()
					.from(clientCredentials)
					.where(
						eq(clientCredentials.tokenHash, hashClientSecret(input.currentPat)),
					)
					.for("update");
				if (!row) throw new ClientAuthorizationDenied();
				const state = await currentBinding(tx, row);
				assertCurrentClientCredential(credentialClaims(row), state, {
					kind: "pat",
					audience: input.audience,
				});
				await tx
					.update(clientCredentials)
					.set({ revokedAt: new Date() })
					.where(eq(clientCredentials.id, row.id));
				const id = await insertPatCredential(
					tx,
					row,
					input.nextPat,
					row.scopes,
				);
				await audit(
					tx,
					"pat.rotated",
					"client_credential",
					id,
					row.principalId,
					row.consumerInstanceId,
					row.actorId,
				);
				return id;
			});
		},

		async revokeFamily(accessToken: string, audience: string) {
			return db.transaction(async (tx) => {
				const [row] = await tx
					.select()
					.from(clientCredentials)
					.where(eq(clientCredentials.tokenHash, hashClientSecret(accessToken)))
					.for("update");
				if (!row?.familyId) throw new ClientAuthorizationDenied();
				const state = await currentBinding(tx, row);
				assertCurrentClientCredential(credentialClaims(row), state, {
					kind: "access",
					audience,
				});
				await tx
					.update(clientTokenFamilies)
					.set({ status: "revoked", revokedAt: new Date() })
					.where(eq(clientTokenFamilies.id, row.familyId));
				await audit(
					tx,
					"oauth.family_revoked",
					"token_family",
					row.familyId,
					row.principalId,
					row.consumerInstanceId,
					row.actorId,
				);
			});
		},

		async revokeInstance(principalId: string, instanceId: string) {
			return db.transaction(async (tx) => {
				const [principal] = await tx
					.select()
					.from(principals)
					.where(eq(principals.id, principalId))
					.for("update");
				const [instance] = await tx
					.select()
					.from(consumerInstances)
					.where(eq(consumerInstances.id, instanceId))
					.for("update");
				assertInstanceRevocable(principal, instance, principalId);
				await tx
					.update(consumerInstances)
					.set({ status: "revoked" })
					.where(eq(consumerInstances.id, instanceId));
				await audit(
					tx,
					"oauth.instance_revoked",
					"consumer_instance",
					instanceId,
					principalId,
					instanceId,
				);
			});
		},

		async revokePat(principalId: string, patId: string) {
			return db.transaction(async (tx) => {
				const [row] = await tx
					.select()
					.from(clientCredentials)
					.where(eq(clientCredentials.id, patId))
					.for("update");
				if (!row) throw new ClientAuthorizationDenied();
				assertPatRevocable(row, principalId);
				await tx
					.update(clientCredentials)
					.set({ revokedAt: new Date() })
					.where(eq(clientCredentials.id, row.id));
				await audit(
					tx,
					"pat.revoked",
					"client_credential",
					patId,
					principalId,
					row.consumerInstanceId,
					row.actorId,
				);
			});
		},
	};
}
