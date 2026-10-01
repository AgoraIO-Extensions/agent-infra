import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";

import {
	loadMyAgentApplications,
	type MyAgentApplicationsState,
} from "./my-agent-applications.js";

export function useMyAgentApplications({
	identityKey,
	client,
}: {
	identityKey: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const selection = useMemo(
		() => ({
			queryKey: ["my-agents", identityKey, crypto.randomUUID()],
			active: false,
			client,
			queryClient,
		}),
		[queryClient, identityKey, client],
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
		queryFn: ({ signal }) => loadMyAgentApplications(selection.client, signal),
		enabled: (current) =>
			allowed &&
			(current.state.data?.kind !== "unavailable" ||
				current.state.data.retryable),
		retry: false,
	});
	function refetch() {
		const current =
			selection.queryClient.getQueryData<MyAgentApplicationsState>(
				selection.queryKey,
			);
		return selection.active &&
			allowed &&
			!(current?.kind === "unavailable" && !current.retryable)
			? query.refetch({ cancelRefetch: false })
			: Promise.resolve(undefined);
	}
	return { ...query, refetch, isFetching: allowed && query.isFetching };
}
