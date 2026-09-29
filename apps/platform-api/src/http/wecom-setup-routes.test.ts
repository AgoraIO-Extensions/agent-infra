import {
	createWecomSetupV1,
	type WecomSetupRecordV1,
} from "@agent-infra/platform-core";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../../packages/platform-core/src/agent-configuration.conformance.ts";
import { HttpProtocolError, requestMetadata } from "./common.ts";
import { registerWecomSetupRoutesV1 } from "./wecom-setup-routes.ts";

function testApp() {
	const app = new Hono();
	app.onError((error, context) => {
		const protocol =
			error instanceof HttpProtocolError
				? error
				: new HttpProtocolError(
						"INTERNAL_ERROR",
						requestMetadata(context.req.raw).traceId,
					);
		return context.json(protocol.body, protocol.status);
	});
	return app;
}

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
	const app = testApp();
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

it("keeps application setup on its own Owner route and withholds submitted secrets", async () => {
	let actor = "owner";
	const records = new Map<string, WecomSetupRecordV1>();
	const setup = createWecomSetupV1({
		authority: async (agentId, actorId) =>
			actorId === "owner"
				? {
						configuration: {
							...agentConfigurationConformanceRecordV1,
							agentId,
						},
						authorizationRevision: "fixture",
					}
				: null,
		store: {
			create: async (record) => {
				records.set(record.sessionId, record);
			},
			read: async (id) => records.get(id) ?? null,
			consume: async ({
				session,
				application,
				encryptedCredential,
				encryptedCallback,
			}) => {
				const saved = records.get(session.sessionId);
				if (saved?.status !== "awaiting_input") return false;
				records.set(session.sessionId, {
					...saved,
					status: "verifying",
					application,
					encryptedCredential,
					encryptedCallback,
				});
				return true;
			},
			cancel: async () => false,
		},
		encrypt: async () => {
			throw new Error("Bot encryptor must not run");
		},
		encryptApplication: async () => ({
			encryptedCredential: { fixture: "ciphertext" },
			encryptedCallback: { fixture: "callback-ciphertext" },
		}),
	});
	const identity = {
		resolve: async () => ({
			schemaVersion: 1 as const,
			userId: actor,
			displayName: "Fixture",
			accountStatus: "active" as const,
			organizationIds: [],
			roles: ["employee"],
			authorizationRevision: "fixture",
		}),
		hydrateUsers: async () => [],
	};
	const app = testApp();
	expect(() =>
		registerWecomSetupRoutesV1(app, { setup, identity, application: true }),
	).toThrow("callback URL unavailable");
	registerWecomSetupRoutesV1(app, {
		setup,
		identity,
		application: true,
		callbackUrl: (id) => `https://example.invalid/callbacks/wecom/${id}`,
	});
	const base = "/api/v1/agents/agent/wecom-app-setup";
	const begun = await app.request(base, { method: "POST" });
	expect(begun.status).toBe(200);
	const session = (await begun.json()) as {
		sessionId: string;
		state: string;
		callbackUrl: string;
	};
	expect(session.callbackUrl).toContain(session.sessionId);
	const url = `${base}/${session.sessionId}/credentials`;
	const body = {
		state: session.state,
		corporationId: "corp",
		applicationId: "7",
		secret: "fixture-secret",
		token: "fixture-token",
		encodingAesKey: "A".repeat(43),
		takeoverConfirmed: true,
	};
	const submit = (value: unknown) =>
		app.request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(value),
		});
	actor = "other";
	expect((await submit(body)).status).toBe(404);
	actor = "owner";
	expect((await submit({ ...body, actorId: "owner" })).status).toBe(400);
	expect((await submit({ ...body, takeoverConfirmed: false })).status).toBe(
		400,
	);
	const saved = await submit(body);
	expect(saved.status).toBe(200);
	expect(await saved.text()).not.toContain("fixture-secret");
	expect((await submit(body)).status).toBe(404);
});
