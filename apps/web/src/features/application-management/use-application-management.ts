import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
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
		}),
		[identityKey, applicationId],
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
	const [refreshFailure, setRefreshFailure] =
		useState<ApplicationManagementState | null>(null);
	const query = useQuery({
		queryKey: scope.queryKey,
		queryFn: () => loadOwnApplication(applicationId, client),
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
	const state = !allowed
		? { kind: "denied" as const }
		: (refreshFailure ??
			queryFailure ??
			query.data ?? { kind: "loading" as const });
	async function refetch() {
		if (!scope.active || !allowed) return undefined;
		const result = await query.refetch({ cancelRefetch: false });
		if (result.error) {
			setRefreshFailure({
				kind: "unavailable",
				retryable:
					!(result.error instanceof Error) ||
					!("retryable" in result.error) ||
					result.error.retryable !== false,
			});
		} else {
			setRefreshFailure(null);
		}
		return result;
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
