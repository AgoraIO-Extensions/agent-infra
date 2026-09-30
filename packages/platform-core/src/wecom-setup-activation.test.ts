import { expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "./agent-configuration.conformance.js";
import type { AgentConfigurationWritePlanV1 } from "./agent-configuration.js";
import type { WecomSetupRecordV1 } from "./wecom-setup.js";
import { createWecomSetupActivationV1 } from "./wecom-setup-activation.js";

it("admits a current Owner and replaces only the bot binding after verification", async () => {
	const configuration = {
		...agentConfigurationConformanceRecordV1,
		channels: [
			{ kind: "wecom_app" as const, bindingReference: "app-binding" },
			{ kind: "wecom_bot" as const, bindingReference: "old-bot" },
		],
	};
	const session: WecomSetupRecordV1 = {
		sessionId: "setup-01",
		agentId: configuration.agentId,
		actorId: "owner-01",
		configurationRevision: configuration.revision,
		authorizationRevision: "authorization-01",
		stateDigest: "digest",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		status: "verifying",
		botId: "bot-01",
		encryptedCredential: null,
	};
	let active = true;
	let revision = configuration.revision;
	let captured: AgentConfigurationWritePlanV1 | undefined;
	const activation = createWecomSetupActivationV1({
		readCurrentUser: async () => ({
			accountStatus: active ? "active" : "disabled",
			organizationIds: [],
		}),
		readAuthority: async () => ({
			configuration: { ...configuration, revision },
			authorizationRevision: session.authorizationRevision,
		}),
		transaction: {
			async read() {
				return {
					outcome: "ready" as const,
					record: {
						schemaVersion: 1 as const,
						configuration,
						authorizationRevision: session.authorizationRevision,
					},
				};
			},
			async commit(plan) {
				captured = plan;
				return { outcome: "committed" as const, result: plan.result };
			},
		},
	});
	active = false;
	expect(await activation.authority(session)).toBeNull();
	active = true;
	revision++;
	expect(await activation.authority(session)).toBeNull();
	revision = configuration.revision;
	expect(await activation.authority(session)).not.toBeNull();
	await activation.activate(session);
	expect(captured?.configuration.channels).toEqual([
		{ kind: "wecom_app", bindingReference: "app-binding" },
		{ kind: "wecom_bot", bindingReference: session.sessionId },
	]);
	expect(captured?.configuration.channelRevision).toBe(session.sessionId);
	const application = {
		...session,
		kind: "wecom_app" as const,
		sessionId: "setup-app",
	};
	await activation.activate(application);
	expect(captured?.configuration.channels).toEqual([
		{ kind: "wecom_app", bindingReference: application.sessionId },
		{ kind: "wecom_bot", bindingReference: "old-bot" },
	]);
});
