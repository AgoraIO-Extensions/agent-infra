import { describe, expect, it } from "vitest";
import {
	type BrowserHandoffRuntimeSnapshotV1,
	createBrowserHandoffControllerV1,
} from "./browser-handoff.ts";

const capability = {
	capabilityVersion: 1,
	operations: ["handoff"],
	policy: {},
} as never;

const binding = {
	subjectId: "subject-1",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 2,
	resourceFence: 7,
	capabilityVersion: 1,
	pageRevision: 4,
} as const;

const runtime: BrowserHandoffRuntimeSnapshotV1 = {
	browserAlive: true,
	authorized: true,
	subjectId: binding.subjectId,
	agentId: binding.agentId,
	conversationId: binding.conversationId,
	executionId: binding.executionId,
	sessionGeneration: binding.sessionGeneration,
	resourceFence: binding.resourceFence,
	capabilityVersion: binding.capabilityVersion,
	pageRevision: binding.pageRevision,
};

describe("Browser handoff controller", () => {
	it("pauses Agent access, binds takeover to the current subject, and returns safely", () => {
		const controller = createBrowserHandoffControllerV1({
			binding,
			capability,
			now: () => 1_700_000_000_000,
		});

		const requested = controller.request("mfa", runtime);
		expect(requested.status).toBe("requested");
		expect(controller.isAgentPaused()).toBe(true);
		expect(controller.agentObservation()).toEqual({
			status: "paused",
			reasonCode: "BROWSER_HANDOFF_AGENT_OBSERVATION_PAUSED",
		});
		expect(() => controller.assertAgentAccess()).toThrow(
			"BROWSER_HANDOFF_AGENT_PAUSED",
		);
		expect(() =>
			controller.request("mfa", { ...runtime, agentId: "agent-2" }),
		).toThrow("BROWSER_HANDOFF_IDENTITY_BINDING_STALE");
		expect(controller.request("mfa", runtime).handoffId).toBe(
			requested.handoffId,
		);
		expect(() =>
			controller.takeOver({
				handoffId: requested.handoffId,
				operatorId: "subject-2",
				subjectId: "subject-2",
				runtime,
			}),
		).toThrow("BROWSER_HANDOFF_OPERATOR_DENIED");

		const active = controller.takeOver({
			handoffId: requested.handoffId,
			operatorId: "subject-1",
			subjectId: "subject-1",
			runtime,
		});
		expect(active.status).toBe("active");
		const completed = controller.returnToAgent({
			handoffId: active.handoffId,
			operatorId: "subject-1",
			runtime,
		});
		expect(completed.status).toBe("completed");
		expect(controller.isAgentPaused()).toBe(false);
		expect(controller.agentObservation()).toEqual({ status: "available" });
	});

	it("turns stale return, expiry, and browser crash into non-runnable terminal states", () => {
		let now = 1_700_000_000_000;
		const controller = createBrowserHandoffControllerV1({
			binding,
			capability,
			now: () => now,
			timeoutMs: 1_000,
		});
		const requested = controller.request("login", runtime);
		now += 1_001;
		expect(controller.snapshot()).toMatchObject({
			status: "expired",
			terminalReason: "BROWSER_HANDOFF_EXPIRED",
		});
		expect(() =>
			controller.takeOver({
				handoffId: requested.handoffId,
				operatorId: "subject-1",
				subjectId: "subject-1",
				runtime,
			}),
		).toThrow("BROWSER_HANDOFF_NOT_REQUESTED");

		now = 1_700_000_000_000;
		const stale = createBrowserHandoffControllerV1({
			binding,
			capability,
			now: () => now,
		});
		const staleRequest = stale.request("captcha", runtime);
		stale.takeOver({
			handoffId: staleRequest.handoffId,
			operatorId: "subject-1",
			subjectId: "subject-1",
			runtime,
		});
		expect(() =>
			stale.returnToAgent({
				handoffId: staleRequest.handoffId,
				operatorId: "subject-1",
				runtime: { ...runtime, pageRevision: runtime.pageRevision + 1 },
			}),
		).toThrow("BROWSER_HANDOFF_PAGE_REVISION_STALE");
		expect(stale.snapshot()).toMatchObject({ status: "unknown" });
		expect(() => stale.assertAgentAccess()).toThrow(
			"BROWSER_HANDOFF_PAGE_REVISION_STALE",
		);

		const crashed = createBrowserHandoffControllerV1({
			binding,
			capability,
			now: () => now,
		});
		const crashedRequest = crashed.request("human_judgment", runtime);
		crashed.takeOver({
			handoffId: crashedRequest.handoffId,
			operatorId: "subject-1",
			subjectId: "subject-1",
			runtime,
		});
		expect(crashed.markBrowserCrashed()).toMatchObject({ status: "crashed" });
		expect(crashed.agentObservation()).toMatchObject({
			status: "blocked",
			reasonCode: "BROWSER_HANDOFF_BROWSER_CRASHED",
		});
		expect(() => crashed.assertAgentAccess()).toThrow(
			"BROWSER_HANDOFF_BROWSER_CRASHED",
		);
	});
});
