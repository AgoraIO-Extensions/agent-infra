import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createCustomAgentAuthGatewayV1 } from "./custom-agent-auth-gateway.js";

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
				},
				body: "hello",
			}),
			agentId: "agent_01",
			serviceOrigin: "https://agent.internal.test",
		});
		expect(response.status).toBe(200);
		expect(forwarded?.url).toBe("https://agent.internal.test/chat?view=1");
		expect(forwarded?.headers.get("authorization")).toBeNull();
		expect(forwarded?.headers.get("cookie")).toBeNull();
		expect(forwarded?.headers.get("x-user-id")).toBeNull();
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
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
		});
		const input = {
			request: new Request("https://platform.test/chat"),
			agentId: "agent_01",
		};
		expect(
			(await gateway({ ...input, serviceOrigin: "https://agent.test" })).status,
		).toBe(403);
		expect(authorizeAgent).toHaveBeenCalledWith({
			identity,
			agentId: "agent_01",
		});
		const allow = createCustomAgentAuthGatewayV1({
			resolveIdentity: async () => identity,
			authorizeAgent: async () => true,
			issuer: "platform_01",
			keyVersion: "key_01",
			privateKey: keys.privateKey,
		});
		expect(
			(await allow({ ...input, serviceOrigin: "http://agent.test" })).status,
		).toBe(503);
	});
});
