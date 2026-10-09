import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import {
	Bell,
	BookOpen,
	Bot,
	Cable,
	Check,
	FileClock,
	KeyRound,
	ListChecks,
	LogOut,
	ShieldCheck,
	Trash2,
	UsersRound,
	X,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { connectionApi } from "./api";

export function ConsoleShell(props: { children: ReactNode }) {
	const [notificationsOpen, setNotificationsOpen] = useState(false);
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
			await navigate({
				search: { returnTo: undefined },
				to: "/connection/login",
			});
		},
	});
	const notifications = useQuery({
		queryKey: ["connection-approval-notifications"],
		queryFn: connectionApi.listConnectionNotifications,
		enabled: session.isSuccess,
		refetchInterval: 30_000,
	});
	const updateNotification = useMutation({
		mutationFn: connectionApi.updateApprovalNotification,
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ["connection-approval-notifications"],
			}),
	});
	const clearNotifications = useMutation({
		mutationFn: async () => {
			let previousFirstId: string | undefined;
			for (;;) {
				const current = await connectionApi.listConnectionNotifications();
				if (!current.items.length) return;
				if (current.items[0]?.id === previousFirstId)
					throw new Error("通知列表未更新，请稍后重试");
				previousFirstId = current.items[0]?.id;
				await connectionApi.archiveApprovalNotifications(
					current.items.map((item) => item.id),
				);
			}
		},
		onSettled: () =>
			queryClient.invalidateQueries({
				queryKey: ["connection-approval-notifications"],
			}),
	});
	const workItemCount =
		(notifications.data?.adminWorkItems ?? 0) +
		(notifications.data?.openWorkItems ?? 0) +
		(notifications.data?.reapprovalWorkItems ?? 0) +
		(notifications.data?.upgradeWorkItems ?? 0);
	const notificationCount =
		workItemCount + (notifications.data?.unreadCount ?? 0);

	if (session.isPending) return <FullPageState>正在加载账号...</FullPageState>;
	if (session.isError) {
		const returnTo =
			window.location.pathname === "/connection/connections"
				? `${window.location.pathname}${window.location.search}`
				: undefined;
		return <Navigate to="/connection/login" search={{ returnTo }} replace />;
	}

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
					<NavLink to="/connection/approvals" icon={<ListChecks size={18} />}>
						待我审批
					</NavLink>
					<NavLink to="/connection/help" icon={<BookOpen size={18} />}>
						使用指南
					</NavLink>
					<NavLink to="/connection/tokens" icon={<KeyRound size={18} />}>
						访问令牌
					</NavLink>
					{session.data.isAdministrator ? (
						<>
							<div className="nav-separator" />
							<NavLink
								to="/connection/admin/approval"
								icon={<ListChecks size={18} />}
							>
								审批管理
							</NavLink>
							<NavLink
								to="/connection/admin/action-calls"
								icon={<FileClock size={18} />}
							>
								操作记录
							</NavLink>
							<NavLink to="/connection/admin/agents" icon={<Bot size={18} />}>
								Agent 接入
							</NavLink>
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
			<main className="main-content">
				<div className="shell-notification">
					<button
						type="button"
						className="notification-link"
						title="通知与待办"
						aria-label={`通知与待办 ${notificationCount} 项：待办 ${workItemCount}，未读通知 ${notifications.data?.unreadCount ?? 0}`}
						aria-expanded={notificationsOpen}
						onClick={() => setNotificationsOpen((value) => !value)}
					>
						<Bell size={18} aria-hidden="true" />
						{notificationCount ? (
							<span>{notificationCount > 99 ? "99+" : notificationCount}</span>
						) : null}
					</button>
					{notificationsOpen ? (
						<section className="notification-panel" aria-label="通知与待办">
							<header>
								<strong>
									通知与待办
									<small>
										待办 {workItemCount} · 未读通知{" "}
										{notifications.data?.unreadCount ?? 0}
									</small>
								</strong>
								<button
									type="button"
									title="关闭通知"
									aria-label="关闭通知"
									onClick={() => setNotificationsOpen(false)}
								>
									<X size={16} />
								</button>
							</header>
							{updateNotification.isError ? (
								<PageError error={updateNotification.error} />
							) : null}
							{clearNotifications.isError ? (
								<PageError error={clearNotifications.error} />
							) : null}
							{notifications.data?.items.length ? (
								<button
									className="notification-clear"
									type="button"
									disabled={
										clearNotifications.isPending || updateNotification.isPending
									}
									onClick={() => clearNotifications.mutate()}
								>
									<Trash2 aria-hidden="true" size={15} />
									{clearNotifications.isPending ? "清除中..." : "清除全部"}
								</button>
							) : null}
							<Link
								to="/connection/approvals"
								onClick={() => setNotificationsOpen(false)}
								className="notification-tasks"
							>
								待我审批{" "}
								<strong>{notifications.data?.openWorkItems ?? 0}</strong>
							</Link>
							<Link
								to="/connection/connections"
								onClick={() => setNotificationsOpen(false)}
								className="notification-tasks"
							>
								连接重审{" "}
								<strong>{notifications.data?.reapprovalWorkItems ?? 0}</strong>
							</Link>
							<Link
								to="/connection/connections"
								onClick={() => setNotificationsOpen(false)}
								className="notification-tasks"
							>
								Provider 升级{" "}
								<strong>{notifications.data?.upgradeWorkItems ?? 0}</strong>
							</Link>
							{session.data.isAdministrator ? (
								<Link
									to="/connection/admin/approval"
									onClick={() => setNotificationsOpen(false)}
									className="notification-tasks"
								>
									审批异常{" "}
									<strong>{notifications.data?.adminWorkItems ?? 0}</strong>
								</Link>
							) : null}
							{notifications.isError ? (
								<p role="alert">通知暂时无法加载</p>
							) : notifications.data?.items.length ? (
								<ul>
									{notifications.data.items.map((item) => (
										<li key={item.id} className={item.readAt ? "" : "unread"}>
											<div>
												<Link
													to={
														item.eventType === "REVIEW_REQUIRED"
															? "/connection/approvals"
															: item.eventType === "ROUTING_BLOCKED" ||
																	item.eventType === "DISPATCH_FAILED"
																? "/connection/admin/approval"
																: "/connection/connections"
													}
													search={
														item.eventType === "REVIEW_REQUIRED" ||
														item.eventType === "ROUTING_BLOCKED" ||
														item.eventType === "DISPATCH_FAILED"
															? undefined
															: { provider: item.providerId }
													}
													onClick={() => {
														setNotificationsOpen(false);
														if (!item.readAt)
															updateNotification.mutate({
																notificationId: item.id,
																body: { action: "READ" },
															});
													}}
												>
													{item.providerId} ·{" "}
													{item.eventType === "REVIEW_REQUIRED"
														? "待审批"
														: item.eventType === "ROUTING_BLOCKED"
															? "待重新分配"
															: item.eventType === "DISPATCH_FAILED"
																? "投递失败"
																: item.state}
												</Link>
												<small>
													{new Date(item.createdAt).toLocaleString()}
												</small>
											</div>
											<button
												type="button"
												title={item.readAt ? "归档通知" : "标记已读"}
												aria-label={item.readAt ? "归档通知" : "标记已读"}
												disabled={
													updateNotification.isPending ||
													clearNotifications.isPending
												}
												onClick={() =>
													updateNotification.mutate({
														notificationId: item.id,
														body: { action: item.readAt ? "ARCHIVE" : "READ" },
													})
												}
											>
												{item.readAt ? <X size={15} /> : <Check size={15} />}
											</button>
										</li>
									))}
								</ul>
							) : (
								<p>暂无通知</p>
							)}
						</section>
					) : null}
				</div>
				{props.children}
			</main>
		</div>
	);
}

function NavLink(props: {
	children: ReactNode;
	icon: ReactNode;
	to:
		| "/connection/admin/action-calls"
		| "/connection/connections"
		| "/connection/approvals"
		| "/connection/tokens"
		| "/connection/help"
		| "/connection/admin/agents"
		| "/connection/admin/shared-connections"
		| "/connection/admin/administrators"
		| "/connection/admin/approval";
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
