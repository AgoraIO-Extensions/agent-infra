import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import {
	markUserRead,
	retainContent,
	retainedContentAt,
} from "../background-read.js";
import type {
	ApplicationCredentialRequest,
	ApplicationManagementState,
} from "./application-management.js";
import {
	disableOwnApplication,
	issueOrRotateApplicationCredential,
	loadOwnApplication,
	registerOwnApplication,
} from "./application-management.js";

export function useOwnApplication({
	applicationId,
	identityKey,
	client,
}: {
	applicationId?: string;
	identityKey: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const scope = useMemo(
		() => ({
			queryKey: [
				"application-management",
				identityKey,
				applicationId,
				crypto.randomUUID(),
			] as const,
			active: false,
			client,
		}),
		[identityKey, applicationId, client],
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
		queryFn: ({ signal }) =>
			loadOwnApplication(applicationId, scope.client, signal),
		enabled: allowed,
		retry: false,
		staleTime: 15_000,
	});
	const queryFailure: ApplicationManagementState | null = query.error
		? {
				kind: "unavailable",
				retryable:
					!(query.error instanceof Error) ||
					!("retryable" in query.error) ||
					query.error.retryable !== false,
			}
		: null;
	const read: ApplicationManagementState | { kind: "loading" } = queryFailure ??
		query.data ?? { kind: "loading" };
	// 同个人凭证列表：后台重读的可重试失败继续显示上一次的应用（#3387）。
	const state = !allowed
		? { kind: "denied" as const }
		: retainContent(scope, read, {
				isContent: (current) =>
					current.kind === "ready" || current.kind === "empty",
				isRetryableFailure: (current) =>
					current.kind === "unavailable" && current.retryable,
				updatedAt: query.error ? query.errorUpdatedAt : query.dataUpdatedAt,
			});
	/** 页面发起的重读（「重新加载」、停用后的回读）：失败时按读取失败显示。 */
	async function refetch() {
		if (!scope.active || !allowed) return undefined;
		markUserRead(scope, retainedContentAt(scope));
		return query.refetch({ cancelRefetch: false });
	}
	return { state, isFetching: allowed && query.isFetching, refetch };
}

export function useRegisterOwnApplication(client?: Client) {
	const pending = useRef<{ name: string; idempotencyKey: string } | undefined>(
		undefined,
	);
	return useMutation({
		mutationKey: ["application-management", "register"],
		mutationFn: (name: string) => {
			if (pending.current?.name !== name)
				pending.current = { name, idempotencyKey: crypto.randomUUID() };
			return registerOwnApplication(
				name,
				pending.current.idempotencyKey,
				client,
			);
		},
		onSuccess: () => {
			pending.current = undefined;
		},
	});
}

export function useDisableOwnApplication(client?: Client) {
	const pending = useRef<
		{ applicationId: string; idempotencyKey: string } | undefined
	>(undefined);
	return useMutation({
		mutationKey: ["application-management", "disable"],
		mutationFn: (applicationId: string) => {
			if (pending.current?.applicationId !== applicationId)
				pending.current = {
					applicationId,
					idempotencyKey: crypto.randomUUID(),
				};
			return disableOwnApplication(
				applicationId,
				pending.current.idempotencyKey,
				client,
			);
		},
		onSuccess: () => {
			pending.current = undefined;
		},
	});
}

export function useIssueOrRotateApplicationCredential(client?: Client) {
	const pending = useRef<
		| {
				applicationId: string;
				body: ApplicationCredentialRequest;
				idempotencyKey: string;
		  }
		| undefined
	>(undefined);
	return useMutation({
		mutationKey: ["application-management", "credential"],
		mutationFn: (input: {
			applicationId: string;
			body: ApplicationCredentialRequest;
		}) => {
			if (
				pending.current?.applicationId !== input.applicationId ||
				JSON.stringify(pending.current.body) !== JSON.stringify(input.body)
			) {
				pending.current = { ...input, idempotencyKey: crypto.randomUUID() };
			}
			return issueOrRotateApplicationCredential(
				input.applicationId,
				input.body,
				pending.current.idempotencyKey,
				client,
			);
		},
		onSuccess: () => {
			pending.current = undefined;
		},
	});
}
