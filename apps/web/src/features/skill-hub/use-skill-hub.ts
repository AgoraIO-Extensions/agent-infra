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
import { listSkillHubProjects } from "./skill-hub-management.js";

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

/**
 * 当前用户自己的 Skill 项目（服务端只返回本人项目，projectId 即 skillId）。
 * 读取失败时调用方按「不是创建者」处理，不显示创建者操作。
 */
export function useSkillHubProjects({
	identityKey,
	client,
}: {
	identityKey: string;
	client?: Client;
}) {
	return useQuery({
		queryKey: ["skill-hub", "projects", identityKey],
		queryFn: () => listSkillHubProjects(client),
		enabled: Boolean(identityKey),
		retry: false,
	});
}
