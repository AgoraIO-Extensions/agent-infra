import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import { markUserRead, readFailed } from "../background-read.js";
import type {
	AgentDiscoveryScope,
	AgentDiscoveryState,
} from "./agent-discovery.js";
import {
	isRetryableAgentDiscoveryError,
	loadAgentDiscovery,
} from "./agent-discovery.js";

export function useAgentDiscovery({
	identityKey,
	scope = "visible",
	client,
}: {
	identityKey: string;
	scope?: AgentDiscoveryScope;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const selection = useMemo(
		() => ({
			queryKey: ["agents", scope, identityKey, crypto.randomUUID()],
			active: false,
			client,
			queryClient,
		}),
		[queryClient, scope, identityKey, client],
	);
	useLayoutEffect(() => {
		selection.active = true;
		return () => {
			selection.active = false;
			void selection.queryClient.cancelQueries({
				queryKey: selection.queryKey,
				exact: true,
			});
			selection.queryClient.removeQueries({
				queryKey: selection.queryKey,
				exact: true,
			});
		};
	}, [selection]);
	const allowed = Boolean(identityKey);
	const query = useQuery({
		queryKey: selection.queryKey,
		queryFn: ({ signal }) =>
			loadAgentDiscovery(selection.client, scope, signal),
		enabled: (current) =>
			allowed &&
			(current.state.data?.kind !== "unavailable" ||
				current.state.data.retryable),
		retry: false,
	});
	/** 页面发起的重读（恢复按钮、工作台「重新加载…」）：失败时按读取失败显示（D2-59）。 */
	function refetch() {
		const current = selection.queryClient.getQueryData<AgentDiscoveryState>(
			selection.queryKey,
		);
		if (
			!selection.active ||
			!allowed ||
			(current?.kind === "unavailable" && !current.retryable)
		)
			return Promise.resolve(undefined);
		markUserRead(selection, query.dataUpdatedAt);
		return query.refetch({ cancelRefetch: false });
	}
	/**
	 * 用户明确要求重读（例如「重新登录」后会话仍有效）：不可重试的结果会锁住 refetch，
	 * 这里重置本次查询解除锁定后重读一次（W-03）；未锁定时等同 refetch。
	 */
	function reload() {
		const current = selection.queryClient.getQueryData<AgentDiscoveryState>(
			selection.queryKey,
		);
		if (!selection.active || !allowed) return Promise.resolve();
		if (current?.kind === "unavailable" && !current.retryable)
			return selection.queryClient.resetQueries({
				queryKey: selection.queryKey,
				exact: true,
			});
		markUserRead(selection, query.dataUpdatedAt);
		return query.refetch({ cancelRefetch: false });
	}
	return {
		...query,
		refetch,
		reload,
		isFetching: allowed && query.isFetching,
		/** 是否按读取失败替换内容：后台重读的可重试失败保留已显示的 Agent（#3387）。 */
		failed: readFailed(query, isRetryableAgentDiscoveryError, selection),
	};
}
