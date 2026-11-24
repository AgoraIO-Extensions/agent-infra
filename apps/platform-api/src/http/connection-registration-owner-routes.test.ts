import { createHash } from "node:crypto";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { registerConnectionRegistrationOwnerRoutesV1 } from "./connection-registration-owner-routes.js";

it("authenticates a dedicated source reader and projects only current Owner facts", async () => {
	const token = `conn_platform_owner_${"B".repeat(43)}`;
	const app = new Hono();
	registerConnectionRegistrationOwnerRoutesV1(app, {
		credentialHash: createHash("sha256").update(token).digest("hex"),
		read: async (source, agent, purpose) =>
			source === "source-a" && agent === "agent-a" && purpose === "read"
				? {
						schemaVersion: 1,
						sourceNamespace: source,
						platformAgentId: agent,
						platformOwnerId: "owner-a",
						policyRevision: "policy-1",
						directorySource: "enterprise-tools",
						wechatUserId: "wechat-a",
						email: "a@example.test",
						ownerRevision: "current-1",
						expiresAt: Date.now() + 20_000,
					}
				: undefined,
	});
	const target =
		"http://local/api/internal/connection-registration/v1/owners/source-a/agent-a?purpose=read";
	const headers = { authorization: `Bearer ${token}` };
	const good = await app.request(target, { headers });
	expect(good.status).toBe(200);
	expect(good.headers.get("cache-control")).toBe("no-store");
	expect(await good.json()).toMatchObject({
		platformOwnerId: "owner-a",
		wechatUserId: "wechat-a",
	});
	for (const extra of [
		{ cookie: "session=synthetic" },
		{ origin: "https://browser.example.test" },
		{ authorization: "Bearer wrong" },
	])
		expect(
			(await app.request(target, { headers: { ...headers, ...extra } })).status,
		).toBe(401);
	expect(
		(await app.request(`${target}&userId=another-user`, { headers })).status,
	).toBe(400);
	expect(
		(await app.request(target.replace("source-a", "source-b"), { headers }))
			.status,
	).toBe(404);
	expect(
		(await app.request(target.replace("agent-a", "agent-b"), { headers }))
			.status,
	).toBe(404);
});

it("settles a stalled authority at the original five-second deadline and propagates abort", async () => {
	const { vi } = await import("vitest");
	const token = `conn_platform_owner_${"B".repeat(43)}`;
	const app = new Hono();
	let entered!: () => void;
	const reading = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let aborted = false;
	registerConnectionRegistrationOwnerRoutesV1(app, {
		credentialHash: createHash("sha256").update(token).digest("hex"),
		read: async (_source, _agent, _purpose, signal) => {
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
				},
				{ once: true },
			);
			entered();
			return new Promise(() => {});
		},
	});
	vi.useFakeTimers();
	try {
		const pending = app.request(
			"http://local/api/internal/connection-registration/v1/owners/source-a/agent-a?purpose=read",
			{ headers: { authorization: `Bearer ${token}` } },
		);
		await reading;
		await vi.advanceTimersByTimeAsync(5000);
		expect((await pending).status).toBe(503);
		expect(aborted).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});
