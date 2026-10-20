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
			activeBinding: async () => false,
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
	let cancellations = 0;
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
			activeBinding: async () => false,
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
			cancel: async (session) => {
				const saved = records.get(session.sessionId);
				if (!saved || !["awaiting_input", "verifying"].includes(saved.status))
					return false;
				cancellations++;
				records.set(session.sessionId, { ...saved, status: "cancelled" });
				return true;
			},
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
	registerWecomSetupRoutesV1(app, { setup, identity });
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
	const botBase = "/api/v1/agents/agent/wecom-setup";
	const bot = (await (
		await app.request(botBase, { method: "POST" })
	).json()) as { sessionId: string };
	for (const [route, foreignId] of [
		[base, bot.sessionId],
		[botBase, session.sessionId],
	] as const) {
		expect((await app.request(`${route}/${foreignId}`)).status).toBe(404);
		expect(
			(await app.request(`${route}/${foreignId}/cancel`, { method: "POST" }))
				.status,
		).toBe(404);
	}
	expect(cancellations).toBe(0);
	expect((await app.request(`${base}/${session.sessionId}`)).status).toBe(200);
	expect((await app.request(`${botBase}/${bot.sessionId}`)).status).toBe(200);
	expect(
		(
			await app.request(`${base}/${session.sessionId}/cancel`, {
				method: "POST",
			})
		).status,
	).toBe(200);
	expect(
		(
			await app.request(`${botBase}/${bot.sessionId}/cancel`, {
				method: "POST",
			})
		).status,
	).toBe(200);
	expect(cancellations).toBe(2);
});

it("returns only deployment-approved QR metadata and keeps manual fallback when absent", async () => {
	const records = new Map<string, WecomSetupRecordV1>();
	const setup = createWecomSetupV1({
		authority: async (agentId) => ({
			configuration: {
				...agentConfigurationConformanceRecordV1,
				agentId,
				revision: 3,
			},
			authorizationRevision: "qr-revision",
		}),
		store: {
			activeBinding: async () => false,
			create: async (record) => void records.set(record.sessionId, record),
			read: async (id) => records.get(id) ?? null,
			consume: async () => true,
			cancel: async () => false,
		},
		encrypt: async () => ({ cipher: true }),
	});
	const identity = {
		resolve: async () => ({
			schemaVersion: 1 as const,
			userId: "owner",
			displayName: "Owner",
			accountStatus: "active" as const,
			organizationIds: [],
			roles: ["employee"],
			authorizationRevision: "qr-revision",
		}),
		hydrateUsers: async () => [],
	};
	const app = testApp();
	registerWecomSetupRoutesV1(app, {
		setup,
		identity,
		botQr: {
			source: "agent-infra",
			authOrigin: "https://auth.example.test",
			authorizationEndpoint: "https://auth.example.test/authorize",
		},
	});
	const response = await app.request("/api/v1/agents/agent/wecom-setup", {
		method: "POST",
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		qrAvailable: boolean;
		state: string;
		qr?: {
			authorizationUrl: string;
			authOrigin: string;
			source: string;
			state: string;
		};
	};
	expect(body.qrAvailable).toBe(true);
	expect(body.qr).toMatchObject({
		authOrigin: "https://auth.example.test",
		source: "agent-infra",
		state: body.state,
	});
	expect(body.qr?.authorizationUrl).toContain("source=agent-infra");
	expect(body.qr?.authorizationUrl).toContain(
		`state=${encodeURIComponent(body.state)}`,
	);
});

it("returns QR availability on the bot status V2 only to the current Owner, decided like the setup session (#2911)", async () => {
	let actor: string | null = "owner";
	// 只有 owner 拥有 agent；other 不是 Owner，agent-b 不属于 owner。
	const setup = createWecomSetupV1({
		authority: async (agentId, actorId) =>
			actorId === "owner" && agentId === "agent"
				? {
						configuration: {
							...agentConfigurationConformanceRecordV1,
							agentId,
							revision: 2,
						},
						authorizationRevision: "qr-status",
					}
				: null,
		store: {
			activeBinding: async () => false,
			create: async () => {},
			read: async () => null,
			consume: async () => false,
			cancel: async () => false,
		},
		encrypt: async () => ({ cipher: true }),
	});
	const identity = {
		resolve: async () =>
			actor
				? {
						schemaVersion: 1 as const,
						userId: actor,
						displayName: "Fixture",
						accountStatus: "active" as const,
						organizationIds: [],
						roles: ["employee"],
						authorizationRevision: "qr-status",
					}
				: null,
		hydrateUsers: async () => [],
	};
	const botQr = {
		source: "agent-infra",
		authOrigin: "https://auth.example.test",
		authorizationEndpoint: "https://auth.example.test/authorize",
	};
	const withQr = testApp();
	registerWecomSetupRoutesV1(withQr, { setup, identity, botQr });
	const withoutQr = testApp();
	registerWecomSetupRoutesV1(withoutQr, { setup, identity });
	const status = "/api/v2/agents/agent/wecom-bot";

	// 扫码能力与建立配置会话的响应来自同一份部署判定。
	for (const [app, expected] of [
		[withQr, { status: "not_configured", qrAvailable: true }],
		[
			withoutQr,
			{
				status: "not_configured",
				qrAvailable: false,
				qrUnavailableReason: "authorization_correlation_unverified",
			},
		],
	] as const) {
		const read = await app.request(status);
		expect(read.status).toBe(200);
		const text = await read.text();
		expect(JSON.parse(text)).toEqual(expected);
		// 状态投影不带授权地址、来源或 state，二者仍只由配置会话响应给出。
		for (const material of ["authorizationUrl", "auth.example.test", "state"])
			expect(text).not.toContain(material);
		const begun = (await (
			await app.request("/api/v1/agents/agent/wecom-setup", { method: "POST" })
		).json()) as { qrAvailable: boolean; qrUnavailableReason?: string };
		expect(begun.qrAvailable).toBe(expected.qrAvailable);
		expect(begun.qrUnavailableReason).toBe(
			"qrUnavailableReason" in expected
				? expected.qrUnavailableReason
				: undefined,
		);
		// 已发布的 V1 状态响应保持只含 status。
		expect(
			await (await app.request("/api/v1/agents/agent/wecom-bot")).json(),
		).toEqual({
			status: "not_configured",
		});
	}

	// 非 Owner、跨 Agent 与不存在的 Agent 不可区分，响应里没有扫码能力字段。
	for (const [who, path] of [
		["other", status],
		["owner", "/api/v2/agents/agent-b/wecom-bot"],
		["owner", "/api/v2/agents/missing/wecom-bot"],
	] as const) {
		actor = who;
		for (const app of [withQr, withoutQr]) {
			const denied = await app.request(path);
			expect(denied.status).toBe(404);
			const text = await denied.text();
			expect(text).not.toContain("qrAvailable");
			expect(text).not.toContain("qrUnavailableReason");
		}
	}
	// 调用方提交的身份字段不改变服务端解析的主体。
	actor = "other";
	expect(
		(
			await withQr.request(`${status}?actorId=owner`, {
				headers: { "x-user-id": "owner" },
			})
		).status,
	).toBe(404);
	actor = null;
	expect((await withQr.request(status)).status).toBe(401);
});

it("does not publish the bot status V2 on the application setup routes (#2911)", async () => {
	const setup = createWecomSetupV1({
		authority: async (agentId) => ({
			configuration: { ...agentConfigurationConformanceRecordV1, agentId },
			authorizationRevision: "fixture",
		}),
		store: {
			activeBinding: async () => false,
			create: async () => {},
			read: async () => null,
			consume: async () => false,
			cancel: async () => false,
		},
		encrypt: async () => ({ cipher: true }),
		encryptApplication: async () => ({
			encryptedCredential: {},
			encryptedCallback: {},
		}),
	});
	const app = testApp();
	registerWecomSetupRoutesV1(app, {
		setup,
		identity: {
			resolve: async () => ({
				schemaVersion: 1 as const,
				userId: "owner",
				displayName: "Owner",
				accountStatus: "active" as const,
				organizationIds: [],
				roles: ["employee"],
				authorizationRevision: "fixture",
			}),
			hydrateUsers: async () => [],
		},
		application: true,
		callbackUrl: (id) => `https://example.invalid/callbacks/wecom/${id}`,
	});
	expect((await app.request("/api/v1/agents/agent/wecom-app")).status).toBe(
		200,
	);
	expect((await app.request("/api/v2/agents/agent/wecom-bot")).status).toBe(
		404,
	);
	expect((await app.request("/api/v2/agents/agent/wecom-app")).status).toBe(
		404,
	);
});
