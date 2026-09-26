import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useLayoutEffect, useMemo, useState } from "react";
import type { Client } from "../../pilot/generated/client/index.js";
import {
	type AuditFilters,
	AuditReadError,
	type AuditReadFailure,
	type AuditScope,
	loadAuditDetail,
	loadAuditPage,
} from "./audit-query.js";

/** identityKey isolates a login lifetime; it is never sent as authority. */
export function useAuditQuery({
	identityKey,
	scope: requestedScope,
	filters = {},
	auditId = null,
	client,
}: {
	identityKey: string;
	scope: AuditScope;
	filters?: AuditFilters;
	auditId?: string | null;
	client?: Client;
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
			client,
			active: false,
			blocked: null as AuditReadFailure | null,
			cursors: [null] as (string | null)[],
			page: 0,
		}),
		// Semantically equal filter objects retain the same paging lifetime.
		[instanceId, identityKey, requestedScope, filterKey, client],
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
					client: scope.client,
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
					client: scope.client,
				}),
			),
	});
	const failure =
		scope.blocked ??
		(page.error instanceof AuditReadError ? page.error.failure : null);
	const detailFailure =
		scope.blocked ??
		(detail.error instanceof AuditReadError ? detail.error.failure : null);
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
			page.isFetching ||
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
	function refresh() {
		return scope.active && enabled && !scope.blocked && !page.isFetching
			? page.refetch({ cancelRefetch: false })
			: Promise.resolve(undefined);
	}
	return {
		status: status(page.isPending, failure),
		items: enabled && !failure ? (page.data?.items ?? []) : [],
		failure,
		isFetching: enabled && page.isFetching,
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
		retryDetail: () =>
			scope.active && enabled && !scope.blocked && auditId && !detail.isFetching
				? detail.refetch({ cancelRefetch: false })
				: Promise.resolve(undefined),
		revoke: () => block({ kind: "authorization" }),
	};
}
