import { describe, expect, it, vi } from "vitest";
import {
	type BrowserHandoffCommandInvocationV1,
	createBrowserHandoffCommandExecutorV1,
} from "./browser-handoff-command.js";
import type { ConversationRuntimeBrowserHandoffRequestV1 } from "./conversation-runtime.js";

const request = {
	schemaVersion: 1,
	requestId: "request-1",
	traceId: "trace-1",
	actorId: "user-1",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	deliveryFence: 2,
	runtimeGrant: {},
	handoff: {
		kind: "take-over",
		handoffId: "handoff-1",
		operatorId: "user-1",
		subjectId: "user-1",
		runtime: {
			browserAlive: true,
			authorized: true,
			subjectId: "user-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			sessionGeneration: 1,
			resourceFence: 2,
			workloadRevision: 3,
			imageDigest: `sha256:${"a".repeat(64)}`,
			capabilityVersion: 4,
			pageRevision: 5,
		},
	},
} satisfies ConversationRuntimeBrowserHandoffRequestV1;

const invocation: BrowserHandoffCommandInvocationV1 = {
	identity: { userId: "user-1" },
	conversationId: "conversation-1",
	command: { schemaVersion: 1, command: "take_over", handoffId: "handoff-1" },
	idempotencyKey: "command-1",
	requestId: "request-1",
	traceId: "trace-1",
	signal: new AbortController().signal,
};

describe("Browser handoff command executor", () => {
	it("resolves a current Runtime request and reuses the Worker event authority", async () => {
		const worker = {
			browserHandoff: vi
				.fn()
				.mockResolvedValue({ outcome: "accepted" as const }),
		};
		const resolve = vi.fn().mockResolvedValue(request);
		const executor = createBrowserHandoffCommandExecutorV1({
			resolver: { resolve },
			worker,
			now: () => "2026-10-15T00:00:00.000Z",
		});
		await expect(executor.invoke(invocation)).resolves.toMatchObject({
			outcome: "accepted",
			executionId: "execution-1",
			handoffId: "handoff-1",
		});
		expect(resolve).toHaveBeenCalledWith(invocation);
		expect(worker.browserHandoff).toHaveBeenCalledWith(
			expect.objectContaining({
				request,
				adapterEventKeyPrefix: "browser-command:command-1",
				runtimeCursorPrefix: "browser-command:command-1",
			}),
		);
	});

	it("fails closed before Runtime when the binding resolver has no current request", async () => {
		const worker = { browserHandoff: vi.fn() };
		const executor = createBrowserHandoffCommandExecutorV1({
			resolver: { resolve: vi.fn().mockResolvedValue(null) },
			worker,
		});
		await expect(executor.invoke(invocation)).resolves.toMatchObject({
			outcome: "unavailable",
		});
		expect(worker.browserHandoff).not.toHaveBeenCalled();
	});

	it("fails closed when the resolver returns another Conversation", async () => {
		const worker = { browserHandoff: vi.fn() };
		const foreign = { ...request, conversationId: "foreign-conversation" };
		const executor = createBrowserHandoffCommandExecutorV1({
			resolver: { resolve: vi.fn().mockResolvedValue(foreign) },
			worker,
		});
		await expect(executor.invoke(invocation)).resolves.toMatchObject({
			outcome: "unavailable",
		});
		expect(worker.browserHandoff).not.toHaveBeenCalled();
	});

	it("maps an uncertain Worker result without retrying Runtime locally", async () => {
		const worker = {
			browserHandoff: vi.fn().mockRejectedValue(new Error("lost response")),
		};
		const executor = createBrowserHandoffCommandExecutorV1({
			resolver: { resolve: vi.fn().mockResolvedValue(request) },
			worker,
		});
		await expect(executor.invoke(invocation)).resolves.toMatchObject({
			outcome: "unknown",
			executionId: "execution-1",
		});
		expect(worker.browserHandoff).toHaveBeenCalledOnce();
	});
});
