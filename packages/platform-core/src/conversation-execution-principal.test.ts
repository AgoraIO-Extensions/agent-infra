import { describe, expect, it } from "vitest";
import { parseAuthority } from "./conversation-execution-input.js";
import { parseState } from "./conversation-execution-state.js";

const conversation = {
	schemaVersion: 1 as const,
	conversationId: "conversation",
	agentId: "agent",
	actorId: "shared-id",
	channelId: "api",
	status: "ready" as const,
	sessionGeneration: 1,
	hostSessionRef: null,
	authorizationRevision: "agent-revision",
	lastConversationCursor: 0,
	selectedModelOptionId: null,
	selectedReasoningLevel: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};
const state = {
	modelConfiguration: undefined,
	sourceMessage: undefined,
	targetExecution: undefined,
	existingStop: undefined,
	activeExecution: undefined,
};

describe("Conversation API principal parsing", () => {
	it.each(["user", "application"] as const)(
		"retains the trusted %s kind and original channel",
		(kind) => {
			for (const channelId of ["api", `api:${kind}`]) {
				const principal = { kind, id: "shared-id" };
				const authority = parseAuthority({
					schemaVersion: 1,
					actorId: principal.id,
					agentId: "agent",
					channelId,
					authorizationRevision: "agent-revision",
					supportsSupplementaryInstruction: false,
					taskBoundary: {
						schemaVersion: 1,
						principal,
						agentId: "agent",
						channelId,
						identityRevision: "identity-revision",
						agentAuthorizationRevision: "agent-revision",
						accessSources: [
							{ kind: "api-use", useGrantRevision: "use-revision" },
						],
					},
				});
				expect(authority.taskBoundary?.principal).toEqual(principal);
				expect(authority.channelId).toBe(channelId);
				expect(
					parseState({
						...state,
						conversation: { ...conversation, channelId, principal },
					}).conversation?.principal,
				).toEqual(principal);
			}
		},
	);

	it("refuses untyped API authority and Conversation state", () => {
		for (const channelId of ["api", "api:user", "api:application"]) {
			expect(() =>
				parseAuthority({
					schemaVersion: 1,
					actorId: "shared-id",
					agentId: "agent",
					channelId,
					authorizationRevision: "agent-revision",
					supportsSupplementaryInstruction: false,
				}),
			).toThrow();
			expect(() =>
				parseState({ ...state, conversation: { ...conversation, channelId } }),
			).toThrow();
		}
	});

	it("rejects cross-kind channels and principal IDs while preserving legacy web user state", () => {
		for (const [principal, channelId] of [
			[{ kind: "application", id: "shared-id" }, "api:user"],
			[{ kind: "user", id: "shared-id" }, "api:application"],
			[{ kind: "application", id: "shared-id" }, "web"],
			[{ kind: "application", id: "other-id" }, "api"],
		] as const) {
			expect(() =>
				parseState({
					...state,
					conversation: { ...conversation, channelId, principal },
				}),
			).toThrow();
		}
		const legacy = { ...conversation, channelId: "web" };
		expect(parseState({ ...state, conversation: legacy }).conversation).toEqual(
			legacy,
		);
	});
	it("requires target and active Execution principal to match typed C, preserving legacy user", () => {
		const target = {
			executionId: "execution",
			conversationId: "conversation",
			actorId: "shared-id",
			sessionGeneration: 1,
			modelConfigurationRevision: null,
			modelOptionId: null,
			reasoningLevel: null,
			status: "processing",
		};
		const active = {
			...target,
			turnId: "turn",
			lastEventSequence: 0,
			stopPending: false,
		};
		const principal = { kind: "application" as const, id: "shared-id" };
		for (const [key, execution] of [
			["targetExecution", target],
			["activeExecution", active],
		] as const) {
			const input = { ...state, conversation: { ...conversation, principal } };
			expect(
				parseState({ ...input, [key]: { ...execution, principal } })[key]
					?.principal,
			).toEqual(principal);
			for (const candidate of [
				execution,
				{ ...execution, principal: { kind: "user", id: "shared-id" } },
				{ ...execution, principal: { kind: "application", id: "other-id" } },
			]) {
				expect(() => parseState({ ...input, [key]: candidate })).toThrow();
			}
			expect(
				parseState({
					...state,
					conversation: { ...conversation, channelId: "web" },
					[key]: execution,
				})[key]?.executionId,
			).toBe("execution");
		}
	});
});
