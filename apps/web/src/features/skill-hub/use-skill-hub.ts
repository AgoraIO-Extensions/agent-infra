import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import { markUserRead, readFailed } from "../background-read.js";
import type { CollectionReadUnavailable } from "../collection-read-failure.js";
import {
	isRetryableSkillHubError,
	loadOwnedSkillHubVersions,
	loadSkillHubDirectory,
	loadSkillHubInstallations,
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
	/** 页面发起的重读（恢复按钮、安装与撤销后的回读）：失败时按读取失败显示（D2-59）。 */
	function refetch() {
		const current = selection.queryClient.getQueryData<T>(selection.queryKey);
		if (
			!selection.active ||
			!allowed ||
			(current?.kind === "unavailable" && !current.retryable)
		)
			return Promise.resolve(undefined);
		markUserRead(selection, query.dataUpdatedAt);
		return query.refetch({ cancelRefetch: false });
	}
	const retryable =
		query.error !== null
			? isRetryableSkillHubError(query.error)
			: query.data?.kind === "unavailable" && query.data.retryable;
	/**
	 * 用户明确要求重读（「重新登录」后会话仍有效）：不可重试的结果（401 等）锁住 refetch，这里重置
	 * 本次查询解除锁定后重读一次（W-03，同 Agent 目录）；未锁定时等同 refetch。
	 */
	function reload() {
		const current = selection.queryClient.getQueryData<T>(selection.queryKey);
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
		retryable: Boolean(retryable),
		/** 是否按读取失败替换内容：回到标签页等后台重读的可重试失败保留已显示的内容（#3387）。 */
		failed: readFailed(query, isRetryableSkillHubError, selection),
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

/** 当前用户在我的库中的安装（「我的安装」）。 */
export function useSkillHubInstallations({
	identityKey,
	client,
}: {
	identityKey: string;
	client?: Client;
}) {
	return useIsolatedSkillHubRead({
		scope: ["skill-hub", "installations", identityKey],
		allowed: Boolean(identityKey),
		client,
		load: (current, signal) => loadSkillHubInstallations(current, signal),
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
