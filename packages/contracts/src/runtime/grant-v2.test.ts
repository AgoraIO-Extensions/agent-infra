import { describe, expect, it } from "vitest";
import {
	RuntimeBusinessGrantClaimsV2Schema,
	RuntimeControlGrantClaimsV2Schema,
	validateVerifiedRuntimeExecutionGrantClaimsV2,
} from "./grant-v2.ts";
import {
	RuntimeStatusRequestV3Schema,
	RuntimeStatusResponseV3Schema,
} from "./host-v3.ts";

const common = {
	schemaVersion: 2,
	issuer: "issuer",
	audience: "runtime_host",
	workerId: "worker",
	issuedAt: 1000,
	expiresAt: 31000,
	grantId: "grant",
	principal: { kind: "user", id: "actor" },
	agentId: "agent",
	channelId: "web",
	conversationId: "conversation",
	executionId: "execution",
	turnId: "turn",
	sessionGeneration: 1,
	traceId: "trace",
	hostSessionRef: null,
	operation: {
		kind: "execution",
		id: "execution",
		deliveryFence: 1,
		executionDeliveryFence: 1,
	},
	requestDigest: "a".repeat(64),
};

describe("Runtime purpose separation", () => {
	it("requires an original mapping and a precise recovery failure without invented terminal status", () => {
		const response = {
			schemaVersion: 3,
			hostSessionRef: "original-host-session",
			executionId: "original-execution",
			outcome: "recovery_failed",
			code: "RUNTIME_SESSION_RECOVERY_FAILED",
		};
		expect(RuntimeStatusResponseV3Schema.safeParse(response).success).toBe(
			true,
		);
		for (const invalid of [
			{ hostSessionRef: null },
			{ hostSessionRef: "" },
			{ executionId: "" },
			{ code: "RUNTIME_CODEX_UNAVAILABLE" },
			{ status: "failed" },
			{ message: "private diagnostic" },
		]) {
			expect(
				RuntimeStatusResponseV3Schema.safeParse({ ...response, ...invalid })
					.success,
			).toBe(false);
		}
	});

	it("control cannot authorize business commands or carry business payload/credentials", () => {
		const control = {
			...common,
			purpose: "control",
			controlRecordId: "control",
			reason: "recovery",
			allowedCommands: ["session.status"],
		};
		expect(RuntimeControlGrantClaimsV2Schema.safeParse(control).success).toBe(
			true,
		);
		for (const command of [
			"turn.submit",
			"turn.supplement",
			"execution.renew",
			"tool.invoke",
		])
			expect(
				RuntimeControlGrantClaimsV2Schema.safeParse({
					...control,
					allowedCommands: [command],
				}).success,
			).toBe(false);
		for (const field of [
			"attachments",
			"input",
			"selection",
			"actionIds",
			"actionSetVersion",
			"authorizationRecordId",
			"connectionId",
		])
			expect(
				RuntimeControlGrantClaimsV2Schema.safeParse({ ...control, [field]: [] })
					.success,
			).toBe(false);
	});
	it("binds destructive control commands to their persisted reason", () => {
		const control = {
			...common,
			purpose: "control" as const,
			controlRecordId: "control",
			reason: "recovery" as const,
			allowedCommands: ["session.status" as const],
		};
		const context = {
			expectedIssuer: common.issuer,
			expectedWorkerId: common.workerId,
			now: 2_000,
		};
		expect(
			validateVerifiedRuntimeExecutionGrantClaimsV2(control, context),
		).toEqual(control);
		for (const invalid of [
			{ allowedCommands: ["turn.stop" as const], reason: "recovery" as const },
			{
				allowedCommands: ["turn.stop" as const],
				reason: "generation_isolation" as const,
			},
			{
				allowedCommands: ["generation.cancel" as const],
				reason: "recovery" as const,
			},
		]) {
			expect(() =>
				validateVerifiedRuntimeExecutionGrantClaimsV2(
					{ ...control, ...invalid },
					context,
				),
			).toThrow("Runtime Execution Grant claims are inconsistent");
		}
		for (const valid of [
			{ allowedCommands: ["turn.stop" as const], reason: "stop" as const },
			{
				allowedCommands: ["turn.stop" as const],
				reason: "authorization_revoked" as const,
			},
			{
				allowedCommands: ["generation.cancel" as const],
				reason: "generation_isolation" as const,
			},
		]) {
			expect(
				validateVerifiedRuntimeExecutionGrantClaimsV2(
					{ ...control, ...valid },
					context,
				),
			).toMatchObject(valid);
		}
	});
	it("grants authorize exactly one audience and command", () => {
		const business = {
			...common,
			purpose: "business",
			authorizationRecordId: "authorization",
			allowedCommands: ["turn.submit"],
			attachments: [],
		};
		expect(RuntimeBusinessGrantClaimsV2Schema.safeParse(business).success).toBe(
			true,
		);
		expect(
			RuntimeBusinessGrantClaimsV2Schema.safeParse({
				...business,
				allowedCommands: ["turn.submit", "events.persist"],
			}).success,
		).toBe(false);
		expect(
			RuntimeBusinessGrantClaimsV2Schema.safeParse({
				...business,
				audience: ["runtime_host", "connection_api"],
			}).success,
		).toBe(false);
	});
	it("recovery has no input/selection surface and preserves an absent Host reference", () => {
		const {
			issuer: _issuer,
			audience: _audience,
			workerId: _worker,
			issuedAt: _issued,
			expiresAt: _expires,
			grantId: _id,
			requestDigest: _digest,
			...binding
		} = common;
		const request = {
			...binding,
			schemaVersion: 3,
			requestId: "request",
			originalOperationDigest: "b".repeat(43),
			grant: {
				schemaVersion: 2,
				format: "runtime-execution-jws",
				token: "a.b.c",
			},
		};
		expect(RuntimeStatusRequestV3Schema.safeParse(request).success).toBe(true);
		for (const field of ["input", "selection", "recovery", "actorId"])
			expect(
				RuntimeStatusRequestV3Schema.safeParse({ ...request, [field]: {} })
					.success,
			).toBe(false);
	});
});
