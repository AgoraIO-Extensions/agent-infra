import { describe, expect, it } from "vitest";
import { decodePlatformAuditRowV1 } from "./audit.js";

const row = {
	auditId: "controlled-audit",
	traceId: "controlled-trace",
	actorType: "application",
	actorId: "robot",
	action: "agent.lifecycle.restarted",
	targetType: "agent",
	targetId: "agent",
	outcome: "succeeded" as const,
	occurredAt: new Date("2026-10-07T00:00:00Z"),
	details: null,
};

describe("Agent API facts in the existing audit decoder", () => {
	it("keeps the application lifecycle actor distinct from a user", () => {
		expect(decodePlatformAuditRowV1(row).actor).toEqual({
			kind: "application",
			actorId: "robot",
		});
	});
	it("does not broaden administrator-only disable to application actors", () => {
		expect(() =>
			decodePlatformAuditRowV1({ ...row, action: "agent.lifecycle.disabled" }),
		).toThrow();
	});
	it("accepts truly unknown refusals without inventing an actor or target", () => {
		const event = decodePlatformAuditRowV1({
			...row,
			actorType: "unknown",
			actorId: "unknown",
			action: "api.agent.lifecycle.refused",
			targetType: "unknown",
			targetId: "unknown",
			outcome: "rejected",
			details: { reason: "authentication_required" },
		});
		expect(event.actor).toEqual({ kind: "unknown", actorId: "unknown" });
		expect(event.subject).toEqual({ kind: "unknown", subjectId: "unknown" });
	});
	it("rejects arbitrary details instead of exposing them in audit summaries", () => {
		expect(() =>
			decodePlatformAuditRowV1({
				...row,
				action: "api.agent.lifecycle.refused",
				outcome: "rejected",
				details: {
					reason: "conflict",
					command: "start",
					credentialValue: "controlled-private-sentinel",
				},
			}),
		).toThrow();
	});
	it("accepts only truthful use grant details and bounded refusal commands", () => {
		const event = {
			...row,
			actorType: "user",
			actorId: "owner",
			action: "api.agent.use.granted",
			details: {
				applicationId: "robot",
				grantType: "use",
				granted: true,
				authorizationRevision: "use-1",
			},
		};
		expect(decodePlatformAuditRowV1(event).action).toBe(
			"api.agent.use.granted",
		);
		expect(() =>
			decodePlatformAuditRowV1({
				...event,
				details: { ...event.details, grantType: "manage" },
			}),
		).toThrow();
		expect(() =>
			decodePlatformAuditRowV1({ ...event, actorType: "application" }),
		).toThrow();
		expect(
			decodePlatformAuditRowV1({
				...event,
				action: "api.agent.use.refused",
				outcome: "rejected",
				details: { reason: "forbidden", command: "grant_use" },
			}).action,
		).toBe("api.agent.use.refused");
		expect(() =>
			decodePlatformAuditRowV1({
				...event,
				action: "api.agent.use.refused",
				outcome: "rejected",
				details: { reason: "forbidden", command: "grant_manager" },
			}),
		).toThrow();
	});
	it("decodes existing Task API facts through their original bounded Core contract", () => {
		const access = {
			...row,
			requestId: "controlled-request",
			action: "task.api.access",
			outcome: "rejected" as const,
			details: {
				schemaVersion: 1,
				operation: "submit",
				phase: "access",
				reason: "resource_unavailable",
				target: { kind: "agent", agentId: "agent" },
			},
		};
		expect(decodePlatformAuditRowV1(access)).toMatchObject({
			actor: { kind: "application", actorId: "robot" },
			subject: { kind: "agent", subjectId: "agent" },
			result: "failed",
			summary: "operation=submit; phase=access; reason=resource_unavailable",
		});
		for (const bad of [
			{
				...access,
				details: { ...access.details, credentialValue: "controlled-private" },
			},
			{ ...access, targetId: "other-agent" },
			{ ...access, actorType: "system" },
			{ ...access, requestId: undefined },
			{ ...access, action: "task.api.subscription.started" },
		])
			expect(() => decodePlatformAuditRowV1(bad)).toThrow();
	});
	it("rejects self-authored unknown attribution and unrelated actors", () => {
		expect(() =>
			decodePlatformAuditRowV1({
				...row,
				actorType: "unknown",
				actorId: "invented",
				action: "api.agent.lifecycle.refused",
				outcome: "rejected",
				details: { reason: "conflict" },
			}),
		).toThrow();
		expect(() =>
			decodePlatformAuditRowV1({
				...row,
				actorType: "system",
				action: "api.agent.state.read",
			}),
		).toThrow();
	});
});
