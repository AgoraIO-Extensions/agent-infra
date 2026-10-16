import type { OperationalEvent } from "@agent-infra/observability";
import { createHttpObservability } from "@agent-infra/observability/http";
import {
	ApplicationFoundationError,
	PersonalApiCredentialErrorV1,
} from "@agent-infra/platform-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAgentApiLifecycleRoutes } from "./agent-api-lifecycle-routes.js";

const material = `papi_${"A".repeat(43)}`;
const headers = {
	Authorization: `Bearer ${material}`,
	"Idempotency-Key": "start-1",
	"Content-Type": "application/json",
};
const path = "/api/v2/agents/agent/commands";
const body = JSON.stringify({ schemaVersion: 1, command: "start" });
function fixture() {
	const execute = vi.fn().mockResolvedValue({
		outcome: "accepted",
		result: {
			schemaVersion: 1,
			applicationId: "application",
			agentId: "agent",
			status: "available",
			revision: 2,
		},
	});
	const recordRefusal = vi.fn().mockResolvedValue(undefined);
	const app = new Hono();
	registerAgentApiLifecycleRoutes(app, {
		readState: vi.fn().mockResolvedValue({
			schemaVersion: 1,
			agentId: "agent",
			status: "stopped",
			serviceAvailability: null,
			revision: 1,
		}),
		lifecycle: { execute },
		recordRefusal,
	});
	return { app, execute, recordRefusal };
}
describe("Agent API lifecycle HTTP", () => {
	it("uses the Bearer material without a personal session or caller identity", async () => {
		const f = fixture();
		const response = await f.app.request(path, {
			method: "POST",
			headers,
			body,
		});
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			agentId: "agent",
			status: "available",
			revision: 2,
			replayed: false,
		});
		expect(f.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent",
				command: "start",
				idempotencyKey: "start-1",
			}),
			material,
		);
		expect(f.recordRefusal).not.toHaveBeenCalled();
	});
	it("returns a bounded failure code and sanitized reason only when present", async () => {
		const f = fixture();
		f.app = new Hono();
		registerAgentApiLifecycleRoutes(f.app, {
			readState: vi.fn().mockResolvedValue({
				schemaVersion: 1,
				agentId: "agent",
				status: "creation_failed",
				serviceAvailability: null,
				revision: 3,
				failureCode: "creation_not_ready",
				failureReason: "Agent image admission or creation readiness failed",
			}),
			lifecycle: { execute: f.execute },
			recordRefusal: f.recordRefusal,
		});
		const response = await f.app.request("/api/v2/agents/agent/state", {
			headers: { Authorization: `Bearer ${material}` },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			agentId: "agent",
			status: "creation_failed",
			serviceAvailability: null,
			revision: 3,
			failureCode: "creation_not_ready",
			failureReason: "Agent image admission or creation readiness failed",
		});
	});
	it("rejects complete failure details on a non-failure state", async () => {
		const f = fixture();
		f.app = new Hono();
		registerAgentApiLifecycleRoutes(f.app, {
			readState: vi.fn().mockResolvedValue({
				schemaVersion: 1,
				agentId: "agent",
				status: "stopped",
				serviceAvailability: null,
				revision: 1,
				failureCode: "creation_not_ready",
				failureReason: "Agent image admission or creation readiness failed",
			}),
			lifecycle: { execute: f.execute },
			recordRefusal: f.recordRefusal,
		});
		const response = await f.app.request("/api/v2/agents/agent/state", {
			headers: { Authorization: `Bearer ${material}` },
		});
		expect(response.status).toBe(500);
		expect(f.recordRefusal).toHaveBeenCalledOnce();
	});
	it.each([
		["Cookie", "session=caller"],
		["X-User-Id", "owner"],
		["X-Application-Id", "other-application"],
		["X-Scope", "agent:manage"],
	])("rejects mixed or caller-authored identity in %s", async (name, value) => {
		const f = fixture();
		const response = await f.app.request(path, {
			method: "POST",
			headers: { ...headers, [name]: value },
			body,
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(f.execute).not.toHaveBeenCalled();
		expect(f.recordRefusal).toHaveBeenCalledOnce();
		expect(JSON.stringify(f.recordRefusal.mock.calls)).not.toContain(material);
	});
	it("cannot use a browser session without a Token", async () => {
		const f = fixture();
		const response = await f.app.request(path, {
			method: "POST",
			headers: { Cookie: "session=owner", "Idempotency-Key": "start-1" },
			body,
		});
		expect(response.status).toBe(401);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("rejects caller principal fields instead of forwarding them", async () => {
		const f = fixture();
		const response = await f.app.request(path, {
			method: "POST",
			headers,
			body: JSON.stringify({
				schemaVersion: 1,
				command: "start",
				principal: { kind: "application", id: "other" },
			}),
		});
		expect(response.status).toBe(400);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("fails closed when necessary refusal audit cannot be saved", async () => {
		const f = fixture();
		f.recordRefusal.mockRejectedValue(new Error("private audit dependency"));
		const response = await f.app.request(path, { method: "POST", body });
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("private audit dependency");
	});
	it("records a bounded 503 lifecycle failure with its route template", async () => {
		const events: OperationalEvent[] = [];
		const app = new Hono();
		app.use(
			"*",
			createHttpObservability({ record: (event) => events.push(event) }),
		);
		const execute = vi
			.fn()
			.mockRejectedValue(new ApplicationFoundationError("persistence_failed"));
		registerAgentApiLifecycleRoutes(app, {
			readState: vi.fn(),
			lifecycle: { execute },
			recordRefusal: vi.fn().mockResolvedValue(undefined),
		});

		const response = await app.request(
			"/api/v2/agents/agent-private/commands",
			{
				method: "POST",
				headers,
				body,
			},
		);

		expect(response.status).toBe(503);
		expect(events).toEqual([
			expect.objectContaining({
				stage: "http",
				outcome: "failed",
				method: "POST",
				routeTemplate: "/api/v2/agents/:agentId/commands",
				statusCode: 503,
				code: "DEPENDENCY_UNAVAILABLE",
			}),
		]);
		expect(JSON.stringify(events)).not.toContain("agent-private");
	});
	it.each([
		["authentication_required", 401],
		["forbidden", 403],
		["not_found", 404],
		["unavailable", 503],
	] as const)("maps %s without exposing credentials", async (code, status) => {
		const f = fixture();
		f.execute.mockRejectedValue(new PersonalApiCredentialErrorV1(code));
		const response = await f.app.request(path, {
			method: "POST",
			headers,
			body,
		});
		expect(response.status).toBe(status);
		expect(await response.text()).not.toContain(material);
	});
});
