import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import {
	markUserRead,
	retainContent,
	retainedContentAt,
} from "../background-read.js";
import { type AdminAgentsState, loadAdminAgents } from "./admin-agents.js";

/** identityKey isolates a login generation; authorization remains server-owned. */
export function useAdminAgents({
	identityKey,
	enabled,
	client,
}: {
	identityKey: string;
	enabled: boolean;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const scope = useMemo(
		() => ({
			queryKey: ["admin-agents", identityKey, enabled, crypto.randomUUID()],
			client,
			active: false,
		}),
		[identityKey, enabled, client],
	);
	useLayoutEffect(() => {
		scope.active = true;
		return () => {
			scope.active = false;
			void queryClient.cancelQueries({ queryKey: scope.queryKey });
			queryClient.removeQueries({ queryKey: scope.queryKey });
		};
	}, [queryClient, scope]);
	const allowed = enabled && Boolean(identityKey);
	const query = useQuery({
		queryKey: scope.queryKey,
		queryFn: ({ signal }) => loadAdminAgents(scope.client, signal),
		enabled: (current) => allowed && current.state.data?.kind !== "denied",
		retry: false,
		networkMode: "always",
		gcTime: 0,
		staleTime: 0,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
	});
	const read: AdminAgentsState = query.isError
		? { kind: "error", retryable: true }
		: (query.data ?? { kind: "loading" });
	// 读取函数把 503 等可重试失败作为结果写入缓存（旧行随之移出）：回到标签页等后台重读失败时页面继续
	// 显示上一次的列表与筛选（#3387）；页头刷新、「重新加载」等用户发起的读取失败仍收起列表（D2-59）。
	const state: AdminAgentsState = !allowed
		? { kind: "denied" }
		: retainContent(scope, read, {
				isContent: (current) => current.kind === "ready",
				isRetryableFailure: (current) =>
					current.kind === "error" && current.retryable,
				updatedAt: query.isError ? query.errorUpdatedAt : query.dataUpdatedAt,
			});

	/** 用户发起的重读（页头刷新、「重新加载」、行内操作受理后的重读）。 */
	function refetch() {
		// Read the current cache so a callback retained before denial cannot retry.
		const current = queryClient.getQueryData<AdminAgentsState>(scope.queryKey);
		if (!scope.active || !allowed || current?.kind === "denied")
			return Promise.resolve(undefined);
		markUserRead(scope, retainedContentAt(scope));
		return query.refetch({ cancelRefetch: false });
	}
	/**
	 * 用户明确要求重读（例如「重新登录」后会话仍有效）：denied（401/403）会锁住 refetch，
	 * 这里重置本次查询解除锁定后重读一次（W-03），无权的读取仍由服务端拒绝；未锁定时
	 * 等同 refetch。
	 */
	function reload() {
		const current = queryClient.getQueryData<AdminAgentsState>(scope.queryKey);
		if (!scope.active || !allowed) return Promise.resolve();
		if (current?.kind === "denied")
			return queryClient.resetQueries({
				queryKey: scope.queryKey,
				exact: true,
			});
		markUserRead(scope, retainedContentAt(scope));
		return query.refetch({ cancelRefetch: false });
	}
	return { state, isFetching: allowed && query.isFetching, refetch, reload };
}
