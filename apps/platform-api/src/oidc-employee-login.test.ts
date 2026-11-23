import { createSnapshot } from "@agent-infra/enterprise-directory";
import { captureTaskAuthorizationBoundaryV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpProtocolError } from "./http/common.js";
import { registerSessionAuditRoutes } from "./http/session-audit-routes.js";
import {
	createLdapBrowserAdapter,
	type LdapSessionStore,
} from "./ldap-browser.js";
import { createOidcEmployeeDirectory } from "./oidc-employee-directory.js";

const origin = "https://platform.example.test";
const issuer = "https://login.example.test/company";
const ownerId = "043dbce2-c173-4ade-b95c-0174be6de605";
const newUserId = "b56b4d9b-18c9-4370-8266-2df7142583e3";

function employeeLogin(userId: string) {
	const now = Date.now();
	const email = "person@example.test";
	const subject = "subject-123";
	const snapshot = createSnapshot({
		rootDepartmentId: 1,
		startedAt: now,
		completedAt: now,
		departments: [{ id: 1, name: "Company", parentId: 0 }],
		members: [
			{ userId: "employee-1", email, active: true, departmentIds: [1] },
		],
	});
	const account = {
		userId,
		issuer,
		subject,
		email,
		employeeId: JSON.stringify([snapshot.source, "employee-1"]),
	};
	let bound = false;
	const bind = vi.fn(async (input) => {
		expect(input).toEqual({
			issuer,
			subject,
			email,
			employeeId: account.employeeId,
		});
		bound = true;
		return account;
	});
	const directory = createOidcEmployeeDirectory(
		{
			issuer,
			clientId: "platform",
			clientSecret: "test-client",
			allowEmailLink: true,
			administratorUserIds: [ownerId],
		},
		{
			bind,
			findBySubject: async (i, s) =>
				bound && i === issuer && s === subject ? account : null,
			findByUserId: async (id) => (bound && id === userId ? account : null),
		},
		{ loadCurrent: async () => snapshot },
	);
	const rows = new Map<
		string,
		NonNullable<Awaited<ReturnType<LdapSessionStore["find"]>>>
	>();
	const isPlatformDisabled = vi.fn(async () => false);
	const browser = createLdapBrowserAdapter({
		publicOrigin: origin,
		directory,
		sessions: {
			create: async (digest, uid, expiresAt, absoluteExpiresAt) => {
				rows.set(digest, { uid, expiresAt, absoluteExpiresAt });
			},
			find: async (digest) => rows.get(digest) ?? null,
			revokeUid: async (uid) => {
				for (const [digest, row] of rows)
					if (row.uid === uid) rows.delete(digest);
			},
			renew: vi.fn(),
			revoke: vi.fn(),
		},
		isPlatformDisabled,
		organizationIds: async () => ["dept:1"],
		now: () => now,
	});
	const app = new Hono();
	app.onError((error, c) =>
		error instanceof HttpProtocolError
			? c.json(error.body, error.status)
			: c.json({ error: "internal" }, 500),
	);
	registerSessionAuditRoutes(app, {
		identity: browser.identityAdapter,
		audit: { listAudit: async () => ({ items: [], nextCursor: null }) },
	});
	return {
		rows,
		claims: { issuer, subject, email, emailVerified: true },
		directory,
		browser,
		app,
		isPlatformDisabled,
		bind,
	};
}

describe("OIDC employee browser session", () => {
	it("treats a pre-cutover session as signed out", async () => {
		const { browser, app, rows, directory, claims } = employeeLogin(ownerId);
		const account = await directory.verifiedAccount(claims);
		if (!account) throw new Error("expected owner");
		const login = await browser.issueSession(account);
		const cookie = login.headers.get("set-cookie")?.split(";")[0];
		if (!cookie) throw new Error("expected session");
		for (const row of rows.values()) row.uid = "prior-ldap-uid";
		expect(
			(await app.request("/api/v1/session", { headers: { cookie } })).status,
		).toBe(401);
	});

	it("keeps an unmapped owner's status unknown during migration", async () => {
		const { browser } = employeeLogin(ownerId);
		expect(await browser.identityAdapter.describeOwners([ownerId])).toEqual([
			{ userId: ownerId, displayName: null, status: "unavailable" },
		]);
	});

	it.each([
		[ownerId, ["employee", "system_admin"], 200],
		[newUserId, ["employee"], 403],
	] as const)(
		"projects stable ID %s and enforces its administrator role",
		async (id, roles, auditStatus) => {
			const { claims, directory, browser, app, isPlatformDisabled, bind } =
				employeeLogin(id);
			const account = await directory.verifiedAccount(claims);
			expect(account).toBeTruthy();
			if (!account) throw new Error("expected mapped account");
			expect(bind).toHaveBeenCalledOnce();
			const login = await browser.issueSession(account);
			expect(login.status).toBe(204);
			const cookie = login.headers.get("set-cookie")?.split(";")[0];
			if (!cookie) throw new Error("expected session cookie");
			const session = await app.request("/api/v1/session", {
				headers: { cookie },
			});
			expect(session.status).toBe(200);
			expect(await session.json()).toMatchObject({
				user: { userId: id, roles },
			});
			expect(
				(await app.request("/api/v1/admin/audit", { headers: { cookie } }))
					.status,
			).toBe(auditStatus);
			const user = await browser.identityAdapter.resolveUser(id);
			if (!user) throw new Error("expected current employee");
			const boundary = captureTaskAuthorizationBoundaryV1({
				principal: { kind: "user", id },
				user,
				agent: {
					schemaVersion: 1,
					applicationId: "application-a",
					agentId: "agent-a",
					applicantId: ownerId,
					status: "available",
					revision: 1,
					approvalRevision: 1,
					decisionReason: null,
					serviceAvailability: "ready",
					desiredState: "running",
					workloadRevision: 1,
					fence: 1,
					ownerIds: [ownerId],
					availability: [],
					failureCode: null,
				},
				channelId: "web",
				agentAuthorizationRevision: "1",
			});
			expect(boundary?.accessSources ?? []).toEqual(
				id === ownerId ? [{ kind: "owner", userId: ownerId }] : [],
			);
			isPlatformDisabled.mockResolvedValue(true);
			expect(
				(await app.request("/api/v1/session", { headers: { cookie } })).status,
			).toBe(401);
			const denied = await browser.issueSession(account);
			expect(denied.status).toBe(401);
			expect(denied.headers.has("set-cookie")).toBe(false);
		},
	);
	it("requires trusted verified email before a first binding", async () => {
		const { claims, directory, bind } = employeeLogin(ownerId);
		expect(
			await directory.verifiedAccount({ ...claims, emailVerified: false }),
		).toBeNull();
		expect(
			await directory.verifiedAccount({
				...claims,
				issuer: "https://other.example.test",
			}),
		).toBeNull();
		expect(bind).not.toHaveBeenCalled();
	});
});
