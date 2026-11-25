import { expect, it } from "vitest";
import { planConnectionConsumerRegistrationV1 } from "./connection-consumer-registration.js";
import { createConnectionRegistrationOwnerReaderV1 } from "./connection-registration-owner.js";

it("rechecks current persisted ownership after identity lookup without provisioning", async () => {
	const policy = {
		schemaVersion: 1 as const,
		sourceNamespace: "source-a",
		revision: "policy-1",
		callbackUrl: "https://platform.example.test/callback",
		resource: "https://connection.example.test/mcp",
		scope: "mcp",
	};
	const intent = planConnectionConsumerRegistrationV1({
		policy,
		platformAgentId: "agent-a",
		platformOwnerId: "owner-a",
		consumerName: "Agent",
	});
	let current = true;
	const read = createConnectionRegistrationOwnerReaderV1({
		policy,
		directorySource: "enterprise-tools",
		readFacts: async () => ({
			intent,
			ownerId: "owner-a",
			ownerCurrent: current,
			agentStatus: "available",
			revision: "1",
			sent: true,
		}),
		readIdentity: async () => ({
			userId: "owner-a",
			accountStatus: "active",
			wechatUserId: "wechat-a",
			email: "a@example.test",
			revision: "identity-1",
			expiresAt: Date.now() + 30_000,
		}),
	});
	const signal = AbortSignal.timeout(5000);
	expect(await read("source-a", "agent-a", "create", signal)).toMatchObject({
		platformOwnerId: "owner-a",
		wechatUserId: "wechat-a",
	});
	expect(await read("foreign", "agent-a", "read", signal)).toBeUndefined();
	const race = createConnectionRegistrationOwnerReaderV1({
		policy,
		directorySource: "enterprise-tools",
		readFacts: async () => ({
			intent,
			ownerId: "owner-a",
			ownerCurrent: current,
			agentStatus: "available",
			revision: "1",
			sent: true,
		}),
		readIdentity: async () => {
			current = false;
			return {
				userId: "owner-a",
				accountStatus: "active",
				wechatUserId: "wechat-a",
				email: "a@example.test",
				revision: "identity-1",
				expiresAt: Date.now() + 30_000,
			};
		},
	});
	expect(await race("source-a", "agent-a", "create", signal)).toBeUndefined();
});
