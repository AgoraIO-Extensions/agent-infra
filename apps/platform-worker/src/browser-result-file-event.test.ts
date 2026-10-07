import type {
	FileAccessGrantV1,
	FileDescriptorV1,
	FileProjectionV1Schema,
} from "@agent-infra/contracts/files";
import type {
	ConversationEventDecisionV1,
	ConversationEventUseCaseV1,
	PersistedRuntimeConversationEventV1,
} from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import {
	type BrowserFileGrantBridgeV1,
	createBrowserFileGrantBridgeV1,
} from "./browser-file-bridge.js";

type FileProjectionV1 = ReturnType<typeof FileProjectionV1Schema.parse>;

import {
	type BrowserResultFileEventInputV1,
	createBrowserResultFileEventAdapterV1,
} from "./browser-result-file-event.js";

const binding = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 3,
	deliveryFence: 7,
} as const;

const executionBinding = {
	agentId: binding.agentId,
	conversationId: binding.conversationId,
	executionId: binding.executionId,
	sessionGeneration: binding.sessionGeneration,
} as const;

const grant = {
	schemaVersion: 1,
	format: "compact-jws",
	token: "opaque-file-grant",
} as FileAccessGrantV1;

const descriptor: FileDescriptorV1 = {
	name: "report.pdf",
	mediaType: "application/pdf",
	sizeBytes: 3,
	sha256: "a".repeat(64),
};

const projection: FileProjectionV1 = {
	schemaVersion: 1,
	fileId: "file-1",
	kind: "result",
	descriptor,
	status: "available",
	createdAt: "2026-10-07T00:00:00Z",
	expiresAt: "2026-10-07T01:00:00Z",
};

function persistedEvent(): PersistedRuntimeConversationEventV1 {
	return {
		schemaVersion: 1,
		eventId: "event-1",
		conversationId: binding.conversationId,
		executionId: binding.executionId,
		sequence: 1,
		conversationCursor: 1,
		occurredAt: "2026-10-07T00:00:01.000Z",
		event: {
			type: "result.file",
			fileId: projection.fileId,
			name: descriptor.name,
			mediaType: descriptor.mediaType,
			sizeBytes: descriptor.sizeBytes,
		},
	};
}

function setup(
	decision: ConversationEventDecisionV1 = {
		outcome: "accepted",
		event: persistedEvent(),
	},
) {
	const writeResult = vi.fn(async () => projection);
	const bridge = {
		binding: executionBinding,
		writeResult,
	} as unknown as BrowserFileGrantBridgeV1;
	const persist = vi.fn(async () => decision);
	const events = { persist } as unknown as ConversationEventUseCaseV1;
	const adapter = createBrowserResultFileEventAdapterV1({ bridge, events });
	const input: BrowserResultFileEventInputV1 = {
		binding,
		executionGrant: grant,
		descriptor,
		body: new ReadableStream<Uint8Array>(),
		fileIdempotencyKey: "browser-file-1",
		accessIdempotencyKey: "browser-file-access-1",
		adapterEventKey: "browser-event-1",
		runtimeCursor: "browser-cursor-1",
		occurredAt: "2026-10-07T00:00:01Z",
	};
	return { adapter, input, writeResult, persist };
}

describe("Browser result file event adapter", () => {
	it("writes the confirmed file before persisting the execution-bound result event", async () => {
		const { adapter, input, writeResult, persist } = setup();

		await expect(adapter.persist(input)).resolves.toMatchObject({
			outcome: "accepted",
			file: projection,
			event: persistedEvent(),
		});
		expect(writeResult).toHaveBeenCalledWith({
			binding: executionBinding,
			executionGrant: grant,
			descriptor,
			body: input.body,
			idempotencyKey: input.fileIdempotencyKey,
			accessIdempotencyKey: input.accessIdempotencyKey,
		});
		expect(persist).toHaveBeenCalledWith({
			schemaVersion: 1,
			conversationId: binding.conversationId,
			executionId: binding.executionId,
			sessionGeneration: binding.sessionGeneration,
			deliveryFence: binding.deliveryFence,
			adapterEventKey: input.adapterEventKey,
			runtimeCursor: input.runtimeCursor,
			occurredAt: input.occurredAt,
			event: {
				type: "result.file",
				fileId: projection.fileId,
				name: projection.descriptor.name,
				mediaType: projection.descriptor.mediaType,
				sizeBytes: projection.descriptor.sizeBytes,
			},
		});
	});

	it("replays the same operation without creating a second file or event", async () => {
		const accepted = { outcome: "accepted" as const, event: persistedEvent() };
		const replayed = { outcome: "replayed" as const, event: persistedEvent() };
		const repeated = setup(accepted);
		repeated.persist
			.mockResolvedValueOnce(accepted)
			.mockResolvedValueOnce(replayed);

		await expect(
			repeated.adapter.persist(repeated.input),
		).resolves.toMatchObject({
			outcome: "accepted",
		});
		await expect(
			repeated.adapter.persist(repeated.input),
		).resolves.toMatchObject({
			outcome: "replayed",
		});
		expect(repeated.writeResult).toHaveBeenCalledTimes(2);
		expect(repeated.persist).toHaveBeenCalledTimes(2);
		expect(repeated.writeResult).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				idempotencyKey: repeated.input.fileIdempotencyKey,
			}),
		);
	});

	it("returns the existing event on a legitimate replay", async () => {
		const replayed = { outcome: "replayed" as const, event: persistedEvent() };
		const { adapter, input, persist } = setup(replayed);

		await expect(adapter.persist(input)).resolves.toMatchObject({
			outcome: "replayed",
			event: replayed.event,
		});
		expect(persist).toHaveBeenCalledOnce();
	});

	it("rejects verified File Grant claims for another execution before file access", async () => {
		const { input, persist } = setup();
		const clientWriteResult = vi.fn(async () => projection);
		const bridge = createBrowserFileGrantBridgeV1({
			binding: executionBinding,
			client: {
				readInput: async () => new ReadableStream<Uint8Array>(),
				writeResult: clientWriteResult,
			},
			verifyExecutionGrant: async () => ({
				...executionBinding,
				executionId: "other-execution",
			}),
		});
		const adapter = createBrowserResultFileEventAdapterV1({
			bridge,
			events: { persist } as unknown as ConversationEventUseCaseV1,
		});

		await expect(adapter.persist(input)).rejects.toThrow(
			"BROWSER_FILE_GRANT_BINDING_CONFLICT",
		);
		expect(clientWriteResult).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});

	it("rejects a binding that does not match the bridge before writing a file", async () => {
		const { adapter, input, writeResult, persist } = setup();

		await expect(
			adapter.persist({
				...input,
				binding: { ...input.binding, executionId: "other-execution" },
			}),
		).rejects.toThrow("BROWSER_RESULT_BINDING_CONFLICT");
		expect(writeResult).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});

	it("keeps file write failures and failed projections out of the event path", async () => {
		const failedWrite = setup();
		failedWrite.writeResult.mockRejectedValue(new Error("file write unknown"));
		await expect(
			failedWrite.adapter.persist(failedWrite.input),
		).rejects.toThrow("file write unknown");
		expect(failedWrite.persist).not.toHaveBeenCalled();

		const failedProjection = setup();
		failedProjection.writeResult.mockResolvedValue({
			...projection,
			status: "failed",
		});
		await expect(
			failedProjection.adapter.persist(failedProjection.input),
		).rejects.toThrow("BROWSER_RESULT_FILE_UNAVAILABLE");
		expect(failedProjection.persist).not.toHaveBeenCalled();
	});

	it("does not publish an event for a non-confirmed file projection", async () => {
		const { adapter, input, writeResult, persist } = setup();
		writeResult.mockResolvedValue({ ...projection, status: "pending" });

		await expect(adapter.persist(input)).rejects.toThrow(
			"BROWSER_RESULT_FILE_UNAVAILABLE",
		);
		expect(persist).not.toHaveBeenCalled();
	});

	it("rejects an unknown event decision instead of returning a completed file", async () => {
		const unknown = setup({
			outcome: "unknown",
		} as unknown as ConversationEventDecisionV1);

		await expect(unknown.adapter.persist(unknown.input)).rejects.toThrow(
			"BROWSER_RESULT_EVENT_UNAVAILABLE",
		);
	});

	it("rejects a different file under the same event idempotency key", async () => {
		const conflict = setup();
		const otherProjection = {
			...projection,
			fileId: "file-2",
		};
		conflict.writeResult
			.mockResolvedValueOnce(projection)
			.mockResolvedValueOnce(otherProjection);
		conflict.persist
			.mockResolvedValueOnce({
				outcome: "accepted",
				event: persistedEvent(),
			})
			.mockRejectedValueOnce(new Error("event idempotency conflict"));

		await conflict.adapter.persist(conflict.input);
		await expect(conflict.adapter.persist(conflict.input)).rejects.toThrow(
			"BROWSER_RESULT_EVENT_UNAVAILABLE",
		);
		expect(conflict.persist).toHaveBeenCalledTimes(2);
	});

	it("keeps stale or unavailable event persistence from becoming a completed result", async () => {
		const stale = { outcome: "stale" as const };
		const { adapter, input } = setup(stale);

		await expect(adapter.persist(input)).rejects.toThrow(
			"BROWSER_RESULT_EVENT_STALE",
		);

		const unavailable = setup();
		unavailable.persist.mockRejectedValue(new Error("event store unavailable"));
		await expect(
			unavailable.adapter.persist(unavailable.input),
		).rejects.toThrow("BROWSER_RESULT_EVENT_UNAVAILABLE");
	});
});
