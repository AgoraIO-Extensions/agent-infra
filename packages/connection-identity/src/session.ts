import { createHash, randomBytes } from "node:crypto";

export interface BrowserSessionPrincipal {
	id: string;
	issuer: string;
	uid: string;
	status: "active" | "disabled" | "revoked";
	recoveryGeneration: number;
}

export interface BrowserSessionRecord {
	id: string;
	tokenHash: string;
	principalId: string;
	issuer: string;
	uid: string;
	recoveryGeneration: number;
	expiresAt: number;
	revokedAt: number | null;
}

export interface BrowserSessionStore {
	insert(record: BrowserSessionRecord): Promise<void>;
	findByTokenHash(tokenHash: string): Promise<BrowserSessionRecord | undefined>;
	revoke(id: string, at: number): Promise<void>;
}

export interface BrowserSessionPrincipalStore {
	findById(id: string): Promise<BrowserSessionPrincipal | undefined>;
	disable?(id: string): Promise<void>;
}

export interface BrowserSessionDirectory {
	check(issuer: string, uid: string): Promise<{ exists: boolean }>;
	disablePrincipal?(principalId: string): Promise<void>;
}

export const browserSessionCookieName = "__Host-connection_session";

export function hashOpaqueSecret(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function browserSessionCookie(
	token: string,
	maxAgeSeconds: number,
): string {
	if (!/^[A-Za-z0-9_-]{40,}$/.test(token))
		throw new Error("invalid browser session token");
	if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0)
		throw new Error("invalid browser session lifetime");
	return `${browserSessionCookieName}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function readBrowserSessionCookie(
	header: string | null | undefined,
): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === browserSessionCookieName) {
			const token = value.join("=");
			return /^[A-Za-z0-9_-]{40,}$/.test(token) ? token : undefined;
		}
	}
	return undefined;
}

export class BrowserSessionService {
	constructor(
		private readonly sessions: BrowserSessionStore,
		private readonly principals: BrowserSessionPrincipalStore,
		private readonly directory: BrowserSessionDirectory,
		private readonly now: () => number = Date.now,
		private readonly lifetimeMs = 8 * 60 * 60 * 1000,
	) {
		if (!Number.isInteger(lifetimeMs) || lifetimeMs <= 0)
			throw new Error("invalid browser session lifetime");
	}

	async create(principal: BrowserSessionPrincipal): Promise<{
		token: string;
		cookie: string;
		record: BrowserSessionRecord;
	}> {
		if (principal.status !== "active")
			throw new Error("principal is not active");
		const token = randomBytes(32).toString("base64url");
		const expiresAt = this.now() + this.lifetimeMs;
		const record: BrowserSessionRecord = {
			id: randomBytes(16).toString("hex"),
			tokenHash: hashOpaqueSecret(token),
			principalId: principal.id,
			issuer: principal.issuer,
			uid: principal.uid,
			recoveryGeneration: principal.recoveryGeneration,
			expiresAt,
			revokedAt: null,
		};
		await this.sessions.insert(record);
		return {
			token,
			cookie: browserSessionCookie(token, Math.floor(this.lifetimeMs / 1000)),
			record,
		};
	}

	async resolve(
		token: string | undefined,
	): Promise<BrowserSessionPrincipal | undefined> {
		if (!token || !/^[A-Za-z0-9_-]{40,}$/.test(token)) return undefined;
		const record = await this.sessions.findByTokenHash(hashOpaqueSecret(token));
		if (!record || record.revokedAt !== null || record.expiresAt <= this.now())
			return undefined;
		const principal = await this.principals.findById(record.principalId);
		if (
			principal?.status !== "active" ||
			principal.issuer !== record.issuer ||
			principal.uid !== record.uid ||
			principal.recoveryGeneration !== record.recoveryGeneration
		)
			return undefined;
		const entry = await this.directory.check(record.issuer, record.uid);
		if (!entry.exists) {
			await this.directory.disablePrincipal?.(record.principalId);
			await this.sessions.revoke(record.id, this.now());
			return undefined;
		}
		return principal;
	}

	async revoke(token: string | undefined): Promise<void> {
		if (!token || !/^[A-Za-z0-9_-]{40,}$/.test(token)) return;
		const record = await this.sessions.findByTokenHash(hashOpaqueSecret(token));
		if (record) await this.sessions.revoke(record.id, this.now());
	}
}
