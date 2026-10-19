import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import type { CollectionReadUnavailable } from "../collection-read-failure.js";
import {
	isRetryableSkillHubError,
	loadOwnedSkillHubVersions,
	loadSkillHubDirectory,
	loadSkillHubVersion,
} from "./skill-hub.js";
import { listSkillHubProjects } from "./skill-hub-management.js";

/**
 * 每次挂载使用独立的查询键，卸载时取消并移除，避免换身份或换页后复用旧主体的数据；
 * 不可重试的失败不再自动重读。
 */
function useIsolatedSkillHubRead<
	T extends { kind: "ready" } | CollectionReadUnavailable,
>({
	scope,
	allowed,
	client,
	load,
}: {
	scope: readonly string[];
	allowed: boolean;
	client?: Client;
	load: (client: Client | undefined, signal: AbortSignal) => Promise<T>;
}) {
	const queryClient = useQueryClient();
	const scopeKey = JSON.stringify(scope);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey 是 scope 的稳定序列化，读取函数随 scope 变化。
	const selection = useMemo(
		() => ({
			queryKey: [...scope, crypto.randomUUID()],
			active: false,
			client,
			queryClient,
			load,
		}),
		[queryClient, scopeKey, client],
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
	const query = useQuery({
		queryKey: selection.queryKey,
		queryFn: ({ signal }) => selection.load(selection.client, signal),
		enabled: (current) =>
			allowed &&
			(current.state.data?.kind !== "unavailable" ||
				current.state.data.retryable),
		retry: false,
	});
	function refetch() {
		const current = selection.queryClient.getQueryData<T>(selection.queryKey);
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

export function useSkillHubDirectory({
	identityKey,
	client,
}: {
	identityKey: string;
	client?: Client;
}) {
	return useIsolatedSkillHubRead({
		scope: ["skill-hub", "directory", identityKey],
		allowed: Boolean(identityKey),
		client,
		load: (current, signal) => loadSkillHubDirectory(current, signal),
	});
}

/** 当前用户自己的全部版本（含非已发布状态）。 */
export function useOwnedSkillHubVersions({
	identityKey,
	client,
}: {
	identityKey: string;
	client?: Client;
}) {
	return useIsolatedSkillHubRead({
		scope: ["skill-hub", "owned-versions", identityKey],
		allowed: Boolean(identityKey),
		client,
		load: (current, signal) => loadOwnedSkillHubVersions(current, signal),
	});
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
	return useIsolatedSkillHubRead({
		scope: ["skill-hub", "version", skillVersionId, identityKey],
		allowed: Boolean(identityKey && skillVersionId),
		client,
		load: (current, signal) =>
			loadSkillHubVersion(skillVersionId, current, signal),
	});
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
