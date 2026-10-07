import type {
	createLdapIdentityDirectory,
	LdapAccount,
} from "@agent-infra/identity";
import { describe, expect, it, vi } from "vitest";
import {
	createLdapBrowserAdapter,
	type LdapSessionStore,
} from "./ldap-browser.js";

const origin = "https://platform.example.test";
const account: LdapAccount = {
	uid: "stable-a",
	userId: "e8c99945-5b39-4bcb-8f99-c29a7788432f",
	email: "person.a@example.test",
	displayName: "Person A",
	accountStatus: "active",
	roles: ["employee", "system_admin"],
	authorizationRevision: "ldap-revision-1",
};

function memorySessions(): LdapSessionStore {
	const sessions = new Map<
		string,
		{
			uid: string;
			expiresAt: number;
			absoluteExpiresAt: number;
			principal?: Record<string, unknown>;
		}
	>();
	return {
		async create(digest, uid, expiresAt, absoluteExpiresAt, principal) {
			sessions.set(digest, {
				uid,
				expiresAt,
				absoluteExpiresAt,
				principal,
			});
		},
		async find(digest, now) {
			const session = sessions.get(digest);
			return session &&
				session.expiresAt > now &&
				session.absoluteExpiresAt > now
				? {
						uid: session.uid,
						expiresAt: session.expiresAt,
						absoluteExpiresAt: session.absoluteExpiresAt,
						principal: session.principal,
					}
				: null;
		},
		async renew(digest, now, expiresAt) {
			const session = sessions.get(digest);
			if (
				!session ||
				session.expiresAt <= now ||
				session.absoluteExpiresAt <= now
			)
				return false;
			session.expiresAt = Math.min(expiresAt, session.absoluteExpiresAt);
			return true;
		},
		async revoke(digest) {
			sessions.delete(digest);
		},
		async revokeUid(uid) {
			for (const [digest, session] of sessions)
				if (session.uid === uid) sessions.delete(digest);
		},
	};
}

function fixture(sessions = memorySessions()) {
	let current: LdapAccount | null = account;
	let disabled = false;
	let organizationIds: readonly string[] = ["org-a"];
	let organizationsAvailable = true;
	let now = 1000;
	const directory = {
		userIdForUid: vi.fn(async (uid: string) =>
			uid === account.uid ? account.userId : "invalid-user",
		),
		authenticate: vi.fn(async (login: string, password: string) =>
			login === "login-a" && password === "correct-password" ? current : null,
		),
		current: vi.fn(async () => current),
		currentByUserId: vi.fn(async () => current),
	} as unknown as ReturnType<typeof createLdapIdentityDirectory>;
	const isPlatformDisabled = vi.fn(async () => disabled);
	const adapter = createLdapBrowserAdapter({
		publicOrigin: origin,
		directory,
		sessions,
		isPlatformDisabled,
		organizationIds: async () => {
			if (!organizationsAvailable) throw new Error("directory unavailable");
			return organizationIds;
		},
		now: () => now,
	});
	const login = (
		body = JSON.stringify({ login: "login-a", password: "correct-password" }),
		headers: Record<string, string> = {},
	) =>
		adapter.handleRequest(
			new Request(`${origin}/auth/login`, {
				method: "POST",
				headers: {
					origin,
					"content-type": "application/json",
					...headers,
				},
				body,
			}),
		);
	return {
		adapter,
		sessions,
		directory,
		login,
		isPlatformDisabled,
		setCurrent(value: LdapAccount | null) {
			current = value;
		},
		setDisabled(value: boolean) {
			disabled = value;
		},
		setOrganizations(value: readonly string[]) {
			organizationIds = value;
		},
		setOrganizationsAvailable(value: boolean) {
			organizationsAvailable = value;
		},
		setNow(value: number) {
			now = value;
		},
	};
}

describe("LDAP browser adapter", () => {
	it("hydrates roles only for a current active LDAP and Platform user", async () => {
		const state = fixture();
		await expect(
			state.adapter.identityAdapter.hydrateUsers([account.userId]),
		).resolves.toEqual([
			{
				userId: account.userId,
				displayName: account.displayName,
				roles: account.roles,
			},
		]);
		state.setCurrent({ ...account, accountStatus: "disabled" });
		await expect(
			state.adapter.identityAdapter.hydrateUsers([account.userId]),
		).rejects.toThrow("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
		state.setCurrent(account);
		state.setDisabled(true);
		await expect(
			state.adapter.identityAdapter.hydrateUsers([account.userId]),
		).rejects.toThrow("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
		state.setDisabled(false);
		state.setOrganizationsAvailable(false);
		await expect(
			state.adapter.identityAdapter.hydrateUsers([account.userId]),
		).rejects.toThrow();
		state.setOrganizationsAvailable(true);
		await expect(
			state.adapter.identityAdapter.hydrateUsers(["other-user"]),
		).rejects.toThrow("LDAP_BROWSER_AUTHORITY_UNAVAILABLE");
	});

	it("issues a secure hash-only session and resolves its stored principal", async () => {
		const state = fixture();
		const result = await state.login();
		expect(result?.status).toBe(204);
		const setCookie = result?.headers.get("set-cookie") ?? "";
		expect(setCookie).toMatch(
			/^__Host-platform-session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/u,
		);
		expect(setCookie).not.toContain("correct-password");
		const cookie = setCookie.split(";")[0];
		const request = new Request(`${origin}/api/v1/session`, {
			headers: { cookie },
		});
		expect(await state.adapter.identityAdapter.resolve(request)).toMatchObject({
			schemaVersion: 1,
			userId: account.userId,
			accountStatus: "active",
			organizationIds: ["org-a"],
			roles: ["employee", "system_admin"],
		});
		expect(state.directory.current).toHaveBeenCalledOnce();
		expect(state.isPlatformDisabled).toHaveBeenCalledWith(account.userId);
		state.setDisabled(true);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
		state.setNow(1000 + 15 * 60_000);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
	});

	it("slides an active session after validation but enforces idle and absolute expiry", async () => {
		const state = fixture();
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const request = new Request(`${origin}/api/v1/session`, {
			headers: { cookie },
		});

		for (const minutes of [90, 180, 270, 360, 450, 540, 630]) {
			state.setNow(1000 + minutes * 60_000);
			expect(
				await state.adapter.identityAdapter.resolve(request),
			).not.toBeNull();
		}

		state.setNow(1000 + 12 * 60 * 60_000);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
	});

	it("expires an inactive session at the idle deadline", async () => {
		const state = fixture();
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		state.setNow(1000 + 2 * 60 * 60_000 + 1);
		expect(
			await state.adapter.identityAdapter.resolve(
				new Request(`${origin}/api/v1/session`, { headers: { cookie } }),
			),
		).toBeNull();
	});

	it("renews after activity before the original idle deadline", async () => {
		const state = fixture();
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const request = new Request(`${origin}/api/v1/session`, {
			headers: { cookie },
		});
		state.setNow(1000 + 59 * 60_000);
		expect(await state.adapter.identityAdapter.resolve(request)).not.toBeNull();
		state.setNow(1000 + 121 * 60_000);
		expect(await state.adapter.identityAdapter.resolve(request)).not.toBeNull();
	});

	it("does not write a renewal after reaching the absolute deadline", async () => {
		const sessions = memorySessions();
		const renew = vi.spyOn(sessions, "renew");
		const state = fixture(sessions);
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const request = new Request(`${origin}/api/v1/session`, {
			headers: { cookie },
		});
		for (const minutes of [90, 180, 270, 360, 450, 540, 630]) {
			state.setNow(1000 + minutes * 60_000);
			expect(
				await state.adapter.identityAdapter.resolve(request),
			).not.toBeNull();
		}
		state.setNow(1000 + 11 * 60 * 60_000);
		expect(await state.adapter.identityAdapter.resolve(request)).not.toBeNull();
		renew.mockClear();
		state.setNow(1000 + 11 * 60 * 60_000 + 60_000);
		expect(await state.adapter.identityAdapter.resolve(request)).not.toBeNull();
		expect(renew).not.toHaveBeenCalled();
	});

	it("does not renew a session after current identity validation fails", async () => {
		const sessions = memorySessions();
		const renew = vi.spyOn(sessions, "renew");
		const state = fixture(sessions);
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		state.setNow(1000 + 90 * 60_000);
		state.setDisabled(true);
		expect(
			await state.adapter.identityAdapter.resolve(
				new Request(`${origin}/api/v1/session`, { headers: { cookie } }),
			),
		).toBeNull();
		expect(renew).not.toHaveBeenCalled();
	});

	it("does not renew a session after LDAP status or identity mapping changes", async () => {
		for (const change of ["disabled", "reassigned"] as const) {
			const sessions = memorySessions();
			const renew = vi.spyOn(sessions, "renew");
			const state = fixture(sessions);
			const cookie =
				(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
			state.setNow(1000 + 90 * 60_000);
			state.setCurrent(
				change === "disabled"
					? { ...account, accountStatus: "disabled" }
					: { ...account, userId: "reassigned-user" },
			);
			expect(
				await state.adapter.identityAdapter.resolve(
					new Request(`${origin}/api/v1/session`, { headers: { cookie } }),
				),
			).toBeNull();
			expect(renew).not.toHaveBeenCalled();
		}
	});

	it("refuses login before creating a session when identity authority is disabled or unavailable", async () => {
		const create = vi.fn(async () => {});
		const state = fixture({ ...memorySessions(), create });
		state.setDisabled(true);
		expect((await state.login())?.status).toBe(401);
		state.setDisabled(false);
		state.setCurrent({ ...account, accountStatus: "disabled" });
		expect((await state.login())?.status).toBe(401);
		state.setCurrent(account);
		state.isPlatformDisabled.mockRejectedValueOnce(
			new Error("private authority detail"),
		);
		const unavailable = await state.login();
		expect(unavailable?.status).toBe(503);
		expect(await unavailable?.text()).not.toContain("private authority detail");
		expect(create).not.toHaveBeenCalled();
	});

	it("rejects cross-origin cookie writes and does not revive a revoked session", async () => {
		const state = fixture();
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const write = (originHeader: string) =>
			new Request(`${origin}/api/v1/agents`, {
				method: "POST",
				headers: { cookie, origin: originHeader },
			});
		expect(
			await state.adapter.identityAdapter.resolve(
				write("https://other.example.test"),
			),
		).toBeNull();
		expect(
			await state.adapter.identityAdapter.resolve(write(origin)),
		).toMatchObject({ accountStatus: "active" });
		state.setDisabled(true);
		expect(
			await state.adapter.identityAdapter.resolve(write(origin)),
		).toBeNull();
		state.setDisabled(false);
		expect(
			await state.adapter.identityAdapter.resolve(write(origin)),
		).toBeNull();
	});

	it("revokes a disabled user's session even when the directory is unavailable", async () => {
		const state = fixture();
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const request = new Request(`${origin}/api/v1/session`, {
			headers: { cookie },
		});
		state.setDisabled(true);
		state.setOrganizationsAvailable(false);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
		state.setDisabled(false);
		state.setOrganizationsAvailable(true);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
	});

	it("revokes a session when LDAP disables the account after login", async () => {
		const state = fixture();
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const request = new Request(`${origin}/api/v1/session`, {
			headers: { cookie },
		});
		state.setCurrent({ ...account, accountStatus: "disabled" });
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
		state.setCurrent(account);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
	});

	it("revokes a Platform-disabled session before an unavailable LDAP lookup", async () => {
		const state = fixture();
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const request = new Request(`${origin}/api/v1/session`, {
			headers: { cookie },
		});
		state.setDisabled(true);
		vi.mocked(state.directory.current).mockRejectedValueOnce(
			new Error("private LDAP outage"),
		);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
		expect(state.directory.current).not.toHaveBeenCalled();
		state.setDisabled(false);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
	});

	it("does not return a principal when Platform disable arrives", async () => {
		const state = fixture();
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const request = new Request(`${origin}/api/v1/session`, {
			headers: { cookie },
		});
		state.isPlatformDisabled.mockResolvedValueOnce(true);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
		expect(state.isPlatformDisabled).toHaveBeenCalledTimes(2);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
		expect(state.isPlatformDisabled).toHaveBeenCalledTimes(2);
	});

	it("revokes the session when LDAP mapping changes later", async () => {
		const state = fixture();
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const request = new Request(`${origin}/api/v1/session`, {
			headers: { cookie },
		});
		const reassignedUserId = "5f5a7c76-1097-462e-80d0-c60b42df978b";
		state.setCurrent({ ...account, userId: reassignedUserId });
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
		expect(state.isPlatformDisabled).toHaveBeenNthCalledWith(2, account.userId);
		expect(state.isPlatformDisabled).toHaveBeenNthCalledWith(
			3,
			reassignedUserId,
		);
		expect(state.isPlatformDisabled).toHaveBeenCalledTimes(3);
	});

	it("shares revocation across instances and fails closed when session storage fails", async () => {
		const sessions = memorySessions();
		const first = fixture(sessions);
		const second = fixture(sessions);
		const cookie =
			(await first.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const request = new Request(`${origin}/api/v1/session`, {
			headers: { cookie },
		});
		expect(
			await second.adapter.identityAdapter.resolve(request),
		).not.toBeNull();
		await second.adapter.handleRequest(
			new Request(`${origin}/auth/logout`, {
				method: "POST",
				headers: { origin, cookie, "x-platform-csrf": "1" },
			}),
		);
		expect(await first.adapter.identityAdapter.resolve(request)).toBeNull();
		const unavailable = fixture({
			...sessions,
			async create() {
				throw new Error("private database detail");
			},
		});
		const denied = await unavailable.login();
		expect(denied?.status).toBe(503);
		expect(await denied?.text()).not.toContain("private database detail");
	});

	it("bounds a stalled login body and cancels an oversized body", async () => {
		const state = fixture();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		vi.useFakeTimers();
		try {
			const pending = state.adapter.handleRequest(
				new Request(`${origin}/auth/login`, {
					method: "POST",
					headers: {
						origin,
						"content-type": "application/json",
					},
					body,
					duplex: "half",
				}),
			);
			await vi.advanceTimersByTimeAsync(5000);
			expect((await pending)?.status).toBe(400);
			expect(cancelled).toBe(true);
		} finally {
			vi.useRealTimers();
		}
		expect(
			(
				await state.login(
					JSON.stringify({ login: "login-a", password: "x".repeat(4096) }),
				)
			)?.status,
		).toBe(401);
		expect(state.directory.authenticate).toHaveBeenCalledOnce();
		vi.mocked(state.directory.authenticate).mockClear();
		expect((await state.login("x".repeat(32_769)))?.status).toBe(400);
		expect(state.directory.authenticate).not.toHaveBeenCalled();
	});

	it("refuses cross-origin login, invalid credentials, duplicate cookies and revoked directory input", async () => {
		const state = fixture();
		expect(
			(await state.login(undefined, { origin: "https://evil.example.test" }))
				?.status,
		).toBe(403);
		expect(state.directory.authenticate).not.toHaveBeenCalled();
		expect(
			(
				await state.login(
					JSON.stringify({ login: "login-a", password: "wrong" }),
				)
			)?.status,
		).toBe(401);
		expect(
			(
				await state.login(
					JSON.stringify({
						login: "login-a",
						password: "correct-password",
						userId: "admin",
					}),
				)
			)?.status,
		).toBe(400);
		state.setCurrent({ ...account, accountStatus: "disabled" });
		expect((await state.login())?.status).toBe(401);
		state.setCurrent(account);
		state.setDisabled(true);
		expect((await state.login())?.status).toBe(401);
		state.setDisabled(false);
		state.setOrganizations(["org-a", "org-a"]);
		expect((await state.login())?.status).toBe(503);
		state.setOrganizations(["org-a"]);
		const cookie = (await state.login())?.headers
			.get("set-cookie")
			?.split(";")[0];
		expect(
			await state.adapter.identityAdapter.resolve(
				new Request(origin, { headers: { cookie: `${cookie}; ${cookie}` } }),
			),
		).toBeNull();
	});

	it("does not expose credentials or provider errors and revokes logout", async () => {
		const state = fixture();
		vi.mocked(state.directory.authenticate).mockRejectedValueOnce(
			new Error("private LDAP password"),
		);
		const failed = await state.login();
		expect(failed?.status).toBe(503);
		expect(await failed?.text()).not.toContain("private LDAP password");
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const request = new Request(origin, { headers: { cookie } });
		expect(await state.adapter.identityAdapter.resolve(request)).not.toBeNull();
		const getLogout = await state.adapter.handleRequest(
			new Request(`${origin}/auth/logout`, { headers: { cookie } }),
		);
		expect(getLogout?.status).toBe(405);
		expect(await state.adapter.identityAdapter.resolve(request)).not.toBeNull();
		const denied = await state.adapter.handleRequest(
			new Request(`${origin}/auth/logout`, {
				method: "POST",
				headers: { origin, cookie },
			}),
		);
		expect(denied?.status).toBe(403);
		const logout = await state.adapter.handleRequest(
			new Request(`${origin}/auth/logout`, {
				method: "POST",
				headers: { origin, cookie, "x-platform-csrf": "1" },
			}),
		);
		expect(logout?.status).toBe(204);
		expect(await state.adapter.identityAdapter.resolve(request)).toBeNull();
	});

	it("returns an opaque failure when session revocation is unavailable", async () => {
		const sessions = memorySessions();
		const state = fixture({
			...sessions,
			async revoke() {
				throw new Error("private session store detail");
			},
		});
		const cookie =
			(await state.login())?.headers.get("set-cookie")?.split(";")[0] ?? "";
		const result = await state.adapter.handleRequest(
			new Request(`${origin}/auth/logout`, {
				method: "POST",
				headers: { origin, cookie, "x-platform-csrf": "1" },
			}),
		);
		expect(result?.status).toBe(503);
		expect(await result?.text()).not.toContain("private session store detail");
	});
});

describe("current material-grant administrator", () => {
	it("derives LDAP facts from the current directory and refreshes them on every call", async () => {
		const f = fixture();
		const resolve = () =>
			f.adapter.identityAdapter.resolveMaterialGrantActor(account.userId);
		expect(await resolve()).toMatchObject({
			userId: account.userId,
			accountStatus: "active",
			isSystemAdmin: true,
			ldapStableUid: account.uid,
			ldapAdministratorConfigured: true,
		});
		f.setCurrent({
			...account,
			roles: ["employee"],
			authorizationRevision: "revoked",
		});
		expect(await resolve()).toMatchObject({
			isSystemAdmin: false,
			ldapAdministratorConfigured: false,
		});
		f.setDisabled(true);
		expect(await resolve()).toMatchObject({ accountStatus: "disabled" });
		expect(f.directory.currentByUserId).toHaveBeenCalledTimes(3);
	});
	it("fails closed for missing, mismatched or unavailable directory facts", async () => {
		const f = fixture();
		const resolve = () =>
			f.adapter.identityAdapter.resolveMaterialGrantActor(account.userId);
		f.setCurrent(null);
		expect(await resolve()).toBeNull();
		f.setCurrent({ ...account, userId: "another-user" });
		await expect(resolve()).rejects.toThrow();
		f.setCurrent(account);
		f.setOrganizationsAvailable(false);
		await expect(resolve()).rejects.toThrow();
		vi.mocked(f.directory.currentByUserId).mockRejectedValueOnce(
			new Error("private directory failure"),
		);
		await expect(resolve()).rejects.toThrow();
	});
});
