import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import type {
	PersonalApiCredentialIssueRequestV1,
	PersonalApiCredentialMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	markUserRead,
	retainContent,
	retainedContentAt,
} from "../background-read.js";
import {
	type ApiCredentialsState,
	issuePersonalApiCredential,
	loadPersonalApiCredentials,
	narrowPersonalApiCredential,
	revokePersonalApiCredential,
} from "./api-credentials.js";

function keyFor(prefix: string, value: string) {
	return ["api-credentials", prefix, value] as const;
}

export function useApiCredentials({
	identityKey,
	client,
}: {
	identityKey: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const scope = useMemo(
		() => ({
			queryKey: keyFor("list", `${identityKey}:${crypto.randomUUID()}`),
			active: false,
			client,
		}),
		[identityKey, client],
	);
	useLayoutEffect(() => {
		scope.active = true;
		return () => {
			scope.active = false;
			void queryClient.cancelQueries({ queryKey: scope.queryKey, exact: true });
			queryClient.removeQueries({ queryKey: scope.queryKey, exact: true });
		};
	}, [queryClient, scope]);
	const allowed = Boolean(identityKey);
	const query = useQuery({
		queryKey: scope.queryKey,
		queryFn: ({ signal }) => loadPersonalApiCredentials(scope.client, signal),
		enabled: (current) =>
			allowed &&
			(current.state.data?.kind !== "unavailable" ||
				current.state.data.retryable),
		retry: false,
		staleTime: 15_000,
	});
	const queryFailure: ApiCredentialsState | null = query.error
		? {
				kind: "unavailable",
				retryable:
					!(query.error instanceof Error) ||
					!("retryable" in query.error) ||
					query.error.retryable !== false,
			}
		: null;
	const read: ApiCredentialsState | { kind: "loading" } = queryFailure ??
		query.data ?? { kind: "loading" };
	// 读取函数把 503 等可重试失败作为结果写入缓存：回到标签页、签发或撤销后的重读失败时继续显示
	// 上一次的凭证列表（#3387）；没有读到过列表或 401 等不可重试的失败照常显示。
	const state: ApiCredentialsState | { kind: "denied" | "loading" } = !allowed
		? { kind: "denied" }
		: retainContent(scope, read, {
				isContent: (current) => current.kind === "ready",
				isRetryableFailure: (current) =>
					current.kind === "unavailable" && current.retryable,
				updatedAt: query.error ? query.errorUpdatedAt : query.dataUpdatedAt,
			});
	/** 页面发起的重读（「重新加载」、签发与撤销后的回读）：失败时按读取失败显示。 */
	async function refetch() {
		const current = queryClient.getQueryData<ApiCredentialsState>(
			scope.queryKey,
		);
		if (
			!scope.active ||
			!allowed ||
			(current?.kind === "unavailable" && !current.retryable)
		)
			return undefined;
		markUserRead(scope, retainedContentAt(scope));
		return query.refetch({ cancelRefetch: false });
	}
	/**
	 * 用户明确要求重读（「重新登录」后会话仍有效）：不可重试的结果（401 等）锁住 refetch，这里重置
	 * 本次查询解除锁定后重读一次（W-03，同 Agent 目录）；未锁定时等同 refetch。
	 */
	async function reload() {
		const current = queryClient.getQueryData<ApiCredentialsState>(
			scope.queryKey,
		);
		if (!scope.active || !allowed) return undefined;
		if (current?.kind === "unavailable" && !current.retryable)
			return queryClient.resetQueries({
				queryKey: scope.queryKey,
				exact: true,
			});
		markUserRead(scope, retainedContentAt(scope));
		return query.refetch({ cancelRefetch: false });
	}
	return { state, isFetching: allowed && query.isFetching, refetch, reload };
}

type IssueAttempt = {
	body: PersonalApiCredentialIssueRequestV1;
	idempotencyKey: string;
};

function sameIssueBody(
	left: PersonalApiCredentialIssueRequestV1,
	right: PersonalApiCredentialIssueRequestV1,
) {
	return (
		left.expiresAt === right.expiresAt &&
		left.scopes.length === right.scopes.length &&
		left.scopes.every((scope) => right.scopes.includes(scope))
	);
}

export function useIssuePersonalApiCredential(client?: Client) {
	const pending = useRef<IssueAttempt | undefined>(undefined);
	const mutation = useMutation({
		mutationKey: ["api-credentials", "issue"],
		mutationFn: (body: PersonalApiCredentialIssueRequestV1) => {
			if (!pending.current || !sameIssueBody(pending.current.body, body)) {
				pending.current = { body, idempotencyKey: crypto.randomUUID() };
			}
			return issuePersonalApiCredential(
				body,
				pending.current.idempotencyKey,
				client,
			);
		},
		onSuccess: () => {
			pending.current = undefined;
		},
	});
	return mutation;
}

export function useRevokePersonalApiCredential(client?: Client) {
	const pending = useRef<
		{ credentialId: string; idempotencyKey: string } | undefined
	>(undefined);
	const mutation = useMutation({
		mutationKey: ["api-credentials", "revoke"],
		mutationFn: (credentialId: string) => {
			if (pending.current?.credentialId !== credentialId) {
				pending.current = { credentialId, idempotencyKey: crypto.randomUUID() };
			}
			return revokePersonalApiCredential(
				credentialId,
				pending.current.idempotencyKey,
				client,
			);
		},
		onSuccess: () => {
			pending.current = undefined;
		},
	});
	return mutation;
}

export function useNarrowPersonalApiCredential(client?: Client) {
	const pending = useRef<
		| {
				credentialId: string;
				bodyFingerprint: string;
				idempotencyKey: string;
		  }
		| undefined
	>(undefined);
	const mutation = useMutation({
		mutationKey: ["api-credentials", "narrow"],
		mutationFn: (input: {
			credentialId: string;
			body: {
				scopes?: PersonalApiCredentialMetadataV1["scopes"];
				expiresAt?: string;
			};
		}) => {
			const bodyFingerprint = JSON.stringify({
				scopes: input.body.scopes ? [...input.body.scopes].sort() : undefined,
				expiresAt: input.body.expiresAt,
			});
			if (
				pending.current?.credentialId !== input.credentialId ||
				pending.current.bodyFingerprint !== bodyFingerprint
			) {
				pending.current = {
					credentialId: input.credentialId,
					bodyFingerprint,
					idempotencyKey: crypto.randomUUID(),
				};
			}
			return narrowPersonalApiCredential(
				input.credentialId,
				input.body,
				pending.current.idempotencyKey,
				client,
			);
		},
		onSuccess: () => {
			pending.current = undefined;
		},
	});
	return mutation;
}
