import {
	type FileAccessGrantV1,
	type FileDescriptorV1,
	FileProjectionV1Schema,
} from "@agent-infra/contracts/files";
import type {
	ConversationEventUseCaseV1,
	PersistedRuntimeConversationEventV1,
} from "@agent-infra/platform-core";
import type {
	BrowserFileExecutionBindingV1,
	BrowserFileGrantBridgeV1,
} from "./browser-file-bridge.js";

type FileProjectionV1 = ReturnType<typeof FileProjectionV1Schema.parse>;

export type BrowserResultFileEventBindingV1 = BrowserFileExecutionBindingV1 &
	Readonly<{
		deliveryFence: number;
	}>;

export type BrowserResultFileEventInputV1 = Readonly<{
	binding: BrowserResultFileEventBindingV1;
	executionGrant: FileAccessGrantV1;
	descriptor: FileDescriptorV1;
	body: ReadableStream<Uint8Array>;
	fileIdempotencyKey: string;
	accessIdempotencyKey?: string;
	adapterEventKey: string;
	runtimeCursor: string;
	occurredAt: string;
}>;

export type BrowserResultFileEventResultV1 = Readonly<{
	outcome: "accepted" | "replayed";
	file: FileProjectionV1;
	event: PersistedRuntimeConversationEventV1;
}>;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function assertBinding(binding: BrowserResultFileEventBindingV1): void {
	if (
		!binding ||
		!["agentId", "conversationId", "executionId"].every((key) =>
			isNonEmptyString(binding[key as keyof BrowserResultFileEventBindingV1]),
		) ||
		!Number.isSafeInteger(binding.sessionGeneration) ||
		binding.sessionGeneration < 1 ||
		!Number.isSafeInteger(binding.deliveryFence) ||
		binding.deliveryFence < 0
	) {
		throw new Error("BROWSER_RESULT_BINDING_INVALID");
	}
}

function sameExecutionBinding(
	left: BrowserFileExecutionBindingV1,
	right: BrowserResultFileEventBindingV1,
): boolean {
	return (
		left.agentId === right.agentId &&
		left.conversationId === right.conversationId &&
		left.executionId === right.executionId &&
		left.sessionGeneration === right.sessionGeneration
	);
}

function confirmedResultFile(value: unknown): FileProjectionV1 {
	try {
		const file = FileProjectionV1Schema.parse(value);
		if (file.kind !== "result" || file.status !== "available") {
			throw new Error("unavailable");
		}
		return file;
	} catch {
		throw new Error("BROWSER_RESULT_FILE_UNAVAILABLE");
	}
}

function confirmedResultEvent(
	value: PersistedRuntimeConversationEventV1,
	file: FileProjectionV1,
	binding: BrowserResultFileEventBindingV1,
): PersistedRuntimeConversationEventV1 {
	if (
		value.conversationId !== binding.conversationId ||
		value.executionId !== binding.executionId ||
		value.event.type !== "result.file" ||
		value.event.fileId !== file.fileId ||
		value.event.name !== file.descriptor.name ||
		value.event.mediaType !== file.descriptor.mediaType ||
		value.event.sizeBytes !== file.descriptor.sizeBytes
	) {
		throw new Error("BROWSER_RESULT_EVENT_UNAVAILABLE");
	}
	return value;
}

/**
 * Publishes a Browser result only after File Core confirms the result object.
 * Conversation Event Core remains the sole event/idempotency authority.
 */
export function createBrowserResultFileEventAdapterV1(input: {
	readonly bridge: BrowserFileGrantBridgeV1;
	readonly events: ConversationEventUseCaseV1;
}) {
	return {
		async persist(
			request: BrowserResultFileEventInputV1,
		): Promise<BrowserResultFileEventResultV1> {
			assertBinding(request.binding);
			if (!sameExecutionBinding(input.bridge.binding, request.binding)) {
				throw new Error("BROWSER_RESULT_BINDING_CONFLICT");
			}

			const file = confirmedResultFile(
				await input.bridge.writeResult({
					binding: {
						agentId: request.binding.agentId,
						conversationId: request.binding.conversationId,
						executionId: request.binding.executionId,
						sessionGeneration: request.binding.sessionGeneration,
					},
					executionGrant: request.executionGrant,
					descriptor: request.descriptor,
					body: request.body,
					idempotencyKey: request.fileIdempotencyKey,
					accessIdempotencyKey: request.accessIdempotencyKey,
				}),
			);
			let decision: Awaited<ReturnType<ConversationEventUseCaseV1["persist"]>>;
			try {
				decision = await input.events.persist({
					schemaVersion: 1,
					conversationId: request.binding.conversationId,
					executionId: request.binding.executionId,
					sessionGeneration: request.binding.sessionGeneration,
					deliveryFence: request.binding.deliveryFence,
					adapterEventKey: request.adapterEventKey,
					runtimeCursor: request.runtimeCursor,
					occurredAt: request.occurredAt,
					event: {
						type: "result.file",
						fileId: file.fileId,
						name: file.descriptor.name,
						mediaType: file.descriptor.mediaType,
						sizeBytes: file.descriptor.sizeBytes,
					},
				});
			} catch {
				throw new Error("BROWSER_RESULT_EVENT_UNAVAILABLE");
			}
			if (decision.outcome === "stale") {
				throw new Error("BROWSER_RESULT_EVENT_STALE");
			}
			if (decision.outcome !== "accepted" && decision.outcome !== "replayed") {
				throw new Error("BROWSER_RESULT_EVENT_UNAVAILABLE");
			}
			return {
				outcome: decision.outcome,
				file,
				event: confirmedResultEvent(decision.event, file, request.binding),
			};
		},
	};
}
