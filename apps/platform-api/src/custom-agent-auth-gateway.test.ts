import { generateKeyPairSync } from "node:crypto";

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
	createCustomAgentAuthGatewayRouteAdapterV1,
	createCustomAgentAuthGatewayV1,
	registerCustomAgentAuthGatewayRoutesV1,
} from "./custom-agent-auth-gateway.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user_01",
	displayName: "Employee",
	accountStatus: "active" as const,
	organizationIds: ["org_01"],
	roles: ["employee" as const],
	authorizationRevision: "authrev_01",
};

describe("custom Agent platform identity gateway", () => {
	it("overwrites browser identity headers before forwarding", async () => {
		const keys = generateKeyPairSync("ed25519");
		let forwarded: Request | undefined;
		const gateway = createCustomAgentAuthGatewayV1({
			resolveIdentity: async () => identity,
			authorizeAgent: async () => true,
			resolveServiceOrigin: async () => "https://agent.internal.test",
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
			now: () => 1_700_000_000_000,
			id: () => "ctx_01",
			forward: async (request) => {
				forwarded = request;
				return new Response("ok");
			},
		});
		const response = await gateway({
			request: new Request("https://platform.test/chat?view=1", {
				method: "POST",
				headers: {
					"content-type": "text/plain",
					authorization: "Bearer forged",
					cookie: "platform=session",
					"x-user-id": "forged-user",
					"x-agent-infra-platform-context": "forged-context",
					host: "forged.example.test",
					"x-forwarded-host": "forged.example.test",
				},
				body: "hello",
			}),
			agentId: "agent_01",
		});
		expect(response.status).toBe(200);
		expect(forwarded?.url).toBe("https://agent.internal.test/chat?view=1");
		expect(forwarded?.headers.get("authorization")).toBeNull();
		expect(forwarded?.headers.get("cookie")).toBeNull();
		expect(forwarded?.headers.get("x-user-id")).toBeNull();
		expect(forwarded?.headers.get("host")).toBeNull();
		expect(forwarded?.headers.get("x-forwarded-host")).toBeNull();
		expect(forwarded?.headers.get("x-agent-infra-platform-context")).toMatch(
			/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
		);
		expect(await forwarded?.text()).toBe("hello");
	});

	it("fails closed for unauthorized identity, unsafe origin and unavailable auth", async () => {
		const keys = generateKeyPairSync("ed25519");
		const authorizeAgent = vi.fn(async () => false);
		const gateway = createCustomAgentAuthGatewayV1({
			resolveIdentity: async () => identity,
			authorizeAgent,
			resolveServiceOrigin: async () => "https://agent.test",
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
		});
		const input = {
			request: new Request("https://platform.test/chat"),
			agentId: "agent_01",
		};
		expect((await gateway(input)).status).toBe(403);
		expect(authorizeAgent).toHaveBeenCalledWith({
			identity,
			agentId: "agent_01",
		});
		const allow = createCustomAgentAuthGatewayV1({
			resolveIdentity: async () => identity,
			authorizeAgent: async () => true,
			resolveServiceOrigin: async () => "http://agent.test",
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
		});
		expect((await allow(input)).status).toBe(503);
	});

	it("uses only the deployment resolver binding in the Hono adapter", async () => {
		const keys = generateKeyPairSync("ed25519");
		const resolve = vi.fn(async (request: Request) => {
			expect(new URL(request.url).pathname).toBe("/entry/browser-agent");
			return {
				agentId: "agent_trusted",
				serviceOrigin: "https://agent.internal.test",
			};
		});
		const authorize = vi.fn(async ({ agentId }: { agentId: string }) => {
			expect(agentId).toBe("agent_trusted");
			return true;
		});
		let forwarded: Request | undefined;
		const app = new Hono();
		registerCustomAgentAuthGatewayRoutesV1(app, {
			path: "/entry/*",
			identity: {
				resolve: async () => identity,
				hydrateUsers: async () => [],
			},
			resolveDeployment: resolve,
			authorizeAgent: authorize,
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
			forward: async (request) => {
				forwarded = request;
				return new Response("ok");
			},
		});

		const response = await app.request(
			"https://platform.test/entry/browser-agent",
			{
				method: "POST",
				headers: {
					"x-agent-id": "forged",
					origin: "https://forged.example.test",
				},
				body: "hello",
			},
		);
		expect(response.status).toBe(200);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(forwarded?.url).toBe(
			"https://agent.internal.test/entry/browser-agent",
		);
		expect(forwarded?.headers.get("x-agent-id")).toBeNull();
		expect(forwarded?.headers.get("origin")).toBeNull();
		expect(await forwarded?.text()).toBe("hello");
	});

	it("fails closed when deployment or current identity is unavailable", async () => {
		const keys = generateKeyPairSync("ed25519");
		const forward = vi.fn(async () => new Response("unexpected"));
		const noDeployment = createCustomAgentAuthGatewayRouteAdapterV1({
			identity: {
				resolve: async () => identity,
				hydrateUsers: async () => [],
			},
			resolveDeployment: async () => null,
			authorizeAgent: async () => true,
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
			forward,
		});
		expect(
			(await noDeployment(new Request("https://platform.test/entry/agent")))
				.status,
		).toBe(503);
		expect(forward).not.toHaveBeenCalled();

		const identityUnavailable = createCustomAgentAuthGatewayRouteAdapterV1({
			identity: {
				resolve: async () => {
					throw new Error("identity unavailable");
				},
				hydrateUsers: async () => [],
			},
			resolveDeployment: async () => ({
				agentId: "agent_trusted",
				serviceOrigin: "https://agent.internal.test",
			}),
			authorizeAgent: async () => true,
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
			forward,
		});
		expect(
			(
				await identityUnavailable(
					new Request("https://platform.test/entry/agent"),
				)
			).status,
		).toBe(503);
		expect(forward).not.toHaveBeenCalled();
	});
});
