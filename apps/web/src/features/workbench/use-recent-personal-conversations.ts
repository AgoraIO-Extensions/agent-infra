import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import type { CollectionReadUnavailable } from "../collection-read-failure.js";
import {
	invalidRecentPage,
	loadRecentPersonalConversationsPage,
	RecentPersonalConversationsError,
} from "./recent-personal-conversations.js";
import type { WorkbenchRecentState } from "./workbench-screen.js";

export function useRecentPersonalConversations({
	identityKey,
	client,
}: {
	identityKey: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const scope = useMemo(
		() => ({
			queryKey: ["personal-recent", identityKey, crypto.randomUUID()],
			active: false,
			pending: false,
			client,
			queryClient,
			blocked: null as CollectionReadUnavailable | null,
		}),
		[identityKey, client, queryClient],
	);
	const [, render] = useState(0);
	const clear = useCallback(() => {
		void queryClient.cancelQueries({ queryKey: scope.queryKey, exact: true });
		queryClient.removeQueries({ queryKey: scope.queryKey, exact: true });
	}, [queryClient, scope]);
	const block = useCallback(
		(state: CollectionReadUnavailable) => {
			if (!scope.active || scope.blocked) return;
			scope.blocked = state;
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
		enabled: Boolean(identityKey) && !scope.blocked,
		initialPageParam: null as string | null,
		queryFn: async ({ pageParam, signal }) => {
			try {
				return await loadRecentPersonalConversationsPage({
					cursor: pageParam,
					signal,
					client: scope.client,
				});
			} catch (error) {
				if (
					!signal.aborted &&
					error instanceof RecentPersonalConversationsError &&
					!error.state.retryable
				)
					block(error.state);
				throw error;
			}
		},
		getNextPageParam: (page, _pages, _pageParam, pageParams) => {
			if (page.nextCursor !== null && pageParams.includes(page.nextCursor)) {
				queueMicrotask(() => block(invalidRecentPage().state));
				return null;
			}
			return page.nextCursor;
		},
		retry: false,
		networkMode: "always",
		gcTime: 0,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const failure =
		scope.blocked ??
		(query.error instanceof RecentPersonalConversationsError
			? query.error.state
			: query.isError
				? { kind: "unavailable" as const, retryable: true }
				: null);
	const seen = new Set<string>();
	const state: WorkbenchRecentState = !identityKey
		? { kind: "unavailable", retryable: false }
		: (failure ??
			(query.isPending
				? { kind: "loading" }
				: {
						kind: "ready",
						// Live pages can overlap after updates; keep first occurrence in
						// received order, without sorting or scanning per-Agent history.
						conversations:
							query.data?.pages.flatMap((page) =>
								page.items.filter((item) => {
									if (seen.has(item.conversationId)) return false;
									seen.add(item.conversationId);
									return true;
								}),
							) ?? [],
						nextCursor: query.data?.pages.at(-1)?.nextCursor ?? null,
					}));

	async function read(next: boolean) {
		const current = queryClient.getQueryState(scope.queryKey);
		if (
			!scope.active ||
			!identityKey ||
			scope.blocked ||
			scope.pending ||
			current?.fetchStatus === "fetching" ||
			(next && (current?.status !== "success" || !query.hasNextPage))
		)
			return;
		scope.pending = true;
		try {
			if (next) await query.fetchNextPage({ cancelRefetch: false });
			// Refresh/retry starts a current first page, discarding old cursors.
			else
				await queryClient.resetQueries({
					queryKey: scope.queryKey,
					exact: true,
				});
		} finally {
			scope.pending = false;
		}
	}
	return {
		state,
		isFetching: Boolean(identityKey) && !scope.blocked && query.isFetching,
		refresh: () => read(false),
		loadMore: () => read(true),
	};
}
