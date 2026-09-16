import {
	createWecomSetupV1,
	type WecomSetupRecordV1,
} from "@agent-infra/platform-core";
import { expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../../packages/platform-core/src/agent-configuration.conformance.ts";
import { createPlatformHealthApp } from "../app.ts";
import { registerWecomSetupRoutesV1 } from "./wecom-setup-routes.ts";

it("authenticates setup routes and rejects cross-Owner, cross-Agent, replay and identity injection", async () => {
	let actor: string | null = "owner";
	const records = new Map<string, WecomSetupRecordV1>();
	let encrypted = 0;
	const setup = createWecomSetupV1({
		authority: async (agentId, actorId) =>
			actorId === "owner"
				? {
						configuration: {
							...agentConfigurationConformanceRecordV1,
							agentId,
							revision: 1,
						},
						authorizationRevision: "fixture",
					}
				: null,
		store: {
			create: async (record) => {
				records.set(record.sessionId, record);
			},
			read: async (id) => records.get(id) ?? null,
			consume: async ({ session }) => {
				const value = records.get(session.sessionId);
				if (value?.status !== "awaiting_input") return false;
				records.set(session.sessionId, { ...value, status: "verifying" });
				return true;
			},
			cancel: async () => false,
		},
		encrypt: async () => {
			encrypted++;
			return { fixture: "ciphertext" };
		},
	});
	const app = createPlatformHealthApp();
	registerWecomSetupRoutesV1(app, {
		setup,
		identity: {
			resolve: async () =>
				actor
					? {
							schemaVersion: 1,
							userId: actor,
							displayName: "Fixture",
							accountStatus: "active",
							organizationIds: [],
							roles: ["employee"],
							authorizationRevision: "fixture",
						}
					: null,
			hydrateUsers: async () => [],
		},
	});
	const base = "/api/v1/agents/agent/wecom-setup";
	actor = null;
	expect((await app.request(base, { method: "POST" })).status).toBe(401);
	actor = "owner";
	const response = await app.request(base, { method: "POST" });
	expect(response.status).toBe(200);
	const session = (await response.json()) as {
		sessionId: string;
		state: string;
		qrAvailable: boolean;
		stateDigest?: string;
	};
	expect(session.qrAvailable).toBe(false);
	expect(session.stateDigest).toBeUndefined();
	const path = `${base}/${session.sessionId}/credentials`;
	const body = {
		state: session.state,
		botId: "bot",
		secret: "fixture-secret",
		takeoverConfirmed: true,
	};
	const submit = (url = path, data: unknown = body) =>
		app.request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(data),
		});
	actor = "other";
	expect((await submit()).status).toBe(404);
	actor = "owner";
	expect(
		(await submit(path.replace("/agents/agent/", "/agents/other/"))).status,
	).toBe(404);
	expect((await submit(path, { ...body, actorId: "owner" })).status).toBe(400);
	expect(encrypted).toBe(0);
	const saved = await submit();
	expect(saved.status).toBe(200);
	expect(await saved.text()).not.toContain("fixture-secret");
	expect((await submit()).status).toBe(404);
	expect(encrypted).toBe(1);
});
