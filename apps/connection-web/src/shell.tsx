import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { Cable, KeyRound, LogOut, ShieldCheck, UsersRound } from "lucide-react";
import type { ReactNode } from "react";

import { connectionApi } from "./api";

export function ConsoleShell(props: { children: ReactNode }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const session = useQuery({
		queryKey: ["session"],
		queryFn: connectionApi.getSession,
	});
	const logout = useMutation({
		mutationFn: connectionApi.logout,
		onSuccess: async () => {
			queryClient.clear();
			await navigate({ to: "/connection/login" });
		},
	});

	if (session.isPending) return <FullPageState>正在加载账号...</FullPageState>;
	if (session.isError) return <Navigate to="/connection/login" replace />;

	return (
		<div className="app-shell">
			<aside className="sidebar">
				<div className="brand-lockup sidebar-brand">
					<span className="brand-mark" aria-hidden="true">
						C
					</span>
					<span>Connection</span>
				</div>
				<nav aria-label="Connection 导航">
					<NavLink to="/connection/connections" icon={<Cable size={18} />}>
						我的 Connection
					</NavLink>
					<NavLink to="/connection/tokens" icon={<KeyRound size={18} />}>
						访问令牌
					</NavLink>
					{session.data.isAdministrator ? (
						<>
							<div className="nav-separator" />
							<NavLink
								to="/connection/admin/shared-connections"
								icon={<UsersRound size={18} />}
							>
								共享 Connection
							</NavLink>
							<NavLink
								to="/connection/admin/administrators"
								icon={<ShieldCheck size={18} />}
							>
								管理员
							</NavLink>
						</>
					) : null}
				</nav>
				<div className="account-block">
					<strong title={session.data.account.displayName}>
						{session.data.account.displayName}
					</strong>
					<span title={session.data.account.email ?? "公司账号"}>
						{session.data.account.email ?? "公司账号"}
					</span>
					<button
						className="text-button"
						type="button"
						onClick={() => logout.mutate()}
						disabled={logout.isPending}
					>
						<LogOut aria-hidden="true" size={16} />
						<span>退出登录</span>
					</button>
				</div>
			</aside>
			<main className="main-content">{props.children}</main>
		</div>
	);
}

function NavLink(props: {
	children: ReactNode;
	icon: ReactNode;
	to:
		| "/connection/connections"
		| "/connection/tokens"
		| "/connection/admin/shared-connections"
		| "/connection/admin/administrators";
}) {
	return (
		<Link
			className="nav-link"
			activeProps={{ className: "nav-link active" }}
			to={props.to}
		>
			{props.icon}
			<span>{props.children}</span>
		</Link>
	);
}

export function FullPageState(props: { children: ReactNode }) {
	return (
		<main className="full-page-state" role="status">
			{props.children}
		</main>
	);
}

export function PageError(props: { error: unknown }) {
	return (
		<div className="alert alert-error" role="alert">
			{props.error instanceof Error ? props.error.message : "页面加载失败"}
		</div>
	);
}
