import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";

import {
	isRetryableAgentAdministrationError,
	loadPendingAgentApplications,
	type PendingAgentApplicationsState,
} from "./agent-administration.js";

export function usePendingAgentApplications({
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
			queryKey: [
				"admin",
				"agent-applications",
				identityKey,
				enabled,
				crypto.randomUUID(),
			],
			active: false,
			client,
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
		queryFn: ({ signal }) => loadPendingAgentApplications(scope.client, signal),
		enabled: (current) =>
			allowed &&
			(current.state.data?.kind !== "unavailable" ||
				current.state.data.retryable),
		retry: false,
	});
	function refetch() {
		const current = queryClient.getQueryData<PendingAgentApplicationsState>(
			scope.queryKey,
		);
		return scope.active &&
			allowed &&
			!(current?.kind === "unavailable" && !current.retryable)
			? query.refetch({ cancelRefetch: false })
			: Promise.resolve(undefined);
	}

	return {
		...query,
		refetch,
		isFetching: allowed && query.isFetching,
		state: !allowed
			? ({ kind: "unavailable", retryable: false } as const)
			: query.isPending
				? ({ kind: "loading" } as const)
				: query.isError || !query.data
					? ({
							kind: "unavailable",
							retryable:
								(query.isError &&
									isRetryableAgentAdministrationError(query.error)) ||
								false,
						} as const)
					: query.data,
	};
}
