import { describe, expect, it, vi } from "vitest";
import {
	createConversationModelSelectionReaderV1,
	createRuntimeModelSelectionReaderFromDispatchV1,
	createRuntimeModelSelectionReaderFromStoreV1,
	createRuntimeModelSelectionReaderV1,
} from "./runtime-model-selection-reader.js";

describe("Conversation model authority routing", () => {
	const configuration = {
		agentId: "agent-1",
		source: {
			kind: "standard" as const,
			templateId: "codex",
			connectionEnabled: false,
		},
		modelOptions: [
			{
				optionId: "saved-option",
				endpointId: "relay",
				modelId: "saved-model",
				reasoningLevels: ["medium"],
			},
		],
		defaultModelOptionId: "saved-option",
		defaultReasoningLevel: "medium",
	};
	const custom = {
		...configuration,
		source: {
			kind: "custom" as const,
			interactionMode: "platform-adapter" as const,
			connectionEnabled: false,
		},
	};
	it("reads standard defaults without an active Execution or Runtime directory", async () => {
		const runtimeReader = {
			read: vi.fn().mockRejectedValue(new Error("No active execution")),
		};
		const reader = createConversationModelSelectionReaderV1({
			runtimeReader,
			readTarget: async () => ({
				configuration,
				modelSelectionSupported: true,
			}),
		});
		expect(await reader.read(identity, "conversation-1")).toEqual({
			agentId: "agent-1",
			source: "standard",
			available: true,
			options: [
				{
					optionId: "saved-option",
					modelId: "saved-model",
					displayName: "saved-model",
					reasoningLevels: ["medium"],
				},
			],
			currentModelOptionId: "saved-option",
			currentReasoningLevel: "medium",
		});
		expect(runtimeReader.read).not.toHaveBeenCalled();
	});
	it("does not query custom images whose verified capability disables model selection", async () => {
		const runtimeReader = { read: vi.fn() };
		const reader = createConversationModelSelectionReaderV1({
			runtimeReader,
			readTarget: async () => ({
				configuration: custom,
				modelSelectionSupported: false,
			}),
		});
		expect(await reader.read(identity, "conversation-1")).toMatchObject({
			source: "custom-platform-adapter",
			available: false,
			options: [],
			currentModelOptionId: null,
		});
		expect(runtimeReader.read).not.toHaveBeenCalled();
	});
	it("uses only live Runtime options for supported custom images and never falls back", async () => {
		const live = {
			agentId: "agent-1",
			source: "custom-platform-adapter" as const,
			available: true,
			options: [
				{
					optionId: "native",
					modelId: "native",
					displayName: "Native",
					reasoningLevels: ["high"],
				},
			],
			currentModelOptionId: "native",
			currentReasoningLevel: "high",
		};
		const runtimeReader = { read: vi.fn().mockResolvedValue(live) };
		const reader = createConversationModelSelectionReaderV1({
			runtimeReader,
			readTarget: async () => ({
				configuration: custom,
				modelSelectionSupported: true,
			}),
		});
		expect(await reader.read(identity, "conversation-1")).toEqual(live);
		expect(runtimeReader.read).toHaveBeenCalledWith(identity, "conversation-1");
		runtimeReader.read.mockResolvedValueOnce(null);
		expect(await reader.read(identity, "conversation-1")).toBeNull();
		runtimeReader.read.mockRejectedValueOnce(new Error("Unavailable"));
		await expect(reader.read(identity, "conversation-1")).rejects.toThrow(
			"Unavailable",
		);
		runtimeReader.read.mockResolvedValueOnce({
			...live,
			agentId: "other-agent",
		});
		expect(await reader.read(identity, "conversation-1")).toBeNull();
		runtimeReader.read.mockResolvedValueOnce({ ...live, source: "standard" });
		expect(await reader.read(identity, "conversation-1")).toBeNull();
	});
	it("does not expose a directory for an unauthorized target", async () => {
		const runtimeReader = { read: vi.fn() };
		const reader = createConversationModelSelectionReaderV1({
			runtimeReader,
			readTarget: async () => null,
		});
		expect(await reader.read(identity, "conversation-1")).toBeNull();
		expect(runtimeReader.read).not.toHaveBeenCalled();
	});
	it("keeps supported custom selection unavailable when its transport is missing", async () => {
		const reader = createConversationModelSelectionReaderV1({
			readTarget: async () => ({
				configuration: custom,
				modelSelectionSupported: true,
			}),
		});
		await expect(reader.read(identity, "conversation-1")).rejects.toThrow(
			"unavailable",
		);
	});
});

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
	it("binds the default reader through the Store resolver and Worker transport", async () => {
		const { grant: _grant, ...dispatch } = request;
		const transport = { read: vi.fn().mockResolvedValue(response) };
		const query = {
			readRuntimeModelDirectoryDispatchRequestV1: vi
				.fn()
				.mockResolvedValue(dispatch),
		};
		const reader = createRuntimeModelSelectionReaderFromStoreV1({
			query,
			transport,
		});
		await expect(
			reader.read(identity, request.conversationId),
		).resolves.toMatchObject({
			agentId: request.agentId,
			currentModelOptionId: "model-primary",
		});
		expect(
			query.readRuntimeModelDirectoryDispatchRequestV1,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: request.conversationId,
				scope: {
					actorId: identity.userId,
					channelId: "web",
					principal: { kind: "user", id: identity.userId },
				},
			}),
		);
		expect(transport.read).toHaveBeenCalledWith(
			dispatch,
			expect.any(AbortSignal),
		);
	});

	it("projects a Worker dispatch without allowing the API to manufacture a Grant", async () => {
		const { grant: _grant, ...dispatch } = request;
		const reader = createRuntimeModelSelectionReaderFromDispatchV1({
			resolveRequest: async () => dispatch,
			transport: { read: vi.fn().mockResolvedValue(response) },
		});
		await expect(
			reader.read(identity, request.conversationId),
		).resolves.toMatchObject({
			agentId: request.agentId,
			currentModelOptionId: "model-primary",
			currentReasoningLevel: "medium",
		});
	});

	it("rejects a Worker response from another execution", async () => {
		const { grant: _grant, ...dispatch } = request;
		const reader = createRuntimeModelSelectionReaderFromDispatchV1({
			resolveRequest: async () => dispatch,
			transport: {
				read: vi.fn().mockResolvedValue({
					...response,
					executionId: "foreign-execution",
				}),
			},
		});
		await expect(
			reader.read(identity, request.conversationId),
		).resolves.toBeNull();
	});

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
