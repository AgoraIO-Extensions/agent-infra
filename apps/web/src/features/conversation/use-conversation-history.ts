import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useLayoutEffect, useMemo, useState } from "react";
import type { Client } from "../../pilot/generated/client/index.js";
import { loadConversationHistoryPage } from "./conversation-history.js";
import {
	ConversationReadError,
	type ConversationReadFailure,
} from "./execution-detail.js";

/** identityKey changes on every login/logout/principal change, including a new
 * login by the same user. It isolates cache lifetime; it is not authorization. */
export function useConversationHistory({
	identityKey,
	agentId,
	client,
}: {
	identityKey: string;
	agentId: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const instanceId = useId();
	const scope = useMemo(
		() => ({
			queryKey: [
				"conversation-history",
				instanceId,
				identityKey,
				agentId,
				crypto.randomUUID(),
			],
			client,
			active: false,
			pending: false,
			blocked: null as ConversationReadFailure | null,
		}),
		[instanceId, identityKey, agentId, client],
	);
	const [, render] = useState(0);
	const clear = useCallback(() => {
		void queryClient.cancelQueries({ queryKey: scope.queryKey, exact: true });
		queryClient.removeQueries({ queryKey: scope.queryKey, exact: true });
	}, [queryClient, scope]);
	const block = useCallback(
		(failure: ConversationReadFailure) => {
			if (!scope.active) return;
			scope.blocked = failure;
			clear();
			render((revision) => revision + 1);
		},
		[scope, clear],
	);
	useLayoutEffect(() => {
		scope.active = true;
		return () => {
			scope.active = false;
			clear();
		};
	}, [scope, clear]);

	const query = useInfiniteQuery({
		queryKey: scope.queryKey,
		enabled: Boolean(identityKey && agentId) && !scope.blocked,
		initialPageParam: null as string | null,
		queryFn: async ({ pageParam, signal }) => {
			if (scope.blocked) throw new ConversationReadError(scope.blocked);
			try {
				return await loadConversationHistoryPage({
					agentId,
					cursor: pageParam,
					signal,
					client: scope.client,
				});
			} catch (error) {
				if (
					!signal.aborted &&
					error instanceof ConversationReadError &&
					["authorization", "invalid"].includes(error.failure.kind)
				)
					block(error.failure);
				throw error;
			}
		},
		// Query supplies the in-progress refetch chain here; its public cache may
		// still contain the previous chain until the entire refetch completes.
		getNextPageParam: (page, _pages, _pageParam, pageParams) =>
			pageParams.includes(page.nextCursor) ? null : page.nextCursor,
		select: (data) => {
			const cursor = data.pages.at(-1)?.nextCursor;
			if (cursor != null && data.pageParams.includes(cursor))
				throw new ConversationReadError({ kind: "invalid" });
			return data;
		},
		retry: false,
		networkMode: "always",
		gcTime: 0,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		placeholderData: undefined,
	});
	useLayoutEffect(() => {
		if (
			query.error instanceof ConversationReadError &&
			query.error.failure.kind === "invalid"
		)
			block(query.error.failure);
	}, [query.error, block]);
	const items = useMemo(() => {
		const seen = new Set<string>();
		return (
			query.data?.pages.flatMap((page) =>
				page.items.filter((item) => {
					if (seen.has(item.conversationId)) return false;
					seen.add(item.conversationId);
					return true;
				}),
			) ?? []
		);
	}, [query.data]);
	const failure =
		scope.blocked ??
		(query.error instanceof ConversationReadError ? query.error.failure : null);
	const allowed =
		Boolean(identityKey && agentId) &&
		!scope.blocked &&
		failure?.kind !== "invalid";
	const canRetry =
		allowed &&
		query.isError &&
		(failure?.kind === "network" || failure?.kind === "service");

	async function read(next: boolean) {
		if (
			!scope.active ||
			!allowed ||
			scope.blocked ||
			scope.pending ||
			queryClient.getQueryState(scope.queryKey)?.fetchStatus === "fetching"
		)
			return false;
		scope.pending = true;
		try {
			if (next) await query.fetchNextPage({ cancelRefetch: false });
			else await query.refetch({ cancelRefetch: false });
			return true;
		} finally {
			scope.pending = false;
		}
	}
	return {
		status:
			!identityKey || !agentId
				? ("idle" as const)
				: failure?.kind === "authorization"
					? ("denied" as const)
					: failure
						? ("error" as const)
						: query.isPending
							? ("loading" as const)
							: ("ready" as const),
		items: allowed ? items : [],
		failure,
		isFetching: allowed && query.isFetching,
		hasNextPage: allowed && !query.isError && query.hasNextPage,
		canRetry: canRetry && !query.isFetching,
		loadMore: () =>
			query.hasNextPage && !query.isError ? read(true) : Promise.resolve(false),
		retry: () =>
			canRetry ? read(query.isFetchNextPageError) : Promise.resolve(false),
		revoke: () => block({ kind: "authorization" }),
	};
}
