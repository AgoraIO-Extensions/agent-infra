import { describe, expect, it } from "vitest";

import {
	DelegatedActionRequestV1Schema,
	DelegatedActionResultV1Schema,
	ExecutionGrantClaimsV1Schema,
} from "../../src/pilot/delegated.js";

const validClaims = {
	schemaVersion: 1,
	issuer: "agent-platform",
	audience: ["platform_tool_gateway", "connection_api"],
	issuedAt: "2026-08-28T10:00:00Z",
	expiresAt: "2026-08-28T10:05:00Z",
	grantId: "grant-1",
	agentId: "agent-1",
	actorId: "user-1",
	channelId: "web",
	conversationId: "conversation-1",
	turnId: "turn-1",
	executionId: "execution-1",
	allowedCommands: ["tool.invoke"],
	attachments: [{ attachmentId: "attachment-1", operations: ["read"] }],
	actionSetVersion: "actions-v7",
	actionIds: ["github.issues.read"],
	traceId: "trace-1",
} as const;

const validRequest = {
	schemaVersion: 1,
	requestId: "request-1",
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
	traceId: "trace-1",
} as const;

describe("Pilot delegated contracts", () => {
	it("binds every approved Execution Grant authorization dimension", () => {
		expect(ExecutionGrantClaimsV1Schema.parse(validClaims)).toEqual(
			validClaims,
		);
		for (const requiredField of [
			"issuer",
			"audience",
			"expiresAt",
			"grantId",
			"agentId",
			"actorId",
			"conversationId",
			"executionId",
			"actionSetVersion",
			"traceId",
		] as const) {
			const incomplete = { ...validClaims } as Record<string, unknown>;
			delete incomplete[requiredField];
			expect(ExecutionGrantClaimsV1Schema.safeParse(incomplete).success).toBe(
				false,
			);
		}
	});

	it("accepts only versioned delegated requests without caller-selected identity or Connection", () => {
		expect(DelegatedActionRequestV1Schema.parse(validRequest)).toEqual(
			validRequest,
		);
		for (const injected of [
			{ actorId: "caller-controlled" },
			{ connectionId: "another-users-connection" },
			{ externalAccountId: "another-users-account" },
		]) {
			expect(
				DelegatedActionRequestV1Schema.safeParse({
					...validRequest,
					...injected,
				}).success,
			).toBe(false);
		}
		expect(
			DelegatedActionRequestV1Schema.safeParse({
				...validRequest,
				schemaVersion: 2,
			}).success,
		).toBe(false);
	});

	it("accepts safe results and rejects secret-bearing responses at any depth", () => {
		const safeResult = {
			schemaVersion: 1,
			requestId: "request-1",
			callId: "call-1",
			status: "succeeded",
			actionId: "github.issues.read",
			actionVersion: "v3",
			traceId: "trace-1",
			completedAt: "2026-08-28T10:00:01Z",
			output: { issue: { number: 180, title: "Pilot contracts" } },
		};
		expect(DelegatedActionResultV1Schema.parse(safeResult)).toEqual(safeResult);
		expect(
			DelegatedActionResultV1Schema.safeParse({
				...safeResult,
				output: { issue: { accessToken: "must-not-leave-connection" } },
			}).success,
		).toBe(false);
		expect(
			DelegatedActionResultV1Schema.safeParse({
				...safeResult,
				output: { nested: { secretPlaintext: "must-not-leave-connection" } },
			}).success,
		).toBe(false);
	});
});
