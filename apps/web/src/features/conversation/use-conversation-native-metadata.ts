import {
	NativeMetadataCommandsProjectionV2Schema,
	NativeMetadataProjectionV1OrV2Schema,
} from "@agent-infra/contracts/runtime";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import { client as defaultClient } from "../../pilot/generated-v2/client.gen.js";
import { readConversationNativeMetadataV1 } from "../../pilot/generated-v2/sdk.gen.js";
import type { NativeMetadataProjectionV1OrV2 as GeneratedNativeMetadataProjectionV1OrV2 } from "../../pilot/generated-v2/types.gen.js";
import { readFailed } from "../background-read.js";
import { collectionReadFailure } from "../collection-read-failure.js";
import type { ConversationCapabilityV1 } from "./conversation-capability-picker.js";

export function nativeMetadataCapabilities(
	projection: GeneratedNativeMetadataProjectionV1OrV2 | undefined,
): readonly ConversationCapabilityV1[] {
	if (!projection || projection.selector === "status") return [];
	return projection.capabilities.map((capability) => ({
		kind: capability.kind,
		name: capability.name,
		description: capability.description,
		source: capability.source.name,
		version: capability.source.version,
		...("schemaVersion" in capability && capability.schemaVersion === 2
			? {
					schemaVersion: 2 as const,
					effect: capability.effect,
					parameters: capability.parameters,
				}
			: {}),
		identity: capability.id,
		directoryRevision: projection.revision,
	}));
}

export function useConversationNativeMetadata({
	identityKey,
	conversationId,
	executionId,
	selector = "skills",
	projectionVersion,
	enabled = true,
	client = defaultClient,
}: {
	readonly identityKey: string;
	readonly conversationId: string;
	readonly executionId?: string;
	readonly selector?: "commands" | "skills";
	readonly projectionVersion?: 2;
	readonly enabled?: boolean;
	readonly client?: Client;
}) {
	const query = useQuery({
		queryKey: [
			"conversation-native-metadata",
			identityKey,
			conversationId,
			executionId ?? null,
			selector,
			projectionVersion ?? null,
			projectionVersion,
		],
		enabled: enabled && Boolean(identityKey && conversationId && executionId),
		retry: false,
		gcTime: 0,
		queryFn: async ({ signal }) => {
			if (!executionId) return undefined;
			const result = await readConversationNativeMetadataV1({
				client,
				path: { conversationId, executionId },
				query:
					projectionVersion === 2
						? { selector, projectionVersion: 2 as const }
						: { selector },
				signal,
				throwOnError: false,
			});
			signal.throwIfAborted();
			if (result.response?.status !== 200 || !result.data)
				throw Object.assign(new Error("Native metadata is unavailable"), {
					retryable: collectionReadFailure(result.response?.status).retryable,
				});
			const parsed =
				projectionVersion === 2
					? NativeMetadataCommandsProjectionV2Schema.safeParse(result.data)
					: NativeMetadataProjectionV1OrV2Schema.safeParse(result.data);
			if (!parsed.success || parsed.data.selector !== selector)
				throw new Error("Native metadata response is invalid");
			return parsed.data;
		},
	});
	// 读到过的目录在后台重读的可重试失败时继续可用（#3387）；无权、响应无效等仍清除目录。
	const projection =
		enabled &&
		!readFailed(
			query,
			(error) => (error as { retryable?: boolean } | null)?.retryable === true,
		)
			? query.data
			: undefined;
	return {
		...query,
		isPending: enabled && query.isPending,
		isError: enabled && query.isError,
		capabilities: nativeMetadataCapabilities(projection),
		available: projection !== undefined,
	};
}
