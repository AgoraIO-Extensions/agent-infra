import { createHash, randomBytes } from "node:crypto";
import type { AuthenticatedConnectionContext } from "./tokens.js";

export interface AuthorizationCodeRecord {
	id: string;
	codeHash: string;
	clientId: string;
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string | null;
	redirectUri: string;
	codeChallenge: string;
	codeChallengeMethod: "S256";
	audience: string;
	scopes: readonly string[];
	recoveryGeneration: number;
	issuedAt: number;
	expiresAt: number;
	consumedAt: number | null;
}

export interface AuthorizationCodeStore {
	insert(record: AuthorizationCodeRecord): Promise<void>;
	findByHash(codeHash: string): Promise<AuthorizationCodeRecord | undefined>;
	consume(id: string, at: number): Promise<boolean>;
}

export interface RefreshTokenRecord {
	id: string;
	tokenHash: string;
	familyId: string;
	principalId: string;
	consumerId: string;
	consumerInstanceId: string;
	actorId: string | null;
	audience: string;
	scopes: readonly string[];
	recoveryGeneration: number;
	issuedAt: number;
	expiresAt: number;
	usedAt: number | null;
	revokedAt: number | null;
}

export interface RefreshTokenStore {
	insert(record: RefreshTokenRecord): Promise<void>;
	findByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined>;
	consume(id: string, at: number): Promise<boolean>;
	revokeFamily(familyId: string, at: number): Promise<void>;
}

export interface OAuthCodeContext extends AuthenticatedConnectionContext {
	clientId: string;
	redirectUri: string;
}

export function hashOAuthSecret(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function pkceChallenge(verifier: string): string {
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
		throw new Error("PKCE verifier is invalid");
	return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function randomSecret(): string {
	return randomBytes(32).toString("base64url");
}

function codeContext(record: AuthorizationCodeRecord): OAuthCodeContext {
	return {
		principalId: record.principalId,
		consumerId: record.consumerId,
		consumerInstanceId: record.consumerInstanceId,
		actorId: record.actorId,
		audience: record.audience,
		scopes: record.scopes,
		recoveryGeneration: record.recoveryGeneration,
		tokenId: record.id,
		clientId: record.clientId,
		redirectUri: record.redirectUri,
	};
}

function refreshContext(record: RefreshTokenRecord): OAuthCodeContext {
	return {
		principalId: record.principalId,
		consumerId: record.consumerId,
		consumerInstanceId: record.consumerInstanceId,
		actorId: record.actorId,
		audience: record.audience,
		scopes: record.scopes,
		recoveryGeneration: record.recoveryGeneration,
		tokenId: record.id,
		clientId: "refresh",
		redirectUri: "",
	};
}

export class OAuthAuthorizationService {
	constructor(
		private readonly codes: AuthorizationCodeStore,
		private readonly refreshTokens: RefreshTokenStore,
		private readonly now: () => number = Date.now,
	) {}

	async issueAuthorizationCode(input: {
		clientId: string;
		principalId: string;
		consumerId: string;
		consumerInstanceId: string;
		actorId: string | null;
		redirectUri: string;
		codeChallenge: string;
		audience: string;
		scopes: readonly string[];
		recoveryGeneration: number;
		lifetimeMs?: number;
	}): Promise<{ secret: string; record: AuthorizationCodeRecord }> {
		if (
			!input.clientId.trim() ||
			!input.principalId.trim() ||
			!input.consumerId.trim() ||
			!input.consumerInstanceId.trim() ||
			!input.redirectUri.trim() ||
			!input.audience.trim() ||
			!/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)
		)
			throw new Error("authorization code binding is incomplete");
		const lifetimeMs = input.lifetimeMs ?? 60_000;
		if (
			!Number.isInteger(lifetimeMs) ||
			lifetimeMs <= 0 ||
			lifetimeMs > 10 * 60_000
		)
			throw new Error("authorization code lifetime is out of range");
		const secret = randomSecret();
		const issuedAt = this.now();
		const record: AuthorizationCodeRecord = {
			id: randomBytes(16).toString("hex"),
			codeHash: hashOAuthSecret(secret),
			clientId: input.clientId,
			principalId: input.principalId,
			consumerId: input.consumerId,
			consumerInstanceId: input.consumerInstanceId,
			actorId: input.actorId,
			redirectUri: input.redirectUri,
			codeChallenge: input.codeChallenge,
			codeChallengeMethod: "S256",
			audience: input.audience,
			scopes: [...new Set(input.scopes)],
			recoveryGeneration: input.recoveryGeneration,
			issuedAt,
			expiresAt: issuedAt + lifetimeMs,
			consumedAt: null,
		};
		await this.codes.insert(record);
		return { secret, record };
	}

	async redeemAuthorizationCode(input: {
		secret: string;
		clientId: string;
		redirectUri: string;
		codeVerifier: string;
	}): Promise<OAuthCodeContext | undefined> {
		const context = await this.inspectAuthorizationCode(input);
		if (!context) return undefined;
		if (!(await this.codes.consume(context.tokenId, this.now())))
			return undefined;
		return context;
	}

	async inspectAuthorizationCode(input: {
		secret: string;
		clientId: string;
		redirectUri: string;
		codeVerifier: string;
	}): Promise<OAuthCodeContext | undefined> {
		const record = await this.codes.findByHash(hashOAuthSecret(input.secret));
		if (
			!record ||
			record.consumedAt !== null ||
			record.expiresAt <= this.now() ||
			record.clientId !== input.clientId ||
			record.redirectUri !== input.redirectUri ||
			pkceChallenge(input.codeVerifier) !== record.codeChallenge
		)
			return undefined;
		return codeContext(record);
	}

	async issueRefreshToken(
		context: OAuthCodeContext,
		lifetimeMs = 30 * 24 * 60 * 60 * 1000,
		familyId = randomBytes(16).toString("hex"),
	): Promise<{ secret: string; record: RefreshTokenRecord }> {
		if (!Number.isInteger(lifetimeMs) || lifetimeMs <= 0)
			throw new Error("refresh token lifetime is invalid");
		const secret = randomSecret();
		const issuedAt = this.now();
		const record: RefreshTokenRecord = {
			id: randomBytes(16).toString("hex"),
			tokenHash: hashOAuthSecret(secret),
			familyId,
			principalId: context.principalId,
			consumerId: context.consumerId,
			consumerInstanceId: context.consumerInstanceId,
			actorId: context.actorId,
			audience: context.audience,
			scopes: context.scopes,
			recoveryGeneration: context.recoveryGeneration,
			issuedAt,
			expiresAt: issuedAt + lifetimeMs,
			usedAt: null,
			revokedAt: null,
		};
		await this.refreshTokens.insert(record);
		return { secret, record };
	}

	async inspectRefreshToken(
		secret: string,
	): Promise<OAuthCodeContext | undefined> {
		if (!secret) return undefined;
		const record = await this.refreshTokens.findByHash(hashOAuthSecret(secret));
		if (!record || record.expiresAt <= this.now()) return undefined;
		return refreshContext(record);
	}

	async rotateRefreshToken(input: {
		secret: string;
		context: Pick<
			AuthenticatedConnectionContext,
			| "audience"
			| "principalId"
			| "consumerId"
			| "consumerInstanceId"
			| "actorId"
			| "recoveryGeneration"
		>;
	}): Promise<{ secret: string; record: RefreshTokenRecord } | undefined> {
		const current = await this.refreshTokens.findByHash(
			hashOAuthSecret(input.secret),
		);
		if (
			!current ||
			current.revokedAt !== null ||
			current.expiresAt <= this.now() ||
			current.audience !== input.context.audience ||
			current.principalId !== input.context.principalId ||
			current.consumerId !== input.context.consumerId ||
			current.consumerInstanceId !== input.context.consumerInstanceId ||
			current.actorId !== input.context.actorId ||
			current.recoveryGeneration !== input.context.recoveryGeneration
		) {
			if (current?.familyId)
				await this.refreshTokens.revokeFamily(current.familyId, this.now());
			return undefined;
		}
		if (current.usedAt !== null) {
			await this.refreshTokens.revokeFamily(current.familyId, this.now());
			return undefined;
		}
		if (!(await this.refreshTokens.consume(current.id, this.now()))) {
			await this.refreshTokens.revokeFamily(current.familyId, this.now());
			return undefined;
		}
		const context = refreshContext(current);
		return this.issueRefreshToken(
			context,
			30 * 24 * 60 * 60 * 1000,
			current.familyId,
		);
	}
}
