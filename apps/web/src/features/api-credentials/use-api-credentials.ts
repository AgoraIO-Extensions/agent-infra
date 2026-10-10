import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import type {
	PersonalApiCredentialIssueRequestV1,
	PersonalApiCredentialMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";
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
	const state: ApiCredentialsState | { kind: "denied" | "loading" } = !allowed
		? { kind: "denied" }
		: (queryFailure ?? query.data ?? { kind: "loading" });
	async function refetch() {
		if (!scope.active || !allowed) return undefined;
		return query.refetch({ cancelRefetch: false });
	}
	return { state, isFetching: allowed && query.isFetching, refetch };
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
