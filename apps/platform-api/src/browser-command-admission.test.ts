import { describe, expect, it, vi } from "vitest";
import { createPostgresBrowserCommandAdmissionV1 } from "./browser-command-admission.js";

describe("Platform API Browser command admission", () => {
	it.each([
		["pause", { schemaVersion: 1, command: "pause", handoffId: "handoff-1" }],
		[
			"confirm_side_effect",
			{
				schemaVersion: 1,
				command: "confirm_side_effect",
				confirmationId: "confirmation-1",
			},
		],
		[
			"reject_side_effect",
			{
				schemaVersion: 1,
				command: "reject_side_effect",
				confirmationId: "confirmation-1",
			},
		],
		[
			"cancel_side_effect",
			{
				schemaVersion: 1,
				command: "cancel_side_effect",
				confirmationId: "confirmation-1",
			},
		],
	] as const)(
		"passes %s through the admission port",
		async (_name, command) => {
			const authorization = {
				authorize: vi.fn().mockResolvedValue({
					outcome: "allowed" as const,
					authority: {
						schemaVersion: 1 as const,
						actorId: "user-1",
						agentId: "agent-1",
						channelId: "web",
						authorizationRevision: "auth-1",
						supportsSupplementaryInstruction: true,
					},
				}),
			};
			const bridge = createPostgresBrowserCommandAdmissionV1({
				databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/invalid",
				authorization,
			});
			await expect(
				bridge.invoke({
					identity: {
						schemaVersion: 1,
						userId: "user-1",
						displayName: "Ada",
						accountStatus: "active",
						organizationIds: [],
						roles: ["employee"],
						authorizationRevision: "identity-1",
					},
					conversationId: "conversation-1",
					command,
					idempotencyKey: "browser-command-1",
					requestId: "request-1",
					traceId: "trace-1",
					signal: new AbortController().signal,
				}),
			).resolves.toEqual({
				outcome: "unavailable",
				conversationId: "conversation-1",
			});
			expect(authorization.authorize).toHaveBeenCalledOnce();
			await bridge.store.close();
		},
	);

	it("rejects mixed identity fields instead of normalizing them", async () => {
		const authorization = { authorize: vi.fn() };
		const bridge = createPostgresBrowserCommandAdmissionV1({
			databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/invalid",
			authorization,
		});
		await expect(
			bridge.invoke({
				identity: {
					schemaVersion: 1,
					userId: "user-1",
					displayName: "Ada",
					accountStatus: "active",
					organizationIds: [],
					roles: ["employee"],
					authorizationRevision: "identity-1",
				},
				conversationId: "conversation-1",
				command: {
					schemaVersion: 1,
					command: "confirm_side_effect",
					confirmationId: "confirmation-1",
					handoffId: "foreign-handoff",
				} as unknown as import("@agent-infra/contracts/pilot").BrowserCommandRequestV1,
				idempotencyKey: "browser-command-foreign-field",
				requestId: "request-foreign-field",
				traceId: "trace-foreign-field",
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({
			outcome: "unavailable",
			conversationId: "conversation-1",
		});
		expect(authorization.authorize).not.toHaveBeenCalled();
		await bridge.store.close();
	});
});
