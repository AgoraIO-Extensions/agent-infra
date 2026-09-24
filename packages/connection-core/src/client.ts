import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { BrowserSessionPrincipalStore } from "./session.js";
import { consumerActorSentinel } from "./types.js";

export class ClientAuthorizationDenied extends Error {
	constructor() {
		super("Connection client authorization denied");
		this.name = "ClientAuthorizationDenied";
	}
}

export const clientCredentialLifetimeMs = {
	access: 15 * 60_000,
	refresh: 30 * 24 * 60 * 60_000,
	pat: 30 * 24 * 60 * 60_000,
} as const;

export interface RegisteredConsumer {
	id: string;
	status: string;
	actorRequired: boolean;
	redirectUris: readonly string[];
	allowedScopes: readonly string[];
	patApproved: boolean;
}

export interface InstallationAuthorizationInput {
	consumerId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	codeChallengeMethod: string;
	scope: string;
}

export function validateInstallationAuthorization(
	input: InstallationAuthorizationInput,
	consumer: RegisteredConsumer,
): string[] {
	const scopes = input.scope.split(" ");
	if (
		consumer.status !== "active" ||
		input.consumerId !== consumer.id ||
		!consumer.redirectUris.includes(input.redirectUri) ||
		input.redirectUri.includes("#") ||
		!/^https:\/\//.test(input.redirectUri) ||
		input.state.length < 16 ||
		input.state.length > 512 ||
		input.codeChallengeMethod !== "S256" ||
		!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge) ||
		scopes.length === 0 ||
		scopes.length > 32 ||
		new Set(scopes).size !== scopes.length ||
		scopes.some(
			(scope) =>
				!/^[-A-Za-z0-9_:/.]{1,128}$/.test(scope) ||
				!consumer.allowedScopes.includes(scope),
		)
	)
		throw new ClientAuthorizationDenied();
	return scopes.sort();
}

export function decideInstallationApproval(
	request: {
		consumedAt: Date | null;
		expiresAt: Date;
		principalId: string | null;
		browserSessionHash: string | null;
		redirectUri: string;
		scopes: readonly string[];
	},
	principal: { status: string },
	consumer: RegisteredConsumer,
	now = Date.now(),
): string {
	if (
		request.consumedAt !== null ||
		request.expiresAt.getTime() <= now ||
		request.principalId !== null ||
		request.browserSessionHash !== null ||
		principal.status !== "active" ||
		consumer.status !== "active" ||
		!consumer.redirectUris.includes(request.redirectUri) ||
		request.scopes.some((scope) => !consumer.allowedScopes.includes(scope))
	)
		throw new ClientAuthorizationDenied();
	return consumer.actorRequired ? randomUUID() : consumerActorSentinel;
}

export function decideRefreshTokenUse(
	credential: {
		kind: string;
		familyId: string | null;
		consumerId: string;
		keyThumbprint: string;
		consumedAt: Date | null;
	},
	expected: { consumerId: string; keyThumbprint: string },
): { familyId: string; replayed: boolean } {
	if (
		credential.kind !== "refresh" ||
		!credential.familyId ||
		credential.consumerId !== expected.consumerId ||
		credential.keyThumbprint !== expected.keyThumbprint
	)
		throw new ClientAuthorizationDenied();
	return {
		familyId: credential.familyId,
		replayed: credential.consumedAt !== null,
	};
}

export function verifyPkceChallenge(verifier: string, challenge: string): void {
	if (
		!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
		createHash("sha256").update(verifier).digest("base64url") !== challenge
	)
		throw new ClientAuthorizationDenied();
}

export function opaqueClientSecret(): string {
	return randomBytes(32).toString("base64url");
}

export function hashClientSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

/** Recheck LDAP before each Direct credential operation; the Store transaction
 * still checks current Principal status and generation after this read. */
export async function recheckDirectClientPrincipal(
	principalId: string,
	issuer: string,
	principals: BrowserSessionPrincipalStore,
	directory: { entryExists(uid: string): Promise<boolean> },
): Promise<void> {
	const principal = await principals.findById(principalId);
	if (principal?.status !== "active" || principal.issuer !== issuer)
		throw new ClientAuthorizationDenied();
	if (!(await directory.entryExists(principal.uid))) {
		await principals.disable(principalId);
		throw new ClientAuthorizationDenied();
	}
}

export interface CurrentClientCredentialState {
	principalStatus: string;
	principalGeneration: number;
	consumerStatus: string;
	consumerPatApproved: boolean;
	instanceStatus: string;
	instancePrincipalId: string;
	instanceConsumerId: string;
	instanceGeneration: number;
	instanceKeyThumbprint: string | null;
	actorRequired: boolean;
	actorStatus: string | null;
	actorInstanceId: string | null;
	familyStatus: string | null;
}

export interface ClientCredentialClaims {
	kind: string;
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string;
	audience: string;
	scopes: readonly string[];
	keyThumbprint: string;
	principalGeneration: number;
	instanceGeneration: number;
	expiresAt: number;
	revokedAt: number | null;
	consumedAt: number | null;
}

export function assertCurrentClientBinding(
	binding: Pick<
		ClientCredentialClaims,
		| "principalId"
		| "consumerId"
		| "consumerInstanceId"
		| "actorId"
		| "keyThumbprint"
		| "principalGeneration"
		| "instanceGeneration"
	>,
	state: CurrentClientCredentialState,
): void {
	if (
		state.principalStatus !== "active" ||
		state.principalGeneration !== binding.principalGeneration ||
		state.consumerStatus !== "active" ||
		state.instanceStatus !== "active" ||
		state.instancePrincipalId !== binding.principalId ||
		state.instanceConsumerId !== binding.consumerId ||
		state.instanceGeneration !== binding.instanceGeneration ||
		state.instanceKeyThumbprint !== binding.keyThumbprint ||
		(state.actorRequired
			? state.actorStatus !== "active" ||
				state.actorInstanceId !== binding.consumerInstanceId ||
				binding.actorId === "__consumer_actor__"
			: binding.actorId !== "__consumer_actor__")
	)
		throw new ClientAuthorizationDenied();
}

export function assertCurrentClientCredential(
	credential: ClientCredentialClaims,
	state: CurrentClientCredentialState,
	input: {
		kind: "access" | "refresh" | "pat";
		audience: string;
		requiredScope?: string;
		now?: number;
	},
): void {
	assertCurrentClientBinding(credential, state);
	if (
		credential.kind !== input.kind ||
		credential.audience !== input.audience ||
		(input.requiredScope !== undefined &&
			!credential.scopes.includes(input.requiredScope)) ||
		credential.expiresAt <= (input.now ?? Date.now()) ||
		credential.revokedAt !== null ||
		credential.consumedAt !== null ||
		(input.kind === "pat" && !state.consumerPatApproved) ||
		(input.kind !== "pat" && state.familyStatus !== "active")
	)
		throw new ClientAuthorizationDenied();
}
