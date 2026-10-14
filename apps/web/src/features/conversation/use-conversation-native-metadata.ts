import { NativeMetadataProjectionV1Schema } from "@agent-infra/contracts/runtime";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import { client as defaultClient } from "../../pilot/generated-v2/client.gen.js";
import { readConversationNativeMetadataV1 } from "../../pilot/generated-v2/sdk.gen.js";
import type { NativeMetadataProjectionV1 } from "../../pilot/generated-v2/types.gen.js";
import type { ConversationCapabilityV1 } from "./conversation-capability-picker.js";

export function nativeMetadataCapabilities(
	projection: NativeMetadataProjectionV1 | undefined,
): readonly ConversationCapabilityV1[] {
	if (!projection || projection.selector === "status") return [];
	return projection.capabilities.map((capability) => ({
		kind: capability.kind,
		name: capability.name,
		description: capability.description,
		source: capability.source.name,
		version: capability.source.version,
		identity: capability.id,
		directoryRevision: projection.revision,
		...(capability.kind === "command"
			? {
					parameterHint:
						capability.parameters.length === 0 ? "无参数" : undefined,
				}
			: {}),
	}));
}

export function useConversationNativeMetadata({
	identityKey,
	conversationId,
	executionId,
	selector = "skills",
	enabled = true,
	client = defaultClient,
}: {
	readonly identityKey: string;
	readonly conversationId: string;
	readonly executionId?: string;
	readonly selector?: "commands" | "skills";
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
		],
		enabled: enabled && Boolean(identityKey && conversationId && executionId),
		retry: false,
		gcTime: 0,
		queryFn: async ({ signal }) => {
			if (!executionId) return undefined;
			const result = await readConversationNativeMetadataV1({
				client,
				path: { conversationId, executionId },
				query: { selector },
				signal,
				throwOnError: false,
			});
			signal.throwIfAborted();
			if (result.response?.status !== 200 || !result.data)
				throw new Error("Native metadata is unavailable");
			const parsed = NativeMetadataProjectionV1Schema.safeParse(result.data);
			if (!parsed.success || parsed.data.selector !== selector)
				throw new Error("Native metadata response is invalid");
			return parsed.data;
		},
	});
	const projection = enabled && !query.isError ? query.data : undefined;
	return {
		...query,
		isPending: enabled && query.isPending,
		isError: enabled && query.isError,
		capabilities: nativeMetadataCapabilities(projection),
		available: projection !== undefined,
	};
}
