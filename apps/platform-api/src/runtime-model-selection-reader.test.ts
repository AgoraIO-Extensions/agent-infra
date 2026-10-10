import { describe, expect, it, vi } from "vitest";
import { createRuntimeModelSelectionReaderV1 } from "./runtime-model-selection-reader.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const],
	authorizationRevision: "auth-1",
};

const request = {
	schemaVersion: 1 as const,
	requestId: "request-model-directory",
	traceId: "trace-model-directory",
	actorId: identity.userId,
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 2,
	deliveryFence: 7,
	hostSessionRef: "host-session-1",
	grant: {
		schemaVersion: 1 as const,
		format: "compact-jws" as const,
		token: "header.payload.signature",
	},
};

const response = {
	schemaVersion: 1,
	hostSessionRef: request.hostSessionRef,
	executionId: request.executionId,
	options: [
		{
			schemaVersion: 1,
			modelOptionId: "model-primary",
			modelId: "provider/model-primary",
			displayName: "Primary",
			reasoningLevels: ["low", "medium"],
		},
	],
	current: { modelOptionId: "model-primary", reasoningLevel: "medium" },
};

describe("Runtime model-selection reader", () => {
	it("projects only a bound Runtime response", async () => {
		const transport = { read: vi.fn().mockResolvedValue(response) };
		const reader = createRuntimeModelSelectionReaderV1({
			resolveRequest: async () => request,
			transport,
		});
		await expect(
			reader.read(identity, request.conversationId),
		).resolves.toEqual({
			agentId: "agent-1",
			source: "custom-platform-adapter",
			available: true,
			options: [
				{
					optionId: "model-primary",
					displayName: "Primary",
					modelId: "provider/model-primary",
					reasoningLevels: ["low", "medium"],
				},
			],
			currentModelOptionId: "model-primary",
			currentReasoningLevel: "medium",
		});
	});

	it.each([
		{ actorId: "foreign-user" },
		{ conversationId: "foreign-conversation" },
		{ channelId: "api" },
	])("rejects an API request with a foreign binding: %j", async (patch) => {
		const reader = createRuntimeModelSelectionReaderV1({
			resolveRequest: async () => ({ ...request, ...patch }),
			transport: { read: vi.fn() },
		});
		await expect(
			reader.read(identity, request.conversationId),
		).resolves.toBeNull();
	});

	it("rejects a Runtime response whose current selection is not in its directory", async () => {
		const reader = createRuntimeModelSelectionReaderV1({
			resolveRequest: async () => request,
			transport: {
				read: vi.fn().mockResolvedValue({
					...response,
					current: { modelOptionId: "missing", reasoningLevel: "medium" },
				}),
			},
		});
		await expect(
			reader.read(identity, request.conversationId),
		).resolves.toBeNull();
	});
});
