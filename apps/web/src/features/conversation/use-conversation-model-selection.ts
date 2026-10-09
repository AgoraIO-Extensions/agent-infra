import { ConversationModelSelectionProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { getConversationModelSelection } from "../../pilot/generated/sdk.gen.js";
import type { ConversationModelSelectionProjectionV1 } from "../../pilot/generated/types.gen.js";
import { ConversationReadError, responseFailure } from "./execution-detail.js";

/** Reads the Runtime-owned directory without carrying native ACP details into
 * the component. A custom Runtime failure remains unavailable; callers must
 * not fall back to the static Owner model configuration in that mode. */
export function useConversationModelSelection({
	conversationId,
	identityKey,
	enabled = true,
}: {
	conversationId: string;
	identityKey: string;
	enabled?: boolean;
}) {
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => ["conversation-model-selection", identityKey, conversationId],
		[identityKey, conversationId],
	);
	const query = useQuery({
		queryKey,
		enabled: Boolean(identityKey && conversationId && enabled),
		retry: false,
		gcTime: 0,
		staleTime: 0,
		queryFn: async ({ signal }) => {
			const result = await getConversationModelSelection({
				path: { conversationId },
				signal,
				responseStyle: "fields",
				throwOnError: false,
			});
			signal.throwIfAborted();
			if (!result.data || result.response?.status !== 200)
				throw new ConversationReadError(
					responseFailure(result.error, result.response?.status),
				);
			const parsed = ConversationModelSelectionProjectionV1Schema.safeParse(
				result.data,
			);
			if (!parsed.success || parsed.data.conversationId !== conversationId)
				throw new ConversationReadError({ kind: "invalid" });
			return parsed.data as ConversationModelSelectionProjectionV1;
		},
	});
	const refresh = useCallback(async () => {
		if (!identityKey || !conversationId || !enabled) return undefined;
		return queryClient.fetchQuery({
			queryKey,
			queryFn: async ({ signal }) => {
				const result = await getConversationModelSelection({
					path: { conversationId },
					signal,
					responseStyle: "fields",
					throwOnError: false,
				});
				if (!result.data || result.response?.status !== 200)
					throw new ConversationReadError(
						responseFailure(result.error, result.response?.status),
					);
				const parsed = ConversationModelSelectionProjectionV1Schema.safeParse(
					result.data,
				);
				if (!parsed.success || parsed.data.conversationId !== conversationId)
					throw new ConversationReadError({ kind: "invalid" });
				return parsed.data as ConversationModelSelectionProjectionV1;
			},
			staleTime: 0,
		});
	}, [conversationId, enabled, identityKey, queryClient, queryKey]);
	return { ...query, refresh };
}
