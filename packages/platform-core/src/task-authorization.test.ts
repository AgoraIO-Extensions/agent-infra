import { describe, expect, it } from "vitest";
import type { AgentManagementStateV1 } from "./agent-management.js";
import {
	type CurrentTaskUserV1,
	captureTaskAuthorizationBoundaryV1,
	isTaskAuthorizationCurrentV1,
	parseCurrentTaskUserV1,
	parseTaskAuthorizationBoundaryV1,
	planTaskSystemControlV1,
} from "./task-authorization.js";

const user: CurrentTaskUserV1 = {
	schemaVersion: 1,
	userId: "user-a",
	accountStatus: "active",
	organizationIds: ["team-a"],
	authorizationRevision: "directory-7",
};
const agent: AgentManagementStateV1 = {
	schemaVersion: 1,
	applicationId: "application-a",
	agentId: "agent-a",
	applicantId: "owner-a",
	status: "available",
	revision: 3,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: "ready",
	desiredState: "running",
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["owner-a"],
	availability: [{ kind: "organization", organizationId: "team-a" }],
	failureCode: null,
};

function capture(
	overrides: Partial<
		Parameters<typeof captureTaskAuthorizationBoundaryV1>[0]
	> = {},
) {
	return captureTaskAuthorizationBoundaryV1({
		principal: { kind: "user", id: user.userId },
		user,
		agent,
		channelId: "web",
		agentAuthorizationRevision: "agent-access-4",
		...overrides,
	});
}

function requiredBoundary(overrides: Parameters<typeof capture>[0] = {}) {
	const boundary = capture(overrides);
	if (!boundary) throw new Error("Expected an admitted task boundary");
	return boundary;
}

describe("task authorization boundary", () => {
	it("keeps directory and Agent revisions distinct while accepting current unchanged scope", () => {
		const boundary = requiredBoundary();
		expect(boundary).toMatchObject({
			identityRevision: "directory-7",
			agentAuthorizationRevision: "agent-access-4",
			accessSources: [{ kind: "organization", organizationId: "team-a" }],
		});
		expect(
			isTaskAuthorizationCurrentV1({
				boundary,
				user: { ...user, authorizationRevision: "directory-8" },
				agent,
			}),
		).toBe(true);
		expect(boundary?.identityRevision).toBe("directory-7");
	});

	it("rejects application principals until the #481 grant slice supplies them", () => {
		expect(() =>
			parseTaskAuthorizationBoundaryV1({
				...requiredBoundary(),
				principal: { kind: "application", id: user.userId },
			}),
		).toThrow("Task principal is invalid");
	});

	it.each([
		[
			"disabled account",
			{ ...user, accountStatus: "disabled" as const },
			agent,
		],
		["organization exit", { ...user, organizationIds: [] }, agent],
		["another subject", { ...user, userId: "user-b" }, agent],
		["another Agent", user, { ...agent, agentId: "agent-b" }],
		["revoked use scope", user, { ...agent, availability: [] }],
		[
			"owner inspecting another submitter",
			{ ...user, userId: "owner-a" },
			agent,
		],
	] as const)(
		"rejects %s on the original task",
		(_name, currentUser, currentAgent) => {
			expect(
				isTaskAuthorizationCurrentV1({
					boundary: requiredBoundary(),
					user: currentUser,
					agent: currentAgent,
				}),
			).toBe(false);
		},
	);

	it("does not expand an old task when the user gains a different organization or Owner role", () => {
		const boundary = requiredBoundary();
		expect(
			isTaskAuthorizationCurrentV1({
				boundary,
				user: { ...user, organizationIds: ["team-b"] },
				agent: {
					...agent,
					ownerIds: [user.userId],
					availability: [{ kind: "organization", organizationId: "team-b" }],
				},
			}),
		).toBe(false);
	});

	it("keeps an original organization grant usable after an unrelated Owner change", () => {
		const boundary = requiredBoundary();
		expect(
			isTaskAuthorizationCurrentV1({
				boundary,
				user,
				agent: {
					...agent,
					revision: agent.revision + 1,
					ownerIds: ["owner-b"],
				},
			}),
		).toBe(true);
	});

	it("keeps a remaining original grant but rejects replacement grants", () => {
		const original: AgentManagementStateV1 = {
			...agent,
			availability: [
				...agent.availability,
				{ kind: "user", userId: user.userId },
			],
		};
		const boundary = requiredBoundary({ agent: original });
		expect(
			isTaskAuthorizationCurrentV1({
				boundary,
				user,
				agent: {
					...original,
					availability: [{ kind: "user", userId: user.userId }],
				},
			}),
		).toBe(true);
		expect(
			isTaskAuthorizationCurrentV1({
				boundary,
				user,
				agent: { ...original, ownerIds: [user.userId], availability: [] },
			}),
		).toBe(false);
	});

	it("rejects direct access and Owner access after their respective original grants are removed", () => {
		for (const original of [
			{ ...agent, ownerIds: [user.userId], availability: [] },
			{
				...agent,
				availability: [{ kind: "user" as const, userId: user.userId }],
			},
		]) {
			const boundary = requiredBoundary({ agent: original });
			expect(
				isTaskAuthorizationCurrentV1({ boundary, user, agent: original }),
			).toBe(true);
			expect(isTaskAuthorizationCurrentV1({ boundary, user, agent })).toBe(
				false,
			);
		}
	});

	it("fails closed on malformed directory facts and persisted boundaries without evaluating getters", () => {
		let reads = 0;
		const hostile = Object.defineProperty({ ...user }, "organizationIds", {
			enumerable: true,
			get() {
				reads += 1;
				return ["team-a"];
			},
		});
		expect(() => parseCurrentTaskUserV1(hostile)).toThrow();
		expect(reads).toBe(0);
		expect(() =>
			parseTaskAuthorizationBoundaryV1({ ...capture(), accessSources: [] }),
		).toThrow();
		expect(() =>
			parseTaskAuthorizationBoundaryV1({
				...capture(),
				accessSources: [{ kind: "user", userId: "owner-a" }],
			}),
		).toThrow();
	});
});

describe("system control transaction plan", () => {
	it.each([
		["waiting", false],
		["submitted", true],
		["processing", true],
		["unknown", true],
		["completed", false],
		["failed", false],
		["cancelled", false],
	] as const)(
		"plans permanent revocation and appropriate cancellation for %s",
		(status, ensureStop) => {
			const boundary = requiredBoundary();
			const plan = planTaskSystemControlV1({
				reason: "authorization_revoked",
				workerId: "worker",
				boundary,
				execution: {
					executionId: "execution-1",
					conversationId: "conversation-1",
					sessionGeneration: 2,
					status,
					actorId: "user-a",
					agentId: "agent-a",
					channelId: "web",
					authorizationRevision: "agent-access-4",
				},
			});
			expect(plan).toEqual({
				schemaVersion: 1,
				workerId: "worker",
				binding: {
					executionId: "execution-1",
					conversationId: "conversation-1",
					sessionGeneration: 2,
				},
				revokeAuthorization: true,
				ensureStop,
				audit: {
					action: "task.control.created",
					originalPrincipal: boundary.principal,
					reason: "authorization_revoked",
				},
			});
		},
	);
	it.each(["stop", "recovery", "generation_isolation"] as const)(
		"does not turn %s into task revocation",
		(reason) => {
			const plan = planTaskSystemControlV1({
				reason,
				workerId: "worker",
				boundary: requiredBoundary(),
				execution: {
					executionId: "execution-1",
					conversationId: "conversation-1",
					sessionGeneration: 2,
					status: "processing",
					actorId: "user-a",
					agentId: "agent-a",
					channelId: "web",
					authorizationRevision: "agent-access-4",
				},
			});
			expect(plan).toMatchObject({
				ensureStop: reason === "stop",
				revokeAuthorization: false,
				audit: { reason },
			});
		},
	);
	it("refuses control audit and cancellation for a different submitting subject", () => {
		expect(() =>
			planTaskSystemControlV1({
				reason: "authorization_revoked",
				workerId: "worker",
				boundary: requiredBoundary(),
				execution: {
					executionId: "execution-1",
					conversationId: "conversation-1",
					sessionGeneration: 2,
					status: "unknown",
					actorId: "owner-a",
					agentId: "agent-a",
					channelId: "web",
					authorizationRevision: "agent-access-4",
				},
			}),
		).toThrow("Task system control is invalid");
	});
	it("rejects an execution status that is malformed at the runtime boundary", () => {
		expect(() =>
			planTaskSystemControlV1({
				reason: "authorization_revoked",
				workerId: "worker",
				boundary: requiredBoundary(),
				execution: {
					executionId: "execution-1",
					conversationId: "conversation-1",
					sessionGeneration: 2,
					status: "still-running" as never,
					actorId: "user-a",
					agentId: "agent-a",
					channelId: "web",
					authorizationRevision: "agent-access-4",
				},
			}),
		).toThrow("Task system control is invalid");
	});
	it("rejects a non-positive session generation at the runtime boundary", () => {
		expect(() =>
			planTaskSystemControlV1({
				reason: "authorization_revoked",
				workerId: "worker",
				boundary: requiredBoundary(),
				execution: {
					executionId: "execution-1",
					conversationId: "conversation-1",
					sessionGeneration: 0,
					status: "processing",
					actorId: "user-a",
					agentId: "agent-a",
					channelId: "web",
					authorizationRevision: "agent-access-4",
				},
			}),
		).toThrow("Task system control is invalid");
	});
});
