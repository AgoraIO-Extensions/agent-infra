import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";

import { ConnectionApiError, connectionApi } from "../api";
import { LoginView } from "../views";

export const Route = createFileRoute("/connection/login")({
	component: LoginPage,
});

function LoginPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: connectionApi.login,
		onSuccess: async (session) => {
			queryClient.setQueryData(["session"], session);
			await navigate({ to: "/connection/connections" });
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
