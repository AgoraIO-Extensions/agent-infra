import { AgentApiCreationRequestV1Schema } from "@agent-infra/contracts/pilot";
import { PersonalApiCredentialErrorV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAgentApiCreationRoutes } from "./agent-api-creation-routes.js";

const material = `papi_${"A".repeat(43)}`;
const headers = {
	Authorization: `Bearer ${material}`,
	"Idempotency-Key": "create-1",
	"Content-Type": "application/json",
};
const body = JSON.stringify({
	schemaVersion: 2,
	name: "Bot Agent",
	description: "Created by the bot application",
	source: {
		kind: "custom",
		imageReference: `registry.example/agent@sha256:${"a".repeat(64)}`,
		interactionMode: "self-managed",
		identityResponsibility: "self-managed",
	},
	coOwnerIds: [],
	availability: [],
	environment: [],
	secrets: [],
});

function fixture() {
	const create = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		agentId: "agent-api",
		status: "creating",
		revision: 1,
		replayed: false,
	});
	const recordRefusal = vi.fn().mockResolvedValue(undefined);
	const app = new Hono();
	registerAgentApiCreationRoutes(app, { create, recordRefusal });
	return { app, create, recordRefusal };
}

describe("Agent API creation HTTP", () => {
	it("passes only the bearer material and server metadata to Core", async () => {
		const f = fixture();
		const response = await f.app.request("/api/v2/agents", {
			method: "POST",
			headers,
			body,
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			agentId: "agent-api",
			status: "creating",
			revision: 1,
			replayed: false,
		});
		expect(f.create).toHaveBeenCalledWith(
			expect.objectContaining({
				schemaVersion: 2,
				idempotencyKey: "create-1",
				name: "Bot Agent",
			}),
			material,
		);
		expect(f.recordRefusal).not.toHaveBeenCalled();
	});

	it.each([
		["Cookie", "session=caller"],
		["X-User-Id", "other-user"],
		["X-Application-Id", "other-application"],
		["X-Scope", "agent:create"],
	])("rejects mixed or caller-authored identity in %s", async (name, value) => {
		const f = fixture();
		const response = await f.app.request("/api/v2/agents", {
			method: "POST",
			headers: { ...headers, [name]: value },
			body,
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(f.create).not.toHaveBeenCalled();
		expect(f.recordRefusal).toHaveBeenCalledOnce();
		expect(JSON.stringify(f.recordRefusal.mock.calls)).not.toContain(material);
	});

	it("rejects caller principal fields instead of forwarding them", async () => {
		const f = fixture();
		const response = await f.app.request("/api/v2/agents", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...JSON.parse(body),
				principal: { kind: "application", id: "other" },
			}),
		});
		expect(response.status).toBe(400);
		expect(f.create).not.toHaveBeenCalled();
	});

	it("maps credential failures without exposing the token", async () => {
		const f = fixture();
		f.create.mockRejectedValue(new PersonalApiCredentialErrorV1("forbidden"));
		const response = await f.app.request("/api/v2/agents", {
			method: "POST",
			headers,
			body,
		});
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain(material);
	});
	it("returns the original replay result and maps conflicts and audit failure", async () => {
		const f = fixture();
		f.create.mockResolvedValueOnce({
			schemaVersion: 1,
			agentId: "agent-api",
			status: "stopped",
			revision: 2,
			replayed: true,
		});
		const replay = await f.app.request("/api/v2/agents", {
			method: "POST",
			headers,
			body,
		});
		expect(replay.status).toBe(200);
		expect(replay.headers.get("Cache-Control")).toBe("no-store");
		expect(await replay.json()).toMatchObject({
			agentId: "agent-api",
			status: "stopped",
			replayed: true,
		});
		f.create.mockRejectedValue(
			new PersonalApiCredentialErrorV1("idempotency_conflict"),
		);
		expect(
			(await f.app.request("/api/v2/agents", { method: "POST", headers, body }))
				.status,
		).toBe(409);
		f.recordRefusal.mockRejectedValue(new Error("private audit failure"));
		const failed = await f.app.request("/api/v2/agents", {
			method: "POST",
			headers,
			body,
		});
		expect(failed.status).toBe(503);
		expect(await failed.text()).not.toContain("private audit failure");
	});
	it("requires one default Key and keyless models for standard creation", () => {
		const value = {
			...JSON.parse(body),
			schemaVersion: 3,
			source: { kind: "standard", templateId: "codex" },
			defaultRelayKey: "controlled-key-material",
			modelConfiguration: {
				options: [
					{
						optionId: "model",
						endpointId: "relay",
						modelId: "model-a",
						reasoningLevels: ["low"],
					},
				],
				defaultOptionId: "model",
				defaultReasoningLevel: "low",
			},
		};
		expect(AgentApiCreationRequestV1Schema.safeParse(value).success).toBe(true);
		for (const bad of [
			{ ...value, schemaVersion: 2 },
			{ ...value, defaultRelayKey: undefined },
			{ ...value, defaultRelayKey: "short" },
			{ ...value, modelConfiguration: undefined },
			{
				...value,
				modelConfiguration: {
					...value.modelConfiguration,
					options: [
						{
							...value.modelConfiguration.options[0],
							credentialValue: "private",
						},
					],
				},
			},
			{ ...JSON.parse(body), modelConfiguration: value.modelConfiguration },
		])
			expect(AgentApiCreationRequestV1Schema.safeParse(bad).success).toBe(
				false,
			);
	});
});
