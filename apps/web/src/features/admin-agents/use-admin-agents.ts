import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
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
	const state: AdminAgentsState = !allowed
		? { kind: "denied" }
		: query.isError
			? { kind: "error", retryable: true }
			: (query.data ?? { kind: "loading" });

	function refetch() {
		// Read the current cache so a callback retained before denial cannot retry.
		const current = queryClient.getQueryData<AdminAgentsState>(scope.queryKey);
		return scope.active && allowed && current?.kind !== "denied"
			? query.refetch({ cancelRefetch: false })
			: Promise.resolve(undefined);
	}
	/**
	 * 用户明确要求重读（例如「重新登录」后会话仍有效）：denied（401/403）会锁住 refetch，
	 * 这里重置本次查询解除锁定后重读一次（W-03），无权的读取仍由服务端拒绝；未锁定时
	 * 等同 refetch。
	 */
	function reload() {
		const current = queryClient.getQueryData<AdminAgentsState>(scope.queryKey);
		if (!scope.active || !allowed) return Promise.resolve();
		return current?.kind === "denied"
			? queryClient.resetQueries({ queryKey: scope.queryKey, exact: true })
			: query.refetch({ cancelRefetch: false });
	}
	return { state, isFetching: allowed && query.isFetching, refetch, reload };
}
