import { describe, expect, it, vi } from "vitest";
import {
	type BrowserSessionRecord,
	BrowserSessionService,
	browserSessionCookie,
	hashOpaqueSecret,
	readBrowserSessionCookie,
} from "./session.js";

function setup() {
	const records: BrowserSessionRecord[] = [];
	const principal = {
		id: "principal-alice",
		issuer: "corp-ldap",
		uid: "alice",
		status: "active" as const,
		recoveryGeneration: 2,
	};
	const sessions = {
		insert: vi.fn(async (record: BrowserSessionRecord) => {
			records.push(record);
		}),
		findByTokenHash: vi.fn(async (hash: string) =>
			records.find((record) => record.tokenHash === hash),
		),
		revoke: vi.fn(async (id: string, at: number) => {
			const record = records.find((value) => value.id === id);
			if (record) record.revokedAt = at;
		}),
	};
	const service = new BrowserSessionService(
		sessions,
		{
			findById: vi.fn(async (id: string) =>
				id === principal.id ? principal : undefined,
			),
		},
		{ check: vi.fn(async () => ({ exists: true })) },
		() => 1_000,
	);
	return { records, principal, sessions, service };
}

describe("hash-only BrowserSession", () => {
	it("sets the required host-only cookie attributes and persists only a hash", async () => {
		const { principal, service, records } = setup();
		const created = await service.create(principal);
		const record = records[0];
		if (!record) throw new Error("session record missing");
		expect(created.cookie).toContain("__Host-connection_session=");
		expect(created.cookie).toContain("Path=/");
		expect(created.cookie).toContain("HttpOnly");
		expect(created.cookie).toContain("Secure");
		expect(created.cookie).toContain("SameSite=Strict");
		expect(created.cookie).not.toContain("Domain=");
		expect(record.tokenHash).toBe(hashOpaqueSecret(created.token));
		expect(record).not.toHaveProperty("token");
		expect(
			readBrowserSessionCookie(`other=x; ${created.cookie.split("; ")[0]}`),
		).toBe(created.token);
	});

	it("rejects expired, revoked, generation-mismatched and missing-directory sessions", async () => {
		const { principal, service, sessions, records } = setup();
		const created = await service.create(principal);
		const record = records[0];
		if (!record) throw new Error("session record missing");
		expect(await service.resolve(created.token)).toEqual(principal);
		sessions.findByTokenHash.mockResolvedValueOnce({
			...record,
			expiresAt: 0,
		});
		expect(await service.resolve(created.token)).toBeUndefined();
		sessions.findByTokenHash.mockResolvedValueOnce({
			...record,
			recoveryGeneration: 3,
		});
		expect(await service.resolve(created.token)).toBeUndefined();
		await service.revoke(created.token);
		expect(await service.resolve(created.token)).toBeUndefined();
	});

	it("disables the Principal when the directory entry disappears", async () => {
		const { principal, service, records } = setup();
		const created = await service.create(principal);
		const record = records[0];
		if (!record) throw new Error("session record missing");
		const disablePrincipal = vi.fn(async () => {});
		const missingDirectoryService = new BrowserSessionService(
			{
				insert: async () => {},
				findByTokenHash: async () => record,
				revoke: async () => {},
			},
			{ findById: async () => principal },
			{ check: async () => ({ exists: false }), disablePrincipal },
			() => 1_000,
		);
		expect(
			await missingDirectoryService.resolve(created.token),
		).toBeUndefined();
		expect(disablePrincipal).toHaveBeenCalledWith(principal.id);
	});

	it("uses a bounded opaque token format", () => {
		expect(() => browserSessionCookie("short", 60)).toThrow();
		expect(
			readBrowserSessionCookie("__Host-connection_session=short"),
		).toBeUndefined();
	});
});
