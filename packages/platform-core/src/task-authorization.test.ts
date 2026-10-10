import { describe, expect, it } from "vitest";
import type { AgentManagementStateV1 } from "./agent-management.js";
import {
	type CurrentTaskApplicationV1,
	type CurrentTaskUserV1,
	capturePersonalApiTaskAuthorizationBoundaryV1,
	captureTaskApplicationAuthorizationBoundaryV1,
	captureTaskAuthorizationBoundaryV1,
	isTaskApplicationAuthorizationCurrentV1,
	isTaskAuthorizationCurrentV1,
	parseCurrentTaskApplicationV1,
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

	it("binds the directory snapshot to the task and rejects changed or missing bindings", () => {
		const binding = {
			schemaVersion: 1 as const,
			source: "internal",
			revision: "00000000-0000-4000-8000-000000000001",
			fetchedAt: Date.now() - 1_000,
			validUntil: Date.now() + 60_000,
		};
		const boundUser = { ...user, directorySnapshotBinding: binding };
		const boundary = requiredBoundary({ user: boundUser });
		expect(boundary.directorySnapshotBinding).toEqual(binding);
		expect(
			isTaskAuthorizationCurrentV1({ boundary, user: boundUser, agent }),
		).toBe(true);
		expect(
			isTaskAuthorizationCurrentV1({
				boundary,
				user: {
					...boundUser,
					directorySnapshotBinding: { ...binding, revision: "changed" },
				},
				agent,
			}),
		).toBe(false);
		expect(isTaskAuthorizationCurrentV1({ boundary, user, agent })).toBe(false);
	});

	it("rejects application principals carrying user access sources", () => {
		expect(() =>
			parseTaskAuthorizationBoundaryV1({
				...requiredBoundary(),
				principal: { kind: "application", id: user.userId },
			}),
		).toThrow("Task access source is invalid");
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
				ensureStop: false,
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

const applicationUseGrant = {
	principal: { kind: "application" as const, id: "user-a" },
	agentId: "agent-a",
	grantType: "use" as const,
	authorizationRevision: "app-use-3",
	revoked: false,
};
const application: CurrentTaskApplicationV1 = {
	schemaVersion: 1,
	applicationId: "user-a",
	status: "active",
	authorizationRevision: "app-2",
	useGrant: applicationUseGrant,
};

function applicationBoundary(current = application) {
	const boundary = captureTaskApplicationAuthorizationBoundaryV1({
		principal: { kind: "application", id: "user-a" },
		application: current,
		agent,
		channelId: "api",
		agentAuthorizationRevision: "agent-access-4",
	});
	if (!boundary) throw new Error("Expected application boundary");
	return boundary;
}

describe("original application API Task authority", () => {
	it("captures an explicit application use grant without inheriting Owner or availability", () => {
		const boundary = applicationBoundary();
		expect(boundary.accessSources).toEqual([
			{ kind: "api-use", useGrantRevision: "app-use-3" },
		]);
		expect(
			isTaskApplicationAuthorizationCurrentV1({
				boundary,
				application,
				agent: { ...agent, availability: [] },
			}),
		).toBe(true);
		expect(isTaskAuthorizationCurrentV1({ boundary, user, agent })).toBe(false);
		expect(capture({ principal: boundary.principal })).toBeNull();
	});
	it.each([
		["disabled", { ...application, status: "disabled" as const }],
		["missing use grant", { ...application, useGrant: null }],
		[
			"revoked use",
			{ ...application, useGrant: { ...applicationUseGrant, revoked: true } },
		],
		[
			"replacement grant",
			{
				...application,
				useGrant: {
					...applicationUseGrant,
					authorizationRevision: "new-use",
				},
			},
		],
		[
			"replacement application authority",
			{ ...application, authorizationRevision: "new-app" },
		],
		[
			"different Agent",
			{
				...application,
				useGrant: { ...applicationUseGrant, agentId: "agent-b" },
			},
		],
	] as const)(
		"does not revive original authority after %s",
		(_name, current) => {
			expect(
				isTaskApplicationAuthorizationCurrentV1({
					boundary: applicationBoundary(),
					application: current,
					agent,
				}),
			).toBe(false);
		},
	);
	it("rejects cross-channel capture and responsible-user impersonation", () => {
		for (const [principal, channelId] of [
			[{ kind: "application", id: "user-a" }, "web"],
			[{ kind: "user", id: "user-a" }, "api"],
			[{ kind: "application", id: "owner-a" }, "api"],
		] as const)
			expect(
				captureTaskApplicationAuthorizationBoundaryV1({
					principal,
					channelId,
					application,
					agent,
					agentAuthorizationRevision: "agent-access-4",
				}),
			).toBeNull();
	});
	it("requires an explicit typed Execution principal for application system control", () => {
		const execution = {
			executionId: "e",
			conversationId: "c",
			sessionGeneration: 1,
			actorId: "user-a",
			agentId: "agent-a",
			channelId: "api",
			authorizationRevision: "agent-access-4",
			status: "unknown" as const,
		};
		const input = {
			reason: "authorization_revoked" as const,
			workerId: "w",
			boundary: applicationBoundary(),
			execution,
		};
		expect(() => planTaskSystemControlV1(input)).toThrow();
		expect(() =>
			planTaskSystemControlV1({
				...input,
				execution: { ...execution, principal: { kind: "user", id: "user-a" } },
			}),
		).toThrow();
		expect(
			planTaskSystemControlV1({
				...input,
				execution: { ...execution, principal: applicationUseGrant.principal },
			}),
		).toMatchObject({
			ensureStop: true,
			revokeAuthorization: true,
			audit: { originalPrincipal: { kind: "application", id: "user-a" } },
		});
	});
	it("rejects malformed application facts without evaluating accessors", () => {
		let reads = 0;
		const getter = Object.defineProperty({ ...application }, "status", {
			enumerable: true,
			get() {
				reads++;
				return "active";
			},
		});
		const extra = Object.defineProperty({ ...application }, "__proto__", {
			enumerable: true,
			value: {},
		});
		for (const value of [
			getter,
			extra,
			new Proxy(application, {}),
			{ ...application, status: "unknown" },
			{
				...application,
				useGrant: { ...applicationUseGrant, grantType: "manage" },
			},
			{ ...application, credentialId: "not-background-authority" },
			{
				...application,
				useGrant: {
					...applicationUseGrant,
					principal: { kind: "user", id: "user-a" },
				},
			},
		]) {
			expect(() => parseCurrentTaskApplicationV1(value)).toThrow();
		}
		expect(reads).toBe(0);
	});
	it("prevents mixing or expanding API and Web access sources", () => {
		const boundary = applicationBoundary();
		for (const value of [
			{
				...boundary,
				accessSources: [
					...boundary.accessSources,
					{ kind: "owner", userId: "user-a" },
				],
			},
			{ ...boundary, channelId: "wecom" },
			{ ...requiredBoundary(), accessSources: boundary.accessSources },
		])
			expect(() => parseTaskAuthorizationBoundaryV1(value)).toThrow();
	});
	it("keeps personal API use independent from Web Owner and does not read credential lifetime", () => {
		const grant = {
			...applicationUseGrant,
			principal: { kind: "user" as const, id: user.userId },
		};
		const boundary = capturePersonalApiTaskAuthorizationBoundaryV1({
			user,
			useGrant: grant,
			agent,
			agentAuthorizationRevision: "agent-access-4",
		});
		if (!boundary) throw new Error("Expected personal API boundary");
		expect(
			isTaskAuthorizationCurrentV1({
				boundary,
				user,
				useGrant: grant,
				agent: { ...agent, availability: [] },
			}),
		).toBe(true);
		expect(
			isTaskAuthorizationCurrentV1({
				boundary,
				user,
				agent: { ...agent, ownerIds: [user.userId] },
			}),
		).toBe(false);
		expect(
			isTaskAuthorizationCurrentV1({
				boundary,
				user,
				useGrant: { ...grant, revoked: true },
				agent,
			}),
		).toBe(false);
		expect(capture({ channelId: "api" })).toBeNull();
	});
});

// Waiting never reached native dispatch; the original Store finisher supplies its terminal transaction.
describe("typed waiting system control", () => {
	it.each([
		["user", "stop"],
		["user", "authorization_revoked"],
		["application", "stop"],
		["application", "authorization_revoked"],
	] as const)(
		"plans %s waiting %s without an extra native stop",
		(kind, reason) => {
			const boundary =
				kind === "application" ? applicationBoundary() : requiredBoundary();
			const plan = planTaskSystemControlV1({
				reason,
				workerId: "waiting-worker",
				boundary,
				execution: {
					executionId: "waiting-execution",
					conversationId: "original-conversation",
					sessionGeneration: 2,
					principal: boundary.principal,
					actorId: boundary.principal.id,
					agentId: boundary.agentId,
					channelId: boundary.channelId,
					authorizationRevision: boundary.agentAuthorizationRevision,
					status: "waiting",
				},
			});
			expect(plan).toMatchObject({
				binding: {
					executionId: "waiting-execution",
					conversationId: "original-conversation",
					sessionGeneration: 2,
				},
				ensureStop: false,
				revokeAuthorization: reason === "authorization_revoked",
				audit: { originalPrincipal: boundary.principal, reason },
			});
		},
	);
	it.each([
		undefined,
		{ kind: "user", id: "user-a" },
		{ kind: "application", id: "other" },
	] as const)(
		"refuses substituted waiting application principal %j",
		(principal) => {
			const boundary = applicationBoundary();
			expect(() =>
				planTaskSystemControlV1({
					reason: "stop",
					workerId: "waiting-worker",
					boundary,
					execution: {
						executionId: "waiting-execution",
						conversationId: "original-conversation",
						sessionGeneration: 2,
						principal,
						actorId: boundary.principal.id,
						agentId: boundary.agentId,
						channelId: boundary.channelId,
						authorizationRevision: boundary.agentAuthorizationRevision,
						status: "waiting",
					},
				}),
			).toThrow("Task system control is invalid");
		},
	);
});
