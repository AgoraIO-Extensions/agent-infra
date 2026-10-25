import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfigurationRecordV2 } from "./agent-configuration.js";
import {
	createRecentPersonalConversationsUseCaseV1,
	type RecentPersonalConversationRecordV1,
	type RecentPersonalConversationsReadV1,
	type RecentPersonalConversationUnavailableAgentV1,
} from "./conversation-recent.js";
import type { CurrentTaskUserV1 } from "./task-authorization.js";

function record(
	id: string,
	updatedAt = "2026-09-06T00:00:00.000900Z",
): RecentPersonalConversationRecordV1 {
	const configuration = {
		agentId: "agent",
		revision: 1,
		source: { kind: "standard" },
	} as AgentConfigurationRecordV2;
	return {
		actorId: "user",
		channelId: "web",
		projection: {
			conversationId: id,
			agentId: "agent",
			status: "ready",
			selectedModelOptionId: null,
			selectedReasoningLevel: null,
			lastConversationCursor: null,
			createdAt: new Date(updatedAt),
			updatedAt: new Date(updatedAt),
		},
		position: { conversationId: id, updatedAt },
		agent: {
			schemaVersion: 1,
			applicationId: "application",
			agentId: "agent",
			applicantId: "owner",
			status: "available",
			revision: 1,
			approvalRevision: 1,
			decisionReason: null,
			serviceAvailability: "ready",
			desiredState: "running",
			workloadRevision: 1,
			fence: 1,
			ownerIds: ["owner"],
			availability: [{ kind: "organization", organizationId: "team" }],
			failureCode: null,
		},
		channel: {
			boundary: { agentId: "agent", channelId: "web" },
			configurationRevision: 1,
			workload: {
				schemaVersion: 1,
				agentId: "agent",
				sourceConfigurationRevision: 1,
				sourceLifecycleRevision: 1,
				revision: 1,
				fence: 1,
				phase: "preflight",
				candidate: { configuration, deployment: {} },
				verified: null,
				verifiedRevision: null,
				identity: null,
				rollback: false,
				failureCode: null,
				attempts: 0,
			},
		},
	};
}

function harness(
	records = [record("a"), record("z")],
	unavailableAgents: RecentPersonalConversationUnavailableAgentV1[] = [],
) {
	let user: CurrentTaskUserV1 | null = {
		schemaVersion: 1,
		userId: "user",
		accountStatus: "active",
		organizationIds: ["team"],
		authorizationRevision: "current-1",
	};
	const resolveCurrentUser = vi.fn(async () => user);
	const readRecentPersonalConversations = vi.fn(
		async (): Promise<RecentPersonalConversationsReadV1> => ({
			records,
			unavailableAgents,
		}),
	);
	return {
		resolveCurrentUser,
		readRecentPersonalConversations,
		useCase: createRecentPersonalConversationsUseCaseV1({
			resolveCurrentUser,
			query: { readRecentPersonalConversations },
		}),
		setUser(value: CurrentTaskUserV1 | null) {
			user = value;
		},
	};
}

describe("recent personal Web conversations Core", () => {
	it("requests one extra authorized row and transports full PostgreSQL cursor precision", async () => {
		const h = harness([
			record("a"),
			record("z", "2026-09-06T00:00:00.000100Z"),
		]);
		const first = await h.useCase.list("user", { limit: 1 });
		expect(first.items.map((item) => item.conversationId)).toEqual(["a"]);
		expect(first.unavailableAgentIds).toEqual([]);
		h.readRecentPersonalConversations.mockResolvedValueOnce({
			records: [],
			unavailableAgents: [],
		});
		await h.useCase.list("user", {
			limit: 1,
			cursor: first.nextCursor ?? undefined,
		});
		expect(h.readRecentPersonalConversations).toHaveBeenLastCalledWith({
			user: expect.objectContaining({
				userId: "user",
				organizationIds: ["team"],
			}),
			limit: 2,
			after: { conversationId: "a", updatedAt: "2026-09-06T00:00:00.000900Z" },
		});
	});

	it("uses the current directory on every page and rejects account disable through an old cursor", async () => {
		const h = harness();
		const first = await h.useCase.list("user", { limit: 1 });
		h.setUser({
			schemaVersion: 1,
			userId: "user",
			accountStatus: "disabled",
			organizationIds: ["team"],
			authorizationRevision: "current-2",
		});
		await expect(
			h.useCase.list("user", { cursor: first.nextCursor ?? undefined }),
		).rejects.toMatchObject({ code: "revoked" });
		expect(h.resolveCurrentUser).toHaveBeenCalledTimes(2);
		expect(h.readRecentPersonalConversations).toHaveBeenCalledTimes(1);
	});

	it.each([
		[0, "foreign-query"],
		[1, "another-user"],
		[2, "wecom"],
		[3, "id.asc"],
		[4, "2026-09-06T00:00:00.000Z"],
		[4, "2026-02-30T00:00:00.000900Z"],
		[4, "0000-01-01T00:00:00.000000Z"],
	])(
		"rejects a cursor with a mismatched binding or timestamp (%s)",
		async (index, replacement) => {
			const h = harness();
			const first = await h.useCase.list("user", { limit: 1 });
			const values = JSON.parse(
				Buffer.from(
					(first.nextCursor ?? "").slice("recent.v1.".length),
					"base64url",
				).toString(),
			);
			values[index] = replacement;
			const cursor = `recent.v1.${Buffer.from(JSON.stringify(values)).toString("base64url")}`;
			await expect(h.useCase.list("user", { cursor })).rejects.toMatchObject({
				code: "invalid_request",
			});
			expect(h.readRecentPersonalConversations).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["creating", "stopped", "creation_failed", "disabled"] as const)(
		"retains authorized %s history without requiring Runtime readiness",
		async (status) => {
			const value = record("history");
			const h = harness([
				{
					...value,
					agent: {
						...value.agent,
						status,
						serviceAvailability: null,
						desiredState:
							status === "stopped" || status === "disabled"
								? "stopped"
								: "running",
						failureCode:
							status === "creation_failed" ? "creation_not_ready" : null,
					},
				},
			]);
			expect((await h.useCase.list("user", {})).items).toHaveLength(1);
		},
	);

	it("uses only current channel facts for a verified custom adapter during an update", async () => {
		const value = record("custom");
		const workload = value.channel.workload;
		if (!workload) throw new Error("Fixture workload is absent");
		const configuration = {
			...workload.candidate.configuration,
			source: { kind: "custom", interactionMode: "platform-adapter" },
		} as AgentConfigurationRecordV2;
		const h = harness([
			{
				...value,
				channel: {
					...value.channel,
					workload: {
						...workload,
						phase: "applying",
						candidate: { configuration, deployment: {} },
						verified: { configuration, deployment: {} },
						verifiedRevision: 1,
						capabilities: { supplementaryInstruction: false },
					},
				},
			},
		]);
		expect((await h.useCase.list("user", {})).items).toHaveLength(1);
	});

	it.each(["actor", "channel", "grant", "workload", "self-managed"])(
		"fails closed when Store returns an ineligible %s row instead of filtering before limit",
		async (kind) => {
			const value = record("history");
			const workload = value.channel.workload;
			if (!workload) throw new Error("Fixture workload is absent");
			const bad =
				kind === "actor"
					? { ...value, actorId: "another-user" }
					: kind === "channel"
						? { ...value, channelId: "wecom" }
						: kind === "grant"
							? { ...value, agent: { ...value.agent, availability: [] } }
							: kind === "workload"
								? { ...value, channel: { ...value.channel, workload: null } }
								: {
										...value,
										channel: {
											...value.channel,
											workload: {
												...workload,
												candidate: {
													configuration: {
														...workload.candidate.configuration,
														source: {
															kind: "custom",
															interactionMode: "self-managed",
														},
													} as AgentConfigurationRecordV2,
													deployment: {},
												},
											},
										},
									};
			await expect(
				harness([bad]).useCase.list("user", {}),
			).rejects.toMatchObject({ code: "unavailable" });
		},
	);

	it("returns confirmed rows and names omitted unknown-channel Agents instead of failing the page (#3379)", async () => {
		const h = harness(
			[record("a"), record("m"), record("z")],
			[
				{
					agent: {
						...record("x").agent,
						agentId: "stopped-agent",
						status: "stopped",
						serviceAvailability: null,
						desiredState: "stopped",
					},
				},
				{ agent: { ...record("x").agent, agentId: "other-agent" } },
			],
		);
		const first = await h.useCase.list("user", { limit: 2 });
		expect(first.items.map((item) => item.conversationId)).toEqual(["a", "m"]);
		expect(first.unavailableAgentIds).toEqual(["other-agent", "stopped-agent"]);
		// The cursor still binds only the last returned confirmed row.
		h.readRecentPersonalConversations.mockResolvedValueOnce({
			records: [record("z")],
			unavailableAgents: [],
		});
		const second = await h.useCase.list("user", {
			limit: 2,
			cursor: first.nextCursor ?? undefined,
		});
		expect(h.readRecentPersonalConversations).toHaveBeenLastCalledWith(
			expect.objectContaining({
				limit: 3,
				after: {
					conversationId: "m",
					updatedAt: "2026-09-06T00:00:00.000900Z",
				},
			}),
		);
		expect(second).toEqual({
			items: [expect.objectContaining({ conversationId: "z" })],
			nextCursor: null,
			unavailableAgentIds: [],
		});
		// A page whose only Web history belongs to an unconfirmed Agent is empty, not failed.
		const empty = harness(
			[],
			[{ agent: { ...record("x").agent, agentId: "only" } }],
		);
		expect(await empty.useCase.list("user", {})).toEqual({
			items: [],
			nextCursor: null,
			unavailableAgentIds: ["only"],
		});
	});

	it.each([
		"foreign-grant",
		"other-organization",
		"non-history-status",
		"duplicate",
		"also-listed",
		"over-limit",
		"malformed",
	])(
		"fails closed instead of naming an ineligible omitted Agent (%s)",
		async (kind) => {
			const agent = { ...record("x").agent, agentId: "omitted" };
			const unavailable: RecentPersonalConversationUnavailableAgentV1[] =
				kind === "foreign-grant"
					? [
							{
								agent: {
									...agent,
									ownerIds: ["owner"],
									availability: [{ kind: "user", userId: "another-user" }],
								},
							},
						]
					: kind === "other-organization"
						? [
								{
									agent: {
										...agent,
										availability: [
											{ kind: "organization", organizationId: "another-team" },
										],
									},
								},
							]
						: kind === "non-history-status"
							? [
									{
										agent: {
											...agent,
											status: "pending_approval",
											approvalRevision: null,
											serviceAvailability: null,
											desiredState: null,
											workloadRevision: null,
											fence: null,
										} as never,
									},
								]
							: kind === "duplicate"
								? [{ agent }, { agent }]
								: kind === "also-listed"
									? [{ agent: record("x").agent }]
									: kind === "over-limit"
										? Array.from({ length: 101 }, (_, index) => ({
												agent: { ...agent, agentId: `omitted-${index}` },
											}))
										: [{ agent: { ...agent, ownerIds: "owner" } as never }];
			await expect(
				harness([record("a")], unavailable).useCase.list("user", {}),
			).rejects.toMatchObject({ code: "unavailable" });
		},
	);

	it("rejects a Store read without the omitted-Agent list", async () => {
		const h = harness();
		h.readRecentPersonalConversations.mockResolvedValueOnce({
			records: [record("a")],
		} as never);
		await expect(h.useCase.list("user", {})).rejects.toMatchObject({
			code: "unavailable",
		});
		h.readRecentPersonalConversations.mockResolvedValueOnce([
			record("a"),
		] as never);
		await expect(h.useCase.list("user", {})).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("reports directory and query failures explicitly", async () => {
		const h = harness();
		h.setUser(null);
		await expect(h.useCase.list("user", {})).rejects.toMatchObject({
			code: "unavailable",
		});
		const other = harness();
		other.readRecentPersonalConversations.mockRejectedValueOnce(
			new Error("private adapter detail"),
		);
		await expect(other.useCase.list("user", {})).rejects.toMatchObject({
			code: "unavailable",
			message: "Recent personal conversations are unavailable",
		});
	});
});
