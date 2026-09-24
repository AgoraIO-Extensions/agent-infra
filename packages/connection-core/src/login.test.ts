import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
	ConnectionLoginService,
	type LoginAuditEvent,
	LoginRejectedError,
	LoginUnavailableError,
} from "./login.js";
import { LoginRateLimitedError, LoginThrottle } from "./login-throttle.js";

const marker = (_kind: "account" | "source", value: string) =>
	createHash("sha256").update(value).digest("hex");

it("pads credential and disabled-Principal failures and audits stable redacted markers", async () => {
	const audit = vi.fn(async (_event: LoginAuditEvent) => {});
	const authenticator = {
		authenticate: vi.fn(async (username: string) => {
			if (username === "missing") throw new LoginRejectedError();
			return { issuer: "corp-ldap", uid: "alice", dn: "uid=alice" };
		}),
	};
	const service = new ConnectionLoginService({
		authenticator,
		principals: {
			resolve: async () => ({
				id: "principal-alice",
				issuer: "corp-ldap",
				uid: "alice",
				status: "disabled" as const,
				recoveryGeneration: 2,
			}),
		},
		sessions: {
			create: vi.fn(async () => {
				throw new Error("must not create");
			}),
			resolve: async () => undefined,
			revoke: async () => {},
		},
		throttle: new LoginThrottle(),
		audit,
		marker,
		environment: "test",
		failureFloorMs: 30,
	});
	for (const username of ["missing", "alice"]) {
		const started = Date.now();
		await expect(
			service.login({ username, password: "secret", source: "127.0.0.1" }),
		).rejects.toBeInstanceOf(LoginRejectedError);
		expect(Date.now() - started).toBeGreaterThanOrEqual(29);
	}
	expect(audit).toHaveBeenCalledTimes(2);
	expect(audit.mock.calls[0]?.[0]).toMatchObject({
		action: "auth.login",
		outcome: "failed",
		environment: "test",
		accountMarker: marker("account", "missing"),
		sourceMarker: marker("source", "127.0.0.1"),
	});
	expect(JSON.stringify(audit.mock.calls)).not.toContain("secret");
	expect(JSON.stringify(audit.mock.calls)).not.toContain("127.0.0.1");
});

it("rejects a marker adapter that could expose raw login input", async () => {
	const authenticate = vi.fn(async () => ({
		issuer: "corp-ldap",
		uid: "alice",
		dn: "uid=alice",
	}));
	const service = new ConnectionLoginService({
		authenticator: { authenticate },
		principals: {
			resolve: async () => {
				throw new Error("must not resolve");
			},
		},
		sessions: {
			create: async () => {
				throw new Error("must not create");
			},
			resolve: async () => undefined,
			revoke: async () => {},
		},
		throttle: new LoginThrottle(),
		audit: async () => {},
		marker: () => "alice",
		environment: "test",
		failureFloorMs: 0,
	});
	await expect(
		service.login({
			username: "alice",
			password: "secret",
			source: "127.0.0.1",
		}),
	).rejects.toBeInstanceOf(LoginUnavailableError);
	expect(authenticate).not.toHaveBeenCalled();
});

it("audits consecutive failures and rejected attempts with the same redacted markers", async () => {
	const audit = vi.fn(async (_event: LoginAuditEvent) => {});
	const authenticate = vi.fn(async () => {
		throw new LoginRejectedError();
	});
	const service = new ConnectionLoginService({
		authenticator: { authenticate },
		principals: {
			resolve: async () => {
				throw new Error("must not resolve");
			},
		},
		sessions: {
			create: async () => {
				throw new Error("must not create");
			},
			resolve: async () => undefined,
			revoke: async () => {},
		},
		throttle: new LoginThrottle(() => 0),
		audit,
		marker,
		environment: "test",
		failureFloorMs: 0,
	});
	const input = { username: " Alice ", password: "wrong", source: "127.0.0.1" };
	for (let attempt = 0; attempt < 3; attempt += 1)
		await expect(service.login(input)).rejects.toBeInstanceOf(
			LoginRejectedError,
		);
	await expect(service.login(input)).rejects.toBeInstanceOf(
		LoginRateLimitedError,
	);
	expect(authenticate).toHaveBeenCalledTimes(3);
	expect(audit.mock.calls.map(([event]) => event.outcome)).toEqual([
		"failed",
		"failed",
		"failed",
		"rejected",
	]);
	expect(
		new Set(audit.mock.calls.map(([event]) => event.accountMarker)),
	).toEqual(new Set([marker("account", "alice")]));
	expect(
		new Set(audit.mock.calls.map(([event]) => event.sourceMarker)),
	).toEqual(new Set([marker("source", "127.0.0.1")]));
	expect(JSON.stringify(audit.mock.calls)).not.toContain("wrong");
	expect(JSON.stringify(audit.mock.calls)).not.toContain("127.0.0.1");
});
