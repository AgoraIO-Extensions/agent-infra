import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useLayoutEffect, useMemo, useState } from "react";
import {
	markUserRead,
	queryUserReading,
	readFailed,
} from "../background-read.js";
import {
	type AuditFilters,
	AuditReadError,
	type AuditReadFailure,
	type AuditScope,
	loadAuditDetail,
	loadAuditPage,
} from "./audit-query.js";

/** 登录失效、无权与响应无效会锁定读取（blocked）；其余失败（网络、服务）可以重试。 */
function retryableAuditError(error: unknown) {
	return !(
		error instanceof AuditReadError &&
		(error.failure.kind === "authorization" || error.failure.kind === "invalid")
	);
}

/** identityKey isolates a login lifetime; it is never sent as authority. */
export function useAuditQuery({
	identityKey,
	scope: requestedScope,
	filters = {},
	auditId = null,
	transport,
	baseUrl,
}: {
	identityKey: string;
	scope: AuditScope;
	filters?: AuditFilters;
	auditId?: string | null;
	transport?: typeof globalThis.fetch;
	baseUrl?: string;
}) {
	const queryClient = useQueryClient();
	const instanceId = useId();
	const filterKey = JSON.stringify({
		from: filters.from,
		until: filters.until,
		principalKind: filters.principalKind,
		principalId: filters.principalId,
		agentId: filters.agentId,
		action: filters.action,
		result: filters.result,
		executionId: filters.executionId,
	});
	const scope = useMemo(
		() => ({
			queryKey: [
				"audit-query",
				instanceId,
				identityKey,
				requestedScope,
				crypto.randomUUID(),
			],
			filters: JSON.parse(filterKey) as AuditFilters,
			transport,
			baseUrl,
			active: false,
			blocked: null as AuditReadFailure | null,
			cursors: [null] as (string | null)[],
			page: 0,
			/** 详情读取的用户发起标记（列表的标记记在 scope 本身，见 background-read）。 */
			detailRead: {},
		}),
		// Semantically equal filter objects retain the same paging lifetime.
		[instanceId, identityKey, requestedScope, filterKey, transport, baseUrl],
	);
	const [, render] = useState(0);
	const clear = useCallback(() => {
		void queryClient.cancelQueries({ queryKey: scope.queryKey });
		queryClient.removeQueries({ queryKey: scope.queryKey });
	}, [queryClient, scope]);
	const block = useCallback(
		(failure: AuditReadFailure) => {
			if (!scope.active || scope.blocked) return;
			scope.blocked = failure;
			clear();
			render((value) => value + 1);
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
	const enabled = Boolean(identityKey) && !scope.blocked;
	const cursor = scope.cursors[scope.page];
	async function read<T>(signal: AbortSignal, load: () => Promise<T>) {
		if (scope.blocked) throw new AuditReadError(scope.blocked);
		try {
			return await load();
		} catch (error) {
			if (
				!signal.aborted &&
				error instanceof AuditReadError &&
				["authorization", "invalid"].includes(error.failure.kind)
			)
				block(error.failure);
			throw error;
		}
	}
	const options = {
		retry: false,
		networkMode: "always" as const,
		gcTime: 0,
		staleTime: 0,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
		placeholderData: undefined,
	};
	const page = useQuery({
		...options,
		queryKey: [...scope.queryKey, "page", cursor],
		enabled,
		queryFn: ({ signal }) =>
			read(signal, async () => {
				const result = await loadAuditPage({
					scope: requestedScope,
					filters: scope.filters,
					cursor,
					signal,
					transport: scope.transport,
					baseUrl: scope.baseUrl,
				});
				if (
					result.nextCursor !== null &&
					scope.cursors.slice(0, scope.page + 1).includes(result.nextCursor)
				)
					throw new AuditReadError({ kind: "invalid" });
				return result;
			}),
	});
	const detail = useQuery({
		...options,
		queryKey: [...scope.queryKey, "detail", auditId],
		enabled: enabled && Boolean(auditId),
		queryFn: ({ signal }) =>
			read(signal, () =>
				loadAuditDetail({
					scope: requestedScope,
					filters: scope.filters,
					auditId: auditId ?? "",
					signal,
					transport: scope.transport,
					baseUrl: scope.baseUrl,
				}),
			),
	});
	// 回到标签页等后台重读失败时保留已读的记录与详情（#3387）；用户发起的「查询」「重置」「刷新审计记录」
	// 「重试」与「刷新审计详情」「重试详情」失败仍按 D2-59 显示失败。
	const failure =
		scope.blocked ??
		(readFailed(page, retryableAuditError, scope) &&
		page.error instanceof AuditReadError
			? page.error.failure
			: null);
	const detailFailure =
		scope.blocked ??
		(readFailed(detail, retryableAuditError, scope.detailRead) &&
		detail.error instanceof AuditReadError
			? detail.error.failure
			: null);
	// 用户发起的列表读取进行中（后台重读不算）：页面据此显示读取行。
	const userReading = enabled && queryUserReading(page, scope);
	function status(pending: boolean, error: AuditReadFailure | null) {
		return !identityKey
			? ("idle" as const)
			: error?.kind === "authorization"
				? ("denied" as const)
				: error
					? ("error" as const)
					: pending
						? ("loading" as const)
						: ("ready" as const);
	}
	function changePage(next: boolean) {
		if (
			!scope.active ||
			!enabled ||
			scope.blocked ||
			failure ||
			// 后台重读进行中仍可翻页（已读记录照常显示）；没有记录或用户发起的读取进行中时不翻页。
			!page.data ||
			userReading ||
			cursor !== scope.cursors[scope.page]
		)
			return false;
		if (next) {
			if (!page.data?.nextCursor) return false;
			scope.cursors.splice(
				scope.page + 1,
				Number.POSITIVE_INFINITY,
				page.data.nextCursor,
			);
			scope.page += 1;
		} else {
			if (scope.page === 0) return false;
			scope.page -= 1;
		}
		render((value) => value + 1);
		return true;
	}
	/** 用户发起的列表重读（「刷新审计记录」、条件不变的「查询」「重置」、「重试」）。 */
	function refresh() {
		if (!scope.active || !enabled || scope.blocked || userReading)
			return Promise.resolve(undefined);
		markUserRead(scope, page.dataUpdatedAt);
		// 后台重读进行中时并入它（cancelRefetch: false），读取行一直显示到它完成。
		return page.refetch({ cancelRefetch: false });
	}
	return {
		status: status(page.isPending, failure),
		items: enabled && !failure ? (page.data?.items ?? []) : [],
		failure,
		isFetching: enabled && page.isFetching,
		userReading,
		pageNumber: scope.page + 1,
		canPreviousPage: enabled && !failure && scope.page > 0,
		hasNextPage: enabled && !failure && Boolean(page.data?.nextCursor),
		previousPage: () => changePage(false),
		nextPage: () => changePage(true),
		canRetry: enabled && !page.isFetching && Boolean(failure),
		retry: refresh,
		refresh,
		detail: enabled && !detailFailure ? detail.data : undefined,
		detailStatus: auditId
			? status(detail.isPending, detailFailure)
			: ("idle" as const),
		detailFailure,
		isDetailFetching: enabled && detail.isFetching,
		isDetailUserReading: enabled && queryUserReading(detail, scope.detailRead),
		/** 用户发起的详情重读（「刷新审计详情」「重试详情」）。 */
		retryDetail: () => {
			if (
				!scope.active ||
				!enabled ||
				scope.blocked ||
				!auditId ||
				detail.isFetching
			)
				return Promise.resolve(undefined);
			markUserRead(scope.detailRead, detail.dataUpdatedAt);
			return detail.refetch({ cancelRefetch: false });
		},
		revoke: () => block({ kind: "authorization" }),
	};
}
