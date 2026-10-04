import { createHash, randomBytes } from "node:crypto";
import { PlatformLoginRequestV1Schema } from "@agent-infra/contracts/platform-auth";
import type {
	createLdapIdentityDirectory,
	LdapAccount,
} from "@agent-infra/identity";
import { resolveLdapPrincipal } from "@agent-infra/identity";

type Directory = ReturnType<typeof createLdapIdentityDirectory>;
const SESSION_COOKIE = "__Host-platform-session";
const SESSION_MS = 15 * 60_000;
const MAX_LOGIN_BYTES = 32_768;
const LOGIN_BODY_TIMEOUT_MS = 5000;

function response(status: number): Response {
	return new Response(null, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
}

function cookie(request: Request): string | null {
	const header = request.headers.get("cookie") ?? "";
	if (header.length > 8192) return null;
	const matches = header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
	if (matches.length !== 1) return null;
	const value = matches[0]?.slice(SESSION_COOKIE.length + 1);
	return value && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}

function sessionCookie(value: string, seconds: number): string {
	return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}

async function loginBody(
	request: Request,
): Promise<{ login: string; password: string } | null> {
	if (
		!/^application\/json(?:;|$)/iu.test(
			request.headers.get("content-type") ?? "",
		) ||
		!request.body
	)
		return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error("LOGIN_BODY_TIMEOUT")),
			LOGIN_BODY_TIMEOUT_MS,
		);
	});
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), deadline]);
			if (done) break;
			length += value.byteLength;
			if (length > MAX_LOGIN_BYTES) return null;
			chunks.push(value);
		}
		const parsed = PlatformLoginRequestV1Schema.safeParse(
			JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
			),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	} finally {
		if (timeout) clearTimeout(timeout);
		void reader.cancel().catch(() => undefined);
		try {
			reader.releaseLock();
		} catch {
			/* A timed-out read may still be pending. */
		}
	}
}

export interface LdapBrowserInput {
	readonly publicOrigin: string;
	readonly directory: Directory;
	readonly sessions: LdapSessionStore;
	/** Platform DB authority supplied by #481; unavailable results must throw. */
	readonly isPlatformDisabled: (userId: string) => Promise<boolean>;
	/** Complete, current directory mapping supplied by the #889/#504 integration. */
	readonly organizationIds: (
		account: LdapAccount,
	) => Promise<readonly string[]>;
	readonly now?: () => number;
}

export interface LdapSessionStore {
	create(digest: string, uid: string, expiresAt: number): Promise<void>;
	find(digest: string, now: number): Promise<{ uid: string } | null>;
	revoke(digest: string): Promise<void>;
	revokeUid(uid: string): Promise<void>;
}

export function createLdapBrowserAdapter(input: LdapBrowserInput) {
	let origin: URL;
	try {
		origin = new URL(input.publicOrigin);
		if (
			origin.protocol !== "https:" ||
			origin.origin !== input.publicOrigin ||
			origin.username ||
			origin.password ||
			!input.directory ||
			typeof input.directory.userIdForUid !== "function" ||
			!input.sessions ||
			["create", "find", "revoke", "revokeUid"].some(
				(method) =>
					typeof input.sessions[method as keyof LdapSessionStore] !==
					"function",
			) ||
			typeof input.isPlatformDisabled !== "function" ||
			typeof input.organizationIds !== "function"
		)
			throw new Error();
	} catch {
		throw new Error("LDAP_BROWSER_CONFIGURATION_INVALID");
	}
	const now = input.now ?? Date.now;
	const digest = (token: string) =>
		createHash("sha256").update(token).digest("hex");

	const current = (account: LdapAccount) =>
		resolveLdapPrincipal(account, input);

	const identityAdapter = {
		async resolve(request: Request) {
			const token = cookie(request);
			const session = token
				? await input.sessions.find(digest(token), now())
				: null;
			if (!session) return null;
			if (
				!/^(GET|HEAD|OPTIONS)$/u.test(request.method) &&
				request.headers.get("origin") !== origin.origin
			)
				return null;
			const userId = await input.directory.userIdForUid(session.uid);
			const platformDisabled = await input.isPlatformDisabled(userId);
			if (typeof platformDisabled !== "boolean")
				throw new Error("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
			if (platformDisabled) {
				await input.sessions.revokeUid(session.uid);
				return null;
			}
			const account = await input.directory.current(session.uid);
			if (account?.accountStatus !== "active") {
				await input.sessions.revokeUid(session.uid);
				return null;
			}
			const identity = await current(account);
			if (identity.accountStatus === "disabled" || identity.userId !== userId) {
				await input.sessions.revokeUid(session.uid);
				return null;
			}
			return identity;
		},
		async hydrateUsers(ids: readonly string[]) {
			return Promise.all(
				ids.map(async (id) => {
					const account = await input.directory.currentByUserId(id);
					if (!account || account.userId !== id)
						throw new Error("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
					const identity = await current(account);
					if (identity.accountStatus !== "active")
						throw new Error("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
					return {
						userId: identity.userId,
						displayName: identity.displayName,
						roles: identity.roles,
					};
				}),
			);
		},
		async resolveMaterialGrantActor(id: string) {
			const account = await input.directory.currentByUserId(id);
			if (!account) return null;
			if (account.userId !== id)
				throw new Error("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
			const identity = await current(account);
			return {
				userId: identity.userId,
				accountStatus: identity.accountStatus,
				isSystemAdmin: identity.roles.includes("system_admin"),
				ldapStableUid: account.uid,
				// First-party directory roles come from the configured stable UID allow-list.
				ldapAdministratorConfigured: account.roles.includes("system_admin"),
				authorizationRevision: identity.authorizationRevision,
			};
		},
		async resolveUser(id: string) {
			const account = await input.directory.currentByUserId(id);
			if (!account) return null;
			const identity = await current(account);
			return {
				schemaVersion: 1 as const,
				userId: identity.userId,
				accountStatus: identity.accountStatus,
				organizationIds: identity.organizationIds,
				authorizationRevision: identity.authorizationRevision,
			};
		},
	};

	async function handleRequest(request: Request): Promise<Response | null> {
		const url = new URL(request.url);
		if (url.pathname !== "/auth/login" && url.pathname !== "/auth/logout")
			return null;
		if (url.origin !== origin.origin || request.url.length > 8192 || url.search)
			return response(400);
		if (url.pathname === "/auth/login") {
			if (request.method !== "POST") return response(405);
			if (request.headers.get("origin") !== origin.origin) return response(403);
			const body = await loginBody(request);
			if (!body) return response(400);
			let account: LdapAccount | null;
			try {
				account = await input.directory.authenticate(body.login, body.password);
				if (!account || (await current(account)).accountStatus !== "active")
					return response(401);
			} catch {
				return response(503);
			}
			const token = randomBytes(32).toString("base64url");
			try {
				await input.sessions.create(
					digest(token),
					account.uid,
					now() + SESSION_MS,
				);
			} catch {
				return response(503);
			}
			const result = response(204);
			result.headers.append(
				"Set-Cookie",
				sessionCookie(token, SESSION_MS / 1000),
			);
			return result;
		}
		if (request.method !== "POST") return response(405);
		if (
			request.headers.get("origin") !== origin.origin ||
			request.headers.get("x-platform-csrf") !== "1"
		)
			return response(403);
		const token = cookie(request);
		try {
			if (token) await input.sessions.revoke(digest(token));
		} catch {
			return response(503);
		}
		const result = response(204);
		result.headers.append("Set-Cookie", sessionCookie("", 0));
		return result;
	}

	return { identityAdapter, handleRequest };
}
