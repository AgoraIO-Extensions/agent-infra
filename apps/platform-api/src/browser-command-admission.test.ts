import { describe, expect, it, vi } from "vitest";
import { createPostgresBrowserCommandAdmissionV1 } from "./browser-command-admission.js";

describe("Platform API Browser command admission", () => {
	it("fails closed for commands outside the handoff admission scope", async () => {
		const authorization = {
			authorize: vi.fn(),
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
				command: {
					schemaVersion: 1,
					command: "confirm_side_effect",
					confirmationId: "confirmation-1",
				},
				idempotencyKey: "browser-command-1",
				requestId: "request-1",
				traceId: "trace-1",
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
