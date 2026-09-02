import {
	BrowserSessionProjectionV1Schema,
	PlatformAuditProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { HttpProtocolError } from "./common.js";
import { registerSessionAuditRoutes } from "./session-audit-routes.js";

const activeIdentity = {
	schemaVersion: 1 as const,
	userId: "admin-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const, "system_admin" as const],
	authorizationRevision: "authorization-1",
};

function createApp(identity = activeIdentity) {
	const app = new Hono();
	app.onError((error, context) =>
		error instanceof HttpProtocolError
			? context.json(error.body, error.status)
			: context.json({ error: "internal" }, 500),
	);
	const identityAdapter = {
		resolve: vi.fn().mockResolvedValue(identity),
		hydrateUsers: vi.fn().mockResolvedValue([
			{
				userId: "actor-1",
				displayName: "Operator",
				roles: ["employee", "system_admin"],
			},
		]),
	};
	const audit = {
		listAudit: vi.fn().mockResolvedValue({
			items: [
				{
					schemaVersion: 1,
					auditId: "audit-1",
					actor: { kind: "user", actorId: "actor-1" },
					action: "agent.configuration.revised",
					subject: { kind: "agent", subjectId: "agent-1" },
					result: "succeeded",
					summary: "agent.configuration.revised: secrets",
					occurredAt: new Date("2026-09-02T06:00:00.000Z"),
					traceId: "trace-audit-1",
				},
			],
			nextCursor: "audit-next",
		}),
	};
	registerSessionAuditRoutes(app, { identity: identityAdapter, audit });
	return { app, identityAdapter, audit };
}

describe("session and audit routes", () => {
	it("returns the freshly resolved current session", async () => {
		const { app, identityAdapter } = createApp();
		const response = await app.request("/api/v1/session", {
			headers: { "x-user-id": "forged-user" },
		});

		expect(response.status).toBe(200);
		expect(
			BrowserSessionProjectionV1Schema.parse(await response.json()),
		).toEqual({
			schemaVersion: 1,
			user: {
				userId: "admin-1",
				displayName: "Ada",
				roles: ["employee", "system_admin"],
			},
		});
		expect(identityAdapter.resolve).toHaveBeenCalledOnce();
	});

	it("requires administrator scope and maps only public audit fields", async () => {
		const { app, identityAdapter, audit } = createApp();
		const response = await app.request("/api/v1/admin/audit?limit=25");

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			items: unknown[];
			nextCursor: string | null;
		};
		expect(
			body.items.map((item) => PlatformAuditProjectionV1Schema.parse(item)),
		).toEqual([
			{
				schemaVersion: 1,
				auditId: "audit-1",
				action: "agent.configuration.revised",
				actor: {
					userId: "actor-1",
					displayName: "Operator",
					roles: ["employee", "system_admin"],
				},
				subjectType: "agent",
				subjectId: "agent-1",
				result: "succeeded",
				summary: "agent.configuration.revised: secrets",
				occurredAt: "2026-09-02T06:00:00.000Z",
				traceId: "trace-audit-1",
			},
		]);
		expect(body.nextCursor).toBe("audit-next");
		expect(audit.listAudit).toHaveBeenCalledWith(
			{
				schemaVersion: 1,
				kind: "administrator",
				administratorId: "admin-1",
			},
			{ schemaVersion: 1, limit: 25 },
		);
		expect(identityAdapter.hydrateUsers).toHaveBeenCalledWith(["actor-1"]);
		expect(JSON.stringify(body)).not.toContain('"kind":"user"');
		expect(JSON.stringify(body)).not.toContain("details");
	});

	it("rejects non-administrators before querying audit persistence", async () => {
		const { app, audit } = createApp({
			...activeIdentity,
			roles: ["employee"],
		});
		const response = await app.request("/api/v1/admin/audit");

		expect(response.status).toBe(403);
		expect(audit.listAudit).not.toHaveBeenCalled();
	});

	it("does not invent a browser user for a system audit actor", async () => {
		const { app, identityAdapter, audit } = createApp();
		audit.listAudit.mockResolvedValue({
			items: [
				{
					schemaVersion: 1,
					auditId: "audit-system",
					actor: { kind: "system", actorId: "platform-worker" },
					action: "agent.workload.service_ready",
					subject: { kind: "agent", subjectId: "agent-1" },
					result: "succeeded",
					summary: "agent.workload.service_ready",
					occurredAt: new Date("2026-09-02T06:01:00.000Z"),
					traceId: "trace-system",
				},
			],
			nextCursor: null,
		});

		const response = await app.request("/api/v1/admin/audit");

		expect(response.status).toBe(503);
		expect(identityAdapter.hydrateUsers).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain("platform-worker");
	});
});
