import { createHash, randomBytes } from "node:crypto";
import type {
	EmployeeAccount,
	EmployeeIdentityDirectory,
} from "@agent-infra/identity";
import { resolveEmployeePrincipal } from "@agent-infra/identity";
import { recordHttpFailureContext } from "@agent-infra/observability/http";
import type { DirectorySnapshotBindingV1 } from "@agent-infra/platform-core";
import type { BrowserSessionPrincipal } from "@agent-infra/platform-store";

const SESSION_COOKIE = "__Host-platform-session";
const SESSION_IDLE_MS = 2 * 60 * 60_000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;

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

export interface BrowserSessionInput {
	readonly publicOrigin: string;
	readonly directory: EmployeeIdentityDirectory;
	readonly sessions: BrowserSessionStore;
	/** Platform DB authority supplied by #481; unavailable results must throw. */
	readonly isPlatformDisabled: (userId: string) => Promise<boolean>;
	/** Complete, current directory mapping supplied by the #889/#504 integration. */
	readonly organizationIds: (
		account: EmployeeAccount,
	) => Promise<readonly string[]>;
	readonly organizationAuthority?: (account: EmployeeAccount) => Promise<{
		readonly organizationIds: readonly string[];
		readonly binding: DirectorySnapshotBindingV1;
	}>;
	readonly now?: () => number;
}

export interface BrowserSessionStore {
	create(
		digest: string,
		uid: string,
		expiresAt: number,
		absoluteExpiresAt: number,
		principal?: BrowserSessionPrincipal,
	): Promise<void>;
	find(
		digest: string,
		now: number,
	): Promise<{
		uid: string;
		expiresAt: number;
		absoluteExpiresAt: number;
		principal?: BrowserSessionPrincipal;
	} | null>;
	renew(digest: string, now: number, expiresAt: number): Promise<boolean>;
	revoke(digest: string): Promise<void>;
	revokeUid(uid: string): Promise<void>;
}

export function createBrowserSessionAdapter(input: BrowserSessionInput) {
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
			["create", "find", "renew", "revoke", "revokeUid"].some(
				(method) =>
					typeof input.sessions[method as keyof BrowserSessionStore] !==
					"function",
			) ||
			typeof input.isPlatformDisabled !== "function" ||
			typeof input.organizationIds !== "function"
		)
			throw new Error();
	} catch {
		throw new Error("BROWSER_SESSION_CONFIGURATION_INVALID");
	}
	const now = input.now ?? Date.now;
	const digest = (token: string) =>
		createHash("sha256").update(token).digest("hex");

	const current = (account: EmployeeAccount) =>
		resolveEmployeePrincipal(account, input);

	/**
	 * 文件交换的 Actor 解析必须与浏览器会话使用同一组当前事实（#3060）：
	 * 每次调用都重新读取 目录中的当前员工与 Platform 停用状态，不复用会话或请求中的旧身份。
	 * 账户缺失或映射不一致返回 null；目录、停用记录或组织快照不可用时抛错，由调用方失败关闭。
	 */
	const resolveCurrentIdentity = async (userId: string) => {
		const account = await input.directory.currentByUserId(userId);
		if (!account || account.userId !== userId) return null;
		return current(account);
	};

	const identityAdapter = {
		async resolve(request: Request) {
			const token = cookie(request);
			const requestNow = now();
			const tokenDigest = token ? digest(token) : null;
			const session = tokenDigest
				? await input.sessions.find(tokenDigest, requestNow)
				: null;
			if (!tokenDigest || !session) return null;
			if (
				!/^(GET|HEAD|OPTIONS)$/u.test(request.method) &&
				request.headers.get("origin") !== origin.origin
			)
				return null;
			const userId = await input.directory.userIdForUid(session.uid);
			if (!userId) {
				await input.sessions.revoke(tokenDigest);
				return null;
			}
			const platformDisabled = await input.isPlatformDisabled(userId);
			if (typeof platformDisabled !== "boolean")
				throw new Error("BROWSER_SESSION_AUTHORITY_UNAVAILABLE");
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
			if (identity.accountStatus !== "active" || identity.userId !== userId) {
				await input.sessions.revokeUid(session.uid);
				return null;
			}
			const renewalNow = now();
			const renewedExpiresAt = Math.min(
				renewalNow + SESSION_IDLE_MS,
				session.absoluteExpiresAt,
			);
			if (renewedExpiresAt > session.expiresAt) {
				const renewed = await input.sessions.renew(
					tokenDigest,
					renewalNow,
					renewedExpiresAt,
				);
				if (!renewed) return null;
			} else {
				// Directory checks can outlive revocation or expiry even without renewal.
				const confirmed = await input.sessions.find(tokenDigest, now());
				if (
					!confirmed ||
					confirmed.uid !== session.uid ||
					confirmed.absoluteExpiresAt !== session.absoluteExpiresAt
				)
					return null;
			}
			return identity;
		},
		async hydrateUsers(ids: readonly string[]) {
			return Promise.all(
				ids.map(async (id) => {
					const account = await input.directory.currentByUserId(id);
					if (!account || account.userId !== id)
						throw new Error("BROWSER_SESSION_AUTHORITY_UNAVAILABLE");
					const identity = await current(account);
					if (identity.accountStatus !== "active")
						throw new Error("BROWSER_SESSION_AUTHORITY_UNAVAILABLE");
					return {
						userId: identity.userId,
						displayName: identity.displayName,
						roles: identity.roles,
					};
				}),
			);
		},
		/**
		 * Agent 详情的 Owner 当前状态（#2910，工程 Spec §9.1）。与会话校验使用同一组当前事实：
		 * 目录确认员工已离开为 departed；目录停用或 Platform 禁用为 disabled；目录员工、禁用记录与
		 * 目录快照都确认有效才是 active；其余（依赖失败、快照不可用、映射不一致）为 unavailable。
		 * 每个 Owner 单独判定，一个 Owner 读不到不影响其他 Owner，也不让整个详情失败。
		 */
		async describeOwners(ids: readonly string[]) {
			return Promise.all(
				ids.map(async (id) => {
					const unavailable = {
						userId: id,
						displayName: null,
						status: "unavailable" as const,
					};
					let account: EmployeeAccount | null;
					try {
						account = await input.directory.currentByUserId(id);
					} catch {
						return unavailable;
					}
					if (!account)
						return {
							userId: id,
							displayName: null,
							status: "departed" as const,
						};
					if (account.userId !== id) return unavailable;
					const displayName = account.displayName.trim() || null;
					// 目录已确认停用时不再依赖其他来源。
					if (account.accountStatus === "disabled")
						return { userId: id, displayName, status: "disabled" as const };
					try {
						const identity = await current(account);
						if (identity.userId !== id) return unavailable;
						return {
							userId: id,
							displayName,
							status:
								identity.accountStatus === "active"
									? ("active" as const)
									: ("disabled" as const),
						};
					} catch {
						return { ...unavailable, displayName };
					}
				}),
			);
		},
		async resolveMaterialGrantActor(id: string) {
			const account = await input.directory.currentByUserId(id);
			if (!account) return null;
			if (account.userId !== id)
				throw new Error("BROWSER_SESSION_AUTHORITY_UNAVAILABLE");
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
				...(identity.directorySnapshotBinding
					? { directorySnapshotBinding: identity.directorySnapshotBinding }
					: {}),
			};
		},
	};

	async function issueSession(account: EmployeeAccount) {
		let principal: Awaited<ReturnType<typeof current>>;
		try {
			principal = await current(account);
			if (principal.accountStatus !== "active") return response(401);
		} catch (error) {
			recordHttpFailureContext({
				failureStep: "auth.login.directory_principal",
				error,
			});
			return response(503);
		}
		const token = randomBytes(32).toString("base64url");
		const loginNow = now();
		try {
			await input.sessions.create(
				digest(token),
				account.uid,
				loginNow + SESSION_IDLE_MS,
				loginNow + SESSION_ABSOLUTE_MS,
				principal,
			);
		} catch (error) {
			recordHttpFailureContext({
				failureStep: "auth.login.session_store_create",
				error,
			});
			return response(503);
		}
		const result = response(204);
		result.headers.append(
			"Set-Cookie",
			sessionCookie(token, SESSION_ABSOLUTE_MS / 1000),
		);
		return result;
	}

	async function handleRequest(request: Request): Promise<Response | null> {
		const url = new URL(request.url);
		if (url.pathname !== "/auth/logout") return null;
		if (url.origin !== origin.origin || request.url.length > 8192 || url.search)
			return response(400);

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

	return {
		identityAdapter,
		handleRequest,
		resolveCurrentIdentity,
		issueSession,
	};
}
