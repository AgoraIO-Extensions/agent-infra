import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	hkdfSync,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";

export type DirectoryIdentity = {
	displayName: string;
	email: string | null;
	issuer: string;
	subject: string;
};

export const oauthAuthorizationRequestUnavailableMessage =
	"Authorization request expired or is no longer valid. Start a new sign-in from your client.";

export interface DirectoryAuthenticator {
	authenticate(username: string, password: string): Promise<DirectoryIdentity>;
	isActive(identity: { issuer: string; subject: string }): Promise<boolean>;
}

export type OAuthClientRegistration = {
	clientId: string;
	clientName: string;
	consumerId: string;
	consumerName: string;
	instanceId: string;
	redirectUris: string[];
};

export type OAuthAuthorizationRecord = {
	clientId: string;
	codeChallenge: string;
	consumerId: string;
	expiresAt: Date;
	redirectUri: string;
	requestId: string;
	resource: string;
	scope: string;
	state: string;
};

export type OAuthTokenIdentity = {
	consumerId: string;
	identityReference: string;
	instanceId: string;
	lastVerifiedAt: Date;
	principalId: string;
	recoveryGeneration: string;
	resource: string | null;
};

export type BrowserSessionIdentity = {
	displayName: string;
	email: string | null;
	identityIssuer: string;
	identityReference: string;
	lastVerifiedAt: Date;
	principalId: string;
	recoveryGeneration: string;
};

export type PersonalAccessTokenRecord = {
	createdAt: Date;
	expiresAt: Date;
	lastUsedAt: Date | null;
	name: string;
	status: "ACTIVE" | "EXPIRED" | "REVOKED";
	tokenId: string;
};

export interface ConnectionOAuthRepository {
	approveAuthorization(input: {
		codeHash: string;
		displayName: string;
		email: string | null;
		identityIssuer: string;
		identityReference: string;
		identitySubjectHash: string;
		legacyIdentitySubjectHash: string;
		principalId: string;
		requestId: string;
	}): Promise<{ redirectUri: string; state: string }>;
	consumeAuthorizationCode(input: {
		accessTokenExpiresAt: Date;
		accessTokenHash: string;
		clientId: string;
		codeHash: string;
		codeVerifier: string;
		familyId: string;
		redirectUri: string;
		refreshTokenExpiresAt: Date;
		refreshTokenHash: string;
		resource: string;
	}): Promise<OAuthTokenIdentity>;
	createBrowserSession(input: {
		displayName: string;
		email: string | null;
		expiresAt: Date;
		identityIssuer: string;
		identityReference: string;
		identitySubjectHash: string;
		legacyIdentitySubjectHash: string;
		principalId: string;
		sessionHash: string;
		sessionId: string;
	}): Promise<BrowserSessionIdentity>;
	createAuthorization(record: OAuthAuthorizationRecord): Promise<void>;
	disablePrincipal(principalId: string): Promise<void>;
	findClient(clientId: string): Promise<OAuthClientRegistration | undefined>;
	issuePersonalAccessToken(input: {
		browserSessionHash: string;
		consumerId: string;
		consumerName: string;
		instanceId: string;
		name: string;
		tokenHash: string;
		tokenId: string;
		ttlMs: number;
	}): Promise<{ expiresAt: Date }>;
	listPersonalAccessTokens(
		browserSessionHash: string,
	): Promise<PersonalAccessTokenRecord[]>;
	readRefreshToken(input: {
		clientId: string;
		refreshTokenHash: string;
		resource: string;
	}): Promise<OAuthTokenIdentity>;
	requirePendingAuthorization(requestId: string): Promise<void>;
	registerClient(client: OAuthClientRegistration): Promise<void>;
	resolveBrowserSession(sessionHash: string): Promise<BrowserSessionIdentity>;
	resolveAccessToken(accessTokenHash: string): Promise<OAuthTokenIdentity>;
	revokeBrowserSession(sessionHash: string): Promise<void>;
	revokeInstance(input: {
		consumerId: string;
		instanceId: string;
		principalId: string;
	}): Promise<void>;
	revokeToken(tokenHash: string): Promise<void>;
	revokePersonalAccessToken(input: {
		browserSessionHash: string;
		tokenId: string;
	}): Promise<void>;
	rotateRefreshToken(input: {
		accessTokenExpiresAt: Date;
		accessTokenHash: string;
		clientId: string;
		oldRefreshTokenHash: string;
		refreshTokenExpiresAt: Date;
		refreshTokenHash: string;
		resource: string;
	}): Promise<OAuthTokenIdentity>;
	touchPrincipalVerification(
		principalId: string,
		verifiedAt: Date,
	): Promise<void>;
}

export class OAuthProtocolError extends Error {
	constructor(
		readonly error:
			| "access_denied"
			| "invalid_client"
			| "invalid_grant"
			| "invalid_request"
			| "invalid_token"
			| "unsupported_grant_type",
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

type OAuthServiceOptions = {
	accessTokenTtlMs?: number;
	authorizationCodeTtlMs?: number;
	consumer: { id: string; name: string };
	directory: DirectoryAuthenticator;
	identityEnvironment: string;
	identityKey: Uint8Array;
	principalFreshnessMs?: number;
	refreshTokenTtlMs?: number;
	repository: ConnectionOAuthRepository;
	resource: string;
	scopes?: string[];
};

const defaultAccessTokenTtlMs = 5 * 60_000;
const defaultAuthorizationCodeTtlMs = 2 * 60_000;
const defaultBrowserSessionTtlMs = 12 * 60 * 60_000;
const defaultPersonalAccessTokenTtlMs = 90 * 24 * 60 * 60_000;
const defaultRefreshTokenTtlMs = 30 * 24 * 60 * 60_000;
const defaultPrincipalFreshnessMs = 60_000;
const identitySubjectHashVersion = "v1";
export const portablePatConsumerId = "consumer-portable-pat";

const portablePatConsumer = {
	id: portablePatConsumerId,
	name: "Portable Connection PAT",
};

function opaqueToken() {
	return randomBytes(32).toString("base64url");
}

function tokenHash(token: string) {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

function pkceChallenge(verifier: string) {
	return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function constantTimeEqual(left: string, right: string) {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return (
		leftBytes.length === rightBytes.length &&
		timingSafeEqual(leftBytes, rightBytes)
	);
}

function parseBearer(authorization: string | undefined) {
	const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(authorization ?? "");
	if (!match?.[1]) {
		throw new OAuthProtocolError(
			"invalid_token",
			"Bearer token is required",
			401,
		);
	}
	return match[1];
}

function assertRedirectUri(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new OAuthProtocolError("invalid_request", "Invalid redirect_uri");
	}
	const loopback =
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "[::1]");
	if (
		(!loopback && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new OAuthProtocolError("invalid_request", "Invalid redirect_uri");
	}
	return url.toString();
}

function validateClientName(value: string) {
	const name = value.trim();
	if (name.length < 1 || name.length > 100) {
		throw new OAuthProtocolError("invalid_request", "Invalid client_name");
	}
	return name;
}

class IdentityProtector {
	private readonly encryptionKey: Buffer;
	private readonly subjectKey: Buffer;

	constructor(key: Uint8Array) {
		if (key.byteLength !== 32) {
			throw new Error("Connection identity key must contain exactly 32 bytes");
		}
		this.encryptionKey = Buffer.from(
			hkdfSync(
				"sha256",
				key,
				Buffer.alloc(0),
				"connection-identity-encryption",
				32,
			),
		);
		this.subjectKey = Buffer.from(
			hkdfSync(
				"sha256",
				key,
				Buffer.alloc(0),
				"connection-identity-subject",
				32,
			),
		);
	}

	protect(identity: { issuer: string; subject: string }) {
		const plaintext = Buffer.from(JSON.stringify(identity), "utf8");
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
		const ciphertext = Buffer.concat([
			cipher.update(plaintext),
			cipher.final(),
		]);
		plaintext.fill(0);
		return [nonce, cipher.getAuthTag(), ciphertext]
			.map((part) => part.toString("base64url"))
			.join(".");
	}

	unprotect(value: string): { issuer: string; subject: string } {
		const [nonceValue, tagValue, ciphertextValue] = value.split(".");
		if (!nonceValue || !tagValue || !ciphertextValue) {
			throw new OAuthProtocolError(
				"invalid_token",
				"Invalid identity binding",
				401,
			);
		}
		try {
			const decipher = createDecipheriv(
				"aes-256-gcm",
				this.encryptionKey,
				Buffer.from(nonceValue, "base64url"),
			);
			decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
			const plaintext = Buffer.concat([
				decipher.update(Buffer.from(ciphertextValue, "base64url")),
				decipher.final(),
			]);
			const identity = JSON.parse(plaintext.toString("utf8")) as {
				issuer?: unknown;
				subject?: unknown;
			};
			plaintext.fill(0);
			if (
				typeof identity.issuer !== "string" ||
				typeof identity.subject !== "string"
			) {
				throw new Error("invalid identity");
			}
			return { issuer: identity.issuer, subject: identity.subject };
		} catch {
			throw new OAuthProtocolError(
				"invalid_token",
				"Invalid identity binding",
				401,
			);
		}
	}

	subjectHash(
		environment: string,
		identity: { issuer: string; subject: string },
	) {
		const canonical = JSON.stringify([
			identitySubjectHashVersion,
			environment.normalize("NFC"),
			identity.issuer.normalize("NFC"),
			identity.subject.normalize("NFC"),
		]);
		return `${identitySubjectHashVersion}:${createHmac(
			"sha256",
			this.subjectKey,
		)
			.update(canonical, "utf8")
			.digest("hex")}`;
	}

	legacySubjectHash(identity: { issuer: string; subject: string }) {
		return createHmac("sha256", this.subjectKey)
			.update(identity.issuer, "utf8")
			.update("\0")
			.update(identity.subject, "utf8")
			.digest("hex");
	}
}

export function deriveConnectionIdentitySubjectHash(input: {
	environment: string;
	identity: { issuer: string; subject: string };
	key: Uint8Array;
}) {
	return new IdentityProtector(input.key).subjectHash(
		input.environment,
		input.identity,
	);
}

export class ConnectionOAuthService {
	private readonly accessTokenTtlMs: number;
	private readonly authorizationCodeTtlMs: number;
	private readonly principalFreshnessMs: number;
	private readonly protector: IdentityProtector;
	private readonly refreshTokenTtlMs: number;
	private readonly scopes: Set<string>;

	constructor(private readonly options: OAuthServiceOptions) {
		if (
			options.identityEnvironment.length < 1 ||
			options.identityEnvironment.length > 512
		) {
			throw new Error("Connection identity environment is invalid");
		}
		this.accessTokenTtlMs = options.accessTokenTtlMs ?? defaultAccessTokenTtlMs;
		this.authorizationCodeTtlMs =
			options.authorizationCodeTtlMs ?? defaultAuthorizationCodeTtlMs;
		this.principalFreshnessMs =
			options.principalFreshnessMs ?? defaultPrincipalFreshnessMs;
		this.refreshTokenTtlMs =
			options.refreshTokenTtlMs ?? defaultRefreshTokenTtlMs;
		this.scopes = new Set(options.scopes ?? ["mcp"]);
		this.protector = new IdentityProtector(options.identityKey);
	}

	async registerClient(input: { clientName: string; redirectUris: string[] }) {
		if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
			throw new OAuthProtocolError(
				"invalid_request",
				"redirect_uris are required",
			);
		}
		const client: OAuthClientRegistration = {
			clientId: opaqueToken(),
			clientName: validateClientName(input.clientName),
			consumerId: this.options.consumer.id,
			consumerName: validateClientName(this.options.consumer.name),
			instanceId: `instance-${randomUUID()}`,
			redirectUris: [...new Set(input.redirectUris.map(assertRedirectUri))],
		};
		await this.options.repository.registerClient(client);
		return client;
	}

	async registerTrustedClient(client: OAuthClientRegistration) {
		await this.options.repository.registerClient({
			...client,
			clientName: validateClientName(client.clientName),
			consumerName: validateClientName(client.consumerName),
			redirectUris: [...new Set(client.redirectUris.map(assertRedirectUri))],
		});
	}

	async beginAuthorization(input: {
		clientId: string;
		codeChallenge: string;
		codeChallengeMethod: string;
		redirectUri: string;
		resource: string;
		responseType: string;
		scope: string;
		state: string;
	}) {
		if (
			input.responseType !== "code" ||
			input.codeChallengeMethod !== "S256" ||
			!/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge) ||
			!/^[\u0021-\u007e]{16,512}$/.test(input.state)
		) {
			throw new OAuthProtocolError(
				"invalid_request",
				"Invalid authorization request",
			);
		}
		if (input.resource !== this.options.resource) {
			throw new OAuthProtocolError("invalid_request", "Invalid resource");
		}
		const requestedScopes = input.scope.split(/\s+/).filter(Boolean);
		if (
			requestedScopes.length === 0 ||
			requestedScopes.some((scope) => !this.scopes.has(scope))
		) {
			throw new OAuthProtocolError("invalid_request", "Invalid scope");
		}
		const client = await this.options.repository.findClient(input.clientId);
		const redirectUri = assertRedirectUri(input.redirectUri);
		if (!client?.redirectUris.includes(redirectUri)) {
			throw new OAuthProtocolError(
				"invalid_client",
				"Unknown OAuth client",
				401,
			);
		}
		const authorization: OAuthAuthorizationRecord = {
			clientId: client.clientId,
			codeChallenge: input.codeChallenge,
			consumerId: client.consumerId,
			expiresAt: new Date(Date.now() + this.authorizationCodeTtlMs),
			redirectUri,
			requestId: opaqueToken(),
			resource: input.resource,
			scope: requestedScopes.join(" "),
			state: input.state,
		};
		await this.options.repository.createAuthorization(authorization);
		return {
			clientName: client.clientName,
			requestId: authorization.requestId,
		};
	}

	async approveAuthorization(input: {
		password: string;
		requestId: string;
		username: string;
	}) {
		if (!/^[A-Za-z0-9_-]{43}$/.test(input.requestId)) {
			throw new OAuthProtocolError(
				"invalid_request",
				oauthAuthorizationRequestUnavailableMessage,
			);
		}
		await this.options.repository.requirePendingAuthorization(input.requestId);
		const identity = await this.authenticateDirectory(
			input.username,
			input.password,
		);
		const code = opaqueToken();
		const identitySubjectHash = this.protector.subjectHash(
			this.options.identityEnvironment,
			identity,
		);
		const authorization = await this.options.repository.approveAuthorization({
			codeHash: tokenHash(code),
			displayName: identity.displayName,
			email: identity.email,
			identityIssuer: identity.issuer,
			identityReference: this.protector.protect(identity),
			identitySubjectHash,
			legacyIdentitySubjectHash: this.protector.legacySubjectHash(identity),
			principalId: randomUUID(),
			requestId: input.requestId,
		});
		return { code, ...authorization };
	}

	async loginBrowserSession(input: { password: string; username: string }) {
		const identity = await this.authenticateDirectory(
			input.username,
			input.password,
		);
		const identitySubjectHash = this.protector.subjectHash(
			this.options.identityEnvironment,
			identity,
		);
		const sessionToken = `conn_session_${opaqueToken()}`;
		const expiresAt = new Date(Date.now() + defaultBrowserSessionTtlMs);
		const account = await this.options.repository.createBrowserSession({
			displayName: identity.displayName,
			email: identity.email,
			expiresAt,
			identityIssuer: identity.issuer,
			identityReference: this.protector.protect(identity),
			identitySubjectHash,
			legacyIdentitySubjectHash: this.protector.legacySubjectHash(identity),
			principalId: randomUUID(),
			sessionHash: tokenHash(sessionToken),
			sessionId: `browser-session-${randomUUID()}`,
		});
		return { account: this.browserAccount(account), expiresAt, sessionToken };
	}

	async getBrowserAccount(sessionToken: string | undefined) {
		return this.browserAccount(await this.requireBrowserSession(sessionToken));
	}

	async listPersonalAccessTokens(sessionToken: string | undefined) {
		const sessionHash = this.browserSessionHash(sessionToken);
		await this.requireBrowserSession(sessionToken);
		return this.options.repository.listPersonalAccessTokens(sessionHash);
	}

	async issuePersonalAccessToken(input: {
		name: string;
		sessionToken: string | undefined;
	}) {
		const name = input.name.trim();
		if (name.length < 1 || name.length > 100) {
			throw new OAuthProtocolError(
				"invalid_request",
				"Token name must contain between 1 and 100 characters",
			);
		}
		const browserSessionHash = this.browserSessionHash(input.sessionToken);
		await this.requireBrowserSession(input.sessionToken);
		const token = `conn_pat_${opaqueToken()}`;
		const tokenId = `pat-${randomUUID()}`;
		const { expiresAt } =
			await this.options.repository.issuePersonalAccessToken({
				browserSessionHash,
				consumerId: portablePatConsumer.id,
				consumerName: portablePatConsumer.name,
				instanceId: `instance-${randomUUID()}`,
				name,
				tokenHash: tokenHash(token),
				tokenId,
				ttlMs: defaultPersonalAccessTokenTtlMs,
			});
		return { expiresAt, name, token, tokenId };
	}

	async revokePersonalAccessToken(input: {
		sessionToken: string | undefined;
		tokenId: string;
	}) {
		if (!/^pat-[0-9a-f-]{36}$/.test(input.tokenId)) {
			throw new OAuthProtocolError("invalid_request", "Invalid token");
		}
		const browserSessionHash = this.browserSessionHash(input.sessionToken);
		await this.requireBrowserSession(input.sessionToken);
		await this.options.repository.revokePersonalAccessToken({
			browserSessionHash,
			tokenId: input.tokenId,
		});
	}

	async logoutBrowserSession(sessionToken: string | undefined) {
		if (!sessionToken) return;
		try {
			await this.options.repository.revokeBrowserSession(
				this.browserSessionHash(sessionToken),
			);
		} catch (error) {
			if (!(error instanceof OAuthProtocolError)) throw error;
		}
	}

	async exchangeAuthorizationCode(input: {
		clientId: string;
		code: string;
		codeVerifier: string;
		redirectUri: string;
		resource: string;
	}) {
		if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
			throw new OAuthProtocolError(
				"invalid_grant",
				"Invalid authorization code",
			);
		}
		return this.issueTokenPair((accessTokenHash, refreshTokenHash) =>
			this.options.repository.consumeAuthorizationCode({
				accessTokenExpiresAt: new Date(Date.now() + this.accessTokenTtlMs),
				accessTokenHash,
				clientId: input.clientId,
				codeHash: tokenHash(input.code),
				codeVerifier: input.codeVerifier,
				familyId: `family-${randomUUID()}`,
				redirectUri: assertRedirectUri(input.redirectUri),
				refreshTokenExpiresAt: new Date(Date.now() + this.refreshTokenTtlMs),
				refreshTokenHash,
				resource: input.resource,
			}),
		);
	}

	async refresh(input: {
		clientId: string;
		refreshToken: string;
		resource: string;
	}) {
		if (input.resource !== this.options.resource) {
			throw new OAuthProtocolError("invalid_grant", "Invalid refresh token");
		}
		const oldHash = tokenHash(input.refreshToken);
		const current = await this.options.repository.readRefreshToken({
			clientId: input.clientId,
			refreshTokenHash: oldHash,
			resource: input.resource,
		});
		await this.revalidate(current);
		return this.issueTokenPair((accessTokenHash, refreshTokenHash) =>
			this.options.repository.rotateRefreshToken({
				accessTokenExpiresAt: new Date(Date.now() + this.accessTokenTtlMs),
				accessTokenHash,
				clientId: input.clientId,
				oldRefreshTokenHash: oldHash,
				refreshTokenExpiresAt: new Date(Date.now() + this.refreshTokenTtlMs),
				refreshTokenHash,
				resource: input.resource,
			}),
		);
	}

	private async issueTokenPair(
		persist: (
			accessTokenHash: string,
			refreshTokenHash: string,
		) => Promise<OAuthTokenIdentity>,
	) {
		const accessToken = opaqueToken();
		const refreshToken = opaqueToken();
		await persist(tokenHash(accessToken), tokenHash(refreshToken));
		return {
			access_token: accessToken,
			expires_in: Math.floor(this.accessTokenTtlMs / 1000),
			refresh_token: refreshToken,
			scope: [...this.scopes].join(" "),
			token_type: "Bearer" as const,
		};
	}

	private async verifyBearerIdentity(authorization: string | undefined) {
		const token = parseBearer(authorization);
		const identity = await this.options.repository.resolveAccessToken(
			tokenHash(token),
		);
		if (
			identity.resource !== null &&
			identity.resource !== this.options.resource
		) {
			throw new OAuthProtocolError(
				"invalid_token",
				"Invalid or expired token",
				401,
			);
		}
		if (
			Date.now() - identity.lastVerifiedAt.getTime() >
			this.principalFreshnessMs
		) {
			await this.revalidate(identity);
		}
		return identity;
	}

	private browserSessionHash(sessionToken: string | undefined) {
		if (!/^conn_session_[A-Za-z0-9_-]{43}$/.test(sessionToken ?? "")) {
			throw new OAuthProtocolError(
				"invalid_token",
				"Browser session is required",
				401,
			);
		}
		return tokenHash(sessionToken ?? "");
	}

	private async requireBrowserSession(sessionToken: string | undefined) {
		const identity = await this.options.repository.resolveBrowserSession(
			this.browserSessionHash(sessionToken),
		);
		if (
			Date.now() - identity.lastVerifiedAt.getTime() >
			this.principalFreshnessMs
		) {
			await this.revalidate(identity);
		}
		return identity;
	}

	private browserAccount(identity: BrowserSessionIdentity) {
		return {
			displayName: identity.displayName,
			email: identity.email,
			principalId: identity.principalId,
		};
	}

	async verifyAccessToken(authorization: string | undefined) {
		const identity = await this.verifyBearerIdentity(authorization);
		return {
			consumerId: identity.consumerId,
			instanceId: identity.instanceId,
			principalId: identity.principalId,
		};
	}

	async revokeToken(token: string) {
		if (token) await this.options.repository.revokeToken(tokenHash(token));
	}

	async revokeInstance(authorization: string | undefined, instanceId: string) {
		const principal = await this.verifyBearerIdentity(authorization);
		if (principal.resource === null) {
			throw new OAuthProtocolError(
				"invalid_token",
				"Invalid or expired token",
				401,
			);
		}
		await this.options.repository.revokeInstance({
			consumerId: principal.consumerId,
			instanceId,
			principalId: principal.principalId,
		});
	}

	private async authenticateDirectory(usernameValue: string, password: string) {
		const username = usernameValue.trim();
		if (
			username.length < 1 ||
			username.length > 256 ||
			password.length < 1 ||
			password.length > 1024
		) {
			throw new OAuthProtocolError(
				"access_denied",
				"Authentication failed",
				401,
			);
		}
		let identity: DirectoryIdentity;
		try {
			identity = await this.options.directory.authenticate(username, password);
		} catch {
			throw new OAuthProtocolError(
				"access_denied",
				"Authentication failed",
				401,
			);
		}
		if (
			!identity.issuer ||
			!identity.subject ||
			!identity.displayName ||
			(identity.email !== null && !identity.email)
		) {
			throw new OAuthProtocolError(
				"access_denied",
				"Authentication failed",
				401,
			);
		}
		return identity;
	}

	private async revalidate(identity: {
		identityReference: string;
		principalId: string;
	}) {
		const directoryIdentity = this.protector.unprotect(
			identity.identityReference,
		);
		let active = false;
		try {
			active = await this.options.directory.isActive(directoryIdentity);
		} catch {
			throw new OAuthProtocolError(
				"invalid_token",
				"Identity verification is unavailable",
				401,
			);
		}
		if (!active) {
			await this.options.repository.disablePrincipal(identity.principalId);
			throw new OAuthProtocolError(
				"invalid_token",
				"Account is not active",
				401,
			);
		}
		await this.options.repository.touchPrincipalVerification(
			identity.principalId,
			new Date(),
		);
	}
}

export function verifyPkce(codeVerifier: string, expectedChallenge: string) {
	return constantTimeEqual(pkceChallenge(codeVerifier), expectedChallenge);
}
