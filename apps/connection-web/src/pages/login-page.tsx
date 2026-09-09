import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";

import { ConnectionApiError, connectionApi } from "../api";
import { LoginView } from "../views";

function recoverySearch(returnTo: string | undefined) {
	if (!returnTo) return undefined;
	const target = new URL(returnTo, "https://connection.invalid");
	if (
		target.origin !== "https://connection.invalid" ||
		target.pathname !== "/connection/connections"
	)
		return undefined;
	const provider = target.searchParams.get("provider");
	const intent = target.searchParams.get("intent");
	if (
		!provider ||
		!/^[a-z0-9_-]+$/.test(provider) ||
		!intent ||
		!["authorize", "connect", "reauthorize"].includes(intent)
	)
		return undefined;
	return { intent, provider };
}

export function LoginPage(props: { returnTo?: string }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: connectionApi.login,
		onSuccess: async (session) => {
			queryClient.setQueryData(["session"], session);
			const search = recoverySearch(props.returnTo);
			await navigate(
				search
					? { search, to: "/connection/connections" }
					: { to: "/connection/connections" },
			);
		},
	});
	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const data = new FormData(event.currentTarget);
		mutation.mutate({
			password: String(data.get("password") ?? ""),
			username: String(data.get("username") ?? ""),
		});
	};
	return (
		<LoginView
			busy={mutation.isPending}
			error={
				mutation.error instanceof ConnectionApiError
					? mutation.error.message
					: mutation.isError
						? "登录失败，请稍后重试"
						: null
			}
			onSubmit={onSubmit}
		/>
	);
}
