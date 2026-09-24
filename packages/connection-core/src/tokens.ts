import { createHash, randomBytes } from "node:crypto";

export type ConnectionTokenKind = "pat" | "oauth_access";

export interface InstallationBinding {
	id: string;
	consumerId: string;
	principalId: string;
	actorId: string | null;
	status: "active" | "revoked";
	recoveryGeneration: number;
	/** Fingerprint of the installation public key or equivalent registration secret. */
	keyFingerprint: string;
	/** Canonical public JWK used by the concrete DPoP verifier. */
	publicKeyJwk?: string;
}

export interface AccessTokenRecord {
	id: string;
	kind: ConnectionTokenKind;
	tokenHash: string;
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string | null;
	audience: string;
	scopes: readonly string[];
	recoveryGeneration: number;
	issuedAt: number;
	expiresAt: number;
	revokedAt: number | null;
	familyId: string;
}

export interface ConnectionTokenStore {
	insert(record: AccessTokenRecord): Promise<void>;
	findByHash(tokenHash: string): Promise<AccessTokenRecord | undefined>;
	revoke(id: string, at: number): Promise<void>;
	revokeFamily(familyId: string, at: number): Promise<void>;
}

export interface InstallationStore {
	findById(id: string): Promise<InstallationBinding | undefined>;
}

export interface PrincipalTokenState {
	id: string;
	status: "active" | "disabled" | "revoked";
	recoveryGeneration: number;
}

export interface PrincipalTokenStore {
	findById(id: string): Promise<PrincipalTokenState | undefined>;
}

export interface ConsumerTokenState {
	id: string;
	status: "active" | "disabled";
}

export interface ConsumerTokenStore {
	findById(id: string): Promise<ConsumerTokenState | undefined>;
}

export interface InstallationProofVerifier {
	verify(input: {
		installation: InstallationBinding;
		token: AccessTokenRecord;
		accessToken: string;
		proof: string;
		request?: { method: string; url: string };
	}): Promise<boolean> | boolean;
	verifyInstallation?(input: {
		installation: InstallationBinding;
		proof: string;
		request: { method: string; url: string };
	}): Promise<boolean> | boolean;
}

export interface AuthenticatedConnectionContext {
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string | null;
	audience: string;
	scopes: readonly string[];
	recoveryGeneration: number;
	tokenId: string;
}

export function hashConnectionToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

function hasScope(
	scopes: readonly string[],
	requiredScope: string | undefined,
): boolean {
	return requiredScope === undefined || scopes.includes(requiredScope);
}

export interface IssueTokenInput {
	kind: ConnectionTokenKind;
	installation: InstallationBinding;
	audience: string;
	scopes: readonly string[];
	recoveryGeneration: number;
	now?: number;
	lifetimeMs?: number;
	familyId?: string;
}

export class ConnectionTokenService {
	constructor(
		private readonly tokens: ConnectionTokenStore,
		private readonly installations: InstallationStore,
		private readonly principals: PrincipalTokenStore,
		private readonly consumers: ConsumerTokenStore,
		private readonly proofVerifier: InstallationProofVerifier,
		private readonly now: () => number = Date.now,
	) {}

	async issue(
		input: IssueTokenInput,
	): Promise<{ secret: string; record: AccessTokenRecord }> {
		const [installation, principal, consumer] = await Promise.all([
			this.installations.findById(input.installation.id),
			this.principals.findById(input.installation.principalId),
			this.consumers.findById(input.installation.consumerId),
		]);
		if (
			!installation ||
			installation.id !== input.installation.id ||
			installation.consumerId !== input.installation.consumerId ||
			installation.principalId !== input.installation.principalId ||
			installation.status !== "active" ||
			!principal ||
			principal.status !== "active" ||
			!consumer ||
			consumer.status !== "active"
		)
			throw new Error("installation is not active");
		if (
			input.recoveryGeneration !== installation.recoveryGeneration ||
			input.recoveryGeneration !== principal.recoveryGeneration
		)
			throw new Error("installation recovery generation mismatch");
		if (!input.audience.trim() || input.scopes.length === 0)
			throw new Error("token audience and scopes are required");
		const lifetimeMs = input.lifetimeMs ?? 15 * 60 * 1000;
		if (
			!Number.isInteger(lifetimeMs) ||
			lifetimeMs <= 0 ||
			lifetimeMs > 24 * 60 * 60 * 1000
		)
			throw new Error("token lifetime is out of range");
		const issuedAt = input.now ?? this.now();
		const secret = randomBytes(32).toString("base64url");
		const record: AccessTokenRecord = {
			id: randomBytes(16).toString("hex"),
			kind: input.kind,
			tokenHash: hashConnectionToken(secret),
			principalId: installation.principalId,
			consumerId: installation.consumerId,
			consumerInstanceId: installation.id,
			actorId: installation.actorId,
			audience: input.audience,
			scopes: [...new Set(input.scopes)],
			recoveryGeneration: input.recoveryGeneration,
			issuedAt,
			expiresAt: issuedAt + lifetimeMs,
			revokedAt: null,
			familyId: input.familyId ?? randomBytes(16).toString("hex"),
		};
		await this.tokens.insert(record);
		return { secret, record };
	}

	async authenticate(input: {
		secret: string;
		proof: string;
		audience: string;
		requiredScope?: string;
		request?: { method: string; url: string };
	}): Promise<AuthenticatedConnectionContext | undefined> {
		if (!input.secret || !input.proof || !input.audience.trim())
			return undefined;
		const token = await this.tokens.findByHash(
			hashConnectionToken(input.secret),
		);
		if (!token || token.revokedAt !== null || token.expiresAt <= this.now())
			return undefined;
		if (
			token.audience !== input.audience ||
			!hasScope(token.scopes, input.requiredScope)
		)
			return undefined;
		const [installation, principal, consumer] = await Promise.all([
			this.installations.findById(token.consumerInstanceId),
			this.principals.findById(token.principalId),
			this.consumers.findById(token.consumerId),
		]);
		if (
			installation?.status !== "active" ||
			installation.consumerId !== token.consumerId ||
			installation.principalId !== token.principalId ||
			installation.actorId !== token.actorId ||
			installation.recoveryGeneration !== token.recoveryGeneration ||
			!principal ||
			principal.status !== "active" ||
			principal.recoveryGeneration !== token.recoveryGeneration ||
			!consumer ||
			consumer.status !== "active"
		)
			return undefined;
		if (
			!(await this.proofVerifier.verify({
				installation,
				token,
				accessToken: input.secret,
				proof: input.proof,
				request: input.request,
			}))
		)
			return undefined;
		return {
			principalId: token.principalId,
			consumerId: token.consumerId,
			consumerInstanceId: token.consumerInstanceId,
			actorId: token.actorId,
			audience: token.audience,
			scopes: token.scopes,
			recoveryGeneration: token.recoveryGeneration,
			tokenId: token.id,
		};
	}

	async revoke(record: AccessTokenRecord): Promise<void> {
		await this.tokens.revoke(record.id, this.now());
	}

	async revokeFamily(record: AccessTokenRecord): Promise<void> {
		await this.tokens.revokeFamily(record.familyId, this.now());
	}
}
