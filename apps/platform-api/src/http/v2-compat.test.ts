import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerV2CompatibilityRoutes } from "./v2-compat.js";

describe("V2 compatibility routes", () => {
	it("projects agent pages as schema version 2 without platform actions", async () => {
		const app = new Hono();
		app.get("/api/v1/agents", (context) =>
			context.json({
				items: [
					{
						schemaVersion: 1,
						agentId: "agent-1",
						configuration: { actions: [], owners: [] },
					},
				],
				nextCursor: null,
			}),
		);
		registerV2CompatibilityRoutes(app);

		const response = await app.request("http://localhost/api/v2/agents");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			items: [
				{
					schemaVersion: 2,
					agentId: "agent-1",
					configuration: { owners: [] },
				},
			],
			nextCursor: null,
		});
	});

	it("rewrites V2 application input to the V1 foundation contract", async () => {
		const app = new Hono();
		app.post("/api/v1/agent-applications", async (context) => {
			const body = (await context.req.json()) as Record<string, unknown>;
			return context.json({
				schemaVersion: 1,
				applicationId: "application-1",
				agentId: null,
				name: body.name,
				description: "description",
				source: { kind: "standard", templateId: "template-1" },
				status: "pending_approval",
				resourceProfile: {
					profileId: "profile-1",
					displayName: "profile",
					estimatedResources: {
						cpuMillicores: 1,
						memoryMiB: 1,
						storageGiB: 1,
					},
				},
				configuration: { owners: [], actions: [] },
				submittedAt: "2026-01-01T00:00:00.000Z",
				decision: null,
			});
		});
		registerV2CompatibilityRoutes(app);

		const response = await app.request(
			new Request("http://localhost/api/v2/agent-applications", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "idem-1",
				},
				body: JSON.stringify({
					schemaVersion: 2,
					name: "new agent",
					description: "description",
					source: { kind: "standard", templateId: "template-1" },
					coOwnerIds: [],
					availability: [],
					modelConfiguration: undefined,
					environment: [],
					secrets: [],
				}),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.schemaVersion).toBe(2);
		expect(body.configuration).not.toHaveProperty("actions");
	});

	it("projects the V2 configuration PUT response as an Agent", async () => {
		const app = new Hono();
		app.put("/api/v1/agents/agent-1/configuration", async (context) => {
			expect(await context.req.json()).toEqual({
				schemaVersion: 1,
				coOwnerIds: ["user-1"],
			});
			return context.json({
				schemaVersion: 1,
				agentId: "agent-1",
				name: "Agent",
				description: "Configuration fixture",
				source: { kind: "standard", templateId: "template-1" },
				managementStatus: "available",
				serviceAvailability: "ready",
				configuration: {
					owners: [
						{ userId: "user-1", displayName: "Ada", roles: ["employee"] },
					],
					availability: [],
					modelOptions: [],
					defaultModelOptionId: null,
					defaultReasoningLevel: null,
					actions: [],
					environment: [],
					channels: [],
					secrets: [],
				},
				capabilities: {
					modelSelection: false,
					attachments: false,
					resultFiles: false,
					connection: false,
					supplementaryInstruction: false,
				},
				interactionUrl: null,
			});
		});
		registerV2CompatibilityRoutes(app);

		const response = await app.request(
			"http://localhost/api/v2/agents/agent-1/configuration",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ schemaVersion: 2, coOwnerIds: ["user-1"] }),
			},
		);
		expect(response.status).toBe(200);
		const result = AgentProjectionV2Schema.parse(await response.json());
		expect(result.schemaVersion).toBe(2);
		expect(result.configuration).not.toHaveProperty("actions");
	});

	it.each([
		["/api/v2/agent-applications", "POST"],
		["/api/v2/agent-applications/application-1", "PUT"],
		["/api/v2/agents/agent-1/configuration", "PUT"],
	] as const)(
		"rejects invalid V2 schema versions at %s",
		async (path, method) => {
			const app = new Hono();
			let forwarded = 0;
			app.all("/api/v1/*", () => {
				forwarded += 1;
				return new Response(null, { status: 200 });
			});
			registerV2CompatibilityRoutes(app);
			for (const schemaVersion of [1, 3, undefined]) {
				const response = await app.request(
					new Request(`http://localhost${path}`, {
						method,
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ schemaVersion, name: "invalid" }),
					}),
				);
				expect(response.status).toBe(400);
			}
			expect(forwarded).toBe(0);
		},
	);

	it("rejects unsupported agent list scopes", async () => {
		const app = new Hono();
		app.get("/api/v1/agents", () => new Response("unexpected"));
		registerV2CompatibilityRoutes(app);

		const response = await app.request(
			"http://localhost/api/v2/agents?scope=visible",
		);
		expect(response.status).toBe(400);
	});
});
