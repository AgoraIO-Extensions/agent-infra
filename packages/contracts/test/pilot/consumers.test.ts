import {
	DelegatedActionRequestV1Schema,
	DelegatedActionResultV1Schema,
	ExecutionGrantClaimsV1Schema,
	validateDelegatedActionResultV1,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

describe("Pilot named consumers", () => {
	it("gives the RuntimeHost client only a bounded, current Execution Grant", () => {
		const claims = {
			schemaVersion: 1,
			issuer: "agent-platform",
			audience: ["runtime_host"],
			issuedAt: "2026-08-28T10:00:00Z",
			expiresAt: "2026-08-28T10:05:00Z",
			grantId: "grant-runtime-1",
			agentId: "agent-1",
			actorId: "user-1",
			channelId: "web",
			conversationId: "conversation-1",
			turnId: "turn-1",
			executionId: "execution-1",
			allowedCommands: ["turn.submit"],
			attachments: [],
			actionSetVersion: "actions-v7",
			actionIds: [],
			traceId: "trace-runtime-1",
		};

		expect(ExecutionGrantClaimsV1Schema.parse(claims)).toEqual(claims);
		expect(
			ExecutionGrantClaimsV1Schema.safeParse({
				...claims,
				connectionId: "caller-selected",
			}).success,
		).toBe(false);
	});

	it("gives a Fake Connection only delegated Action input and a correlated safe result", () => {
		const request = {
			schemaVersion: 1,
			requestId: "request-connection-1",
			idempotencyKey: "tool.call_1",
			grant: {
				schemaVersion: 1,
				format: "compact-jws",
				token: "header.payload.signature",
			},
			action: {
				actionId: "github.issues.read",
				actionVersion: "v3",
				arguments: { issueNumber: 180 },
			},
			traceId: "trace-connection-1",
		};
		const result = {
			schemaVersion: 1,
			requestId: request.requestId,
			idempotencyKey: request.idempotencyKey,
			traceId: request.traceId,
			callId: "call-connection-1",
			status: "succeeded",
			actionId: request.action.actionId,
			actionVersion: request.action.actionVersion,
			completedAt: "2026-08-28T10:00:01Z",
			output: { issueNumber: 180 },
		};

		expect(DelegatedActionRequestV1Schema.parse(request)).toEqual(request);
		expect(DelegatedActionResultV1Schema.parse(result)).toEqual(result);
		expect(validateDelegatedActionResultV1(request, result)).toEqual(result);
		for (const mismatch of [
			{ requestId: "request-other" },
			{ idempotencyKey: "tool.call_other" },
			{ traceId: "trace-other" },
			{ actionId: "github.issues.write" },
			{ actionVersion: "v4" },
		]) {
			expect(() =>
				validateDelegatedActionResultV1(request, { ...result, ...mismatch }),
			).toThrow("Delegated Action result correlation mismatch");
		}
	});
});
