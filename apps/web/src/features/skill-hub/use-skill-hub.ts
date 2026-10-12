import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import {
	isRetryableSkillHubError,
	loadSkillHubDirectory,
	loadSkillHubVersion,
	type SkillHubDirectoryState,
	type SkillHubVersionState,
} from "./skill-hub.js";

export function useSkillHubDirectory({
	identityKey,
	client,
}: {
	identityKey: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const selection = useMemo(
		() => ({
			queryKey: ["skill-hub", "directory", identityKey, crypto.randomUUID()],
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
		queryFn: ({ signal }) => loadSkillHubDirectory(selection.client, signal),
		enabled: (current) =>
			allowed &&
			(current.state.data?.kind !== "unavailable" ||
				current.state.data.retryable),
		retry: false,
	});
	function refetch() {
		const current = selection.queryClient.getQueryData<SkillHubDirectoryState>(
			selection.queryKey,
		);
		return selection.active &&
			allowed &&
			!(current?.kind === "unavailable" && !current.retryable)
			? query.refetch({ cancelRefetch: false })
			: Promise.resolve(undefined);
	}
	const retryable =
		query.error !== null
			? isRetryableSkillHubError(query.error)
			: query.data?.kind === "unavailable" && query.data.retryable;
	return {
		...query,
		refetch,
		isFetching: allowed && query.isFetching,
		retryable: Boolean(retryable),
	};
}

export function useSkillHubVersion({
	identityKey,
	skillVersionId,
	client,
}: {
	identityKey: string;
	skillVersionId: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const selection = useMemo(
		() => ({
			queryKey: [
				"skill-hub",
				"version",
				skillVersionId,
				identityKey,
				crypto.randomUUID(),
			],
			active: false,
			client,
			queryClient,
		}),
		[queryClient, skillVersionId, identityKey, client],
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
	const allowed = Boolean(identityKey && skillVersionId);
	const query = useQuery({
		queryKey: selection.queryKey,
		queryFn: ({ signal }) =>
			loadSkillHubVersion(skillVersionId, selection.client, signal),
		enabled: (current) =>
			allowed &&
			(current.state.data?.kind !== "unavailable" ||
				current.state.data.retryable),
		retry: false,
	});
	function refetch() {
		const current = selection.queryClient.getQueryData<SkillHubVersionState>(
			selection.queryKey,
		);
		return selection.active &&
			allowed &&
			!(current?.kind === "unavailable" && !current.retryable)
			? query.refetch({ cancelRefetch: false })
			: Promise.resolve(undefined);
	}
	const retryable =
		query.error !== null
			? isRetryableSkillHubError(query.error)
			: query.data?.kind === "unavailable" && query.data.retryable;
	return {
		...query,
		refetch,
		isFetching: allowed && query.isFetching,
		retryable: Boolean(retryable),
	};
}
