import { describe, expect, it } from "vitest";
import { createAgentApiLifecycleV1 } from "./agent-api-lifecycle.js";
import type { AgentManagementStateV1 } from "./agent-management.js";

const state: AgentManagementStateV1 = {
	schemaVersion: 1,
	applicationId: "application",
	agentId: "agent",
	applicantId: "human-owner",
	status: "stopped",
	revision: 3,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: null,
	desiredState: "stopped",
	workloadRevision: 2,
	fence: 2,
	ownerIds: ["human-owner"],
	availability: [],
	failureCode: null,
};
const command = {
	schemaVersion: 1 as const,
	agentId: "agent",
	command: "start" as const,
	idempotencyKey: "start-1",
	requestId: "request",
	traceId: "trace",
};

describe("Agent API lifecycle", () => {
	it.each(["start", "restart"] as const)(
		"cannot %s an administrator-disabled Agent",
		async (operation) => {
			const api = createAgentApiLifecycleV1({
				async executeAgentApiLifecycleTransaction(request, decide) {
					return decide(
						{ ...state, status: "disabled" },
						{
							principal: { kind: "application", id: "app" },
							agentId: request.command.agentId,
							manageGrantRevision: "manage-1",
						},
					);
				},
			});
			expect(
				await api.execute(
					{ ...command, command: operation },
					"transient-material",
				),
			).toEqual({
				outcome: "conflict",
				reason: "invalid_transition",
				writePlan: null,
			});
		},
	);
	it("rejects an authority for another Agent", async () => {
		const api = createAgentApiLifecycleV1({
			async executeAgentApiLifecycleTransaction(_request, decide) {
				return decide(state, {
					principal: { kind: "application", id: "app" },
					agentId: "foreign-agent",
					manageGrantRevision: "manage-1",
				});
			},
		});
		await expect(
			api.execute(command, "transient-material"),
		).rejects.toMatchObject({ code: "unavailable" });
	});
	it("rejects caller identity fields before entering the transaction", async () => {
		let entered = false;
		const api = createAgentApiLifecycleV1({
			async executeAgentApiLifecycleTransaction() {
				entered = true;
				return { outcome: "denied", writePlan: null };
			},
		});
		await expect(
			api.execute(
				{
					...command,
					principal: { kind: "application", id: "caller-supplied" },
				},
				"transient-material",
			),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(entered).toBe(false);
	});
	it("starts a stopped Agent for an explicitly authorized application without inheriting its human Owner", async () => {
		const api = createAgentApiLifecycleV1({
			async executeAgentApiLifecycleTransaction(request, decide) {
				return decide(state, {
					principal: { kind: "application", id: "app-caller" },
					agentId: request.command.agentId,
					manageGrantRevision: "manage-1",
				});
			},
		});
		const result = await api.execute(command, "transient-material");
		expect(result.outcome).toBe("accepted");
		if (result.outcome !== "accepted") throw new Error("Expected acceptance");
		expect(result.result.status).toBe("available");
		expect(result.writePlan.state.ownerIds).toEqual(["human-owner"]);
		expect(result.writePlan.auditEvent).toMatchObject({
			actorType: "application",
			actorId: "app-caller",
		});
		expect(result.writePlan.outboxIntent?.payload).toMatchObject({
			desiredState: "running",
			fence: 3,
			workloadRevision: 3,
		});
		expect(JSON.stringify(result)).not.toContain("transient-material");
	});
});
