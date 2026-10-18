import {
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import { Link, useLocation, useRouterState } from "@tanstack/react-router";
import {
	Activity,
	Bot,
	Check,
	ClipboardMinus,
	ExternalLink,
	House,
	KeyRound,
	Layers,
	List,
	Menu,
	MessageCircle,
	Plus,
	X,
} from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbList,
	BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Sidebar } from "@/components/ui/sidebar";
import type { BrowserSessionProjectionV1 } from "../pilot/generated/types.gen";
import { LoginAction } from "./login-action";
import { LogoutAction } from "./logout-action";
import {
	BrowserSessionQueryContext,
	useBrowserSession,
} from "./use-browser-session";

const SessionContext = createContext<{
	identityKey: string;
	session: BrowserSessionProjectionV1;
} | null>(null);

export function useApplicationSession() {
	const value = useContext(SessionContext);
	if (!value) throw new Error("Authenticated application session is required");
	return value;
}

/** Configuration selects an entry point, never an identity or permission. */
export function safeDeploymentUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || /[\s\\]/.test(value))
		return undefined;
	if (value.startsWith("/") && !value.startsWith("//")) return value;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

function AuthenticatedContent({
	session,
	children,
}: {
	session: BrowserSessionProjectionV1;
	children: ReactNode;
}) {
	const sessionClient = useQueryClient();
	const [identityKey] = useState(() => crypto.randomUUID());
	const [client] = useState(() => new QueryClient());
	useLayoutEffect(
		() => () => {
			void client.cancelQueries();
			client.clear();
		},
		[client],
	);
	return (
		<BrowserSessionQueryContext.Provider value={sessionClient}>
			<QueryClientProvider client={client}>
				<SessionContext.Provider value={{ identityKey, session }}>
					{children}
				</SessionContext.Provider>
			</QueryClientProvider>
		</BrowserSessionQueryContext.Provider>
	);
}

export function ApplicationShell({ children }: { children: ReactNode }) {
	const session = useBrowserSession();
	const sessionProjection =
		session.state.kind === "ready"
			? JSON.stringify(session.state.session)
			: null;
	const sessionBoundaryKey = JSON.stringify([
		session.state.kind,
		session.state.kind === "ready"
			? (session.state.sessionGeneration ?? null)
			: null,
		sessionProjection,
	]);
	const pathname = useLocation({ select: (location) => location.pathname });
	const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
	const conversationSelection = useLocation({
		select: (location) => location.search.mode === "conversation",
	});
	const selectingConversation =
		normalizedPathname === "/agents" && conversationSelection;
	const chatContext = pathname.startsWith("/chat/") || selectingConversation;
	const [sheet, setSheet] = useState(false);
	const routeHref = useLocation({ select: (location) => location.href });
	const previousRoute = useRef(routeHref);
	useEffect(() => {
		if (previousRoute.current !== routeHref) {
			previousRoute.current = routeHref;
			setSheet(false);
		}
	}, [routeHref]);
	useEffect(() => {
		const desktop = window.matchMedia("(min-width: 1024px)");
		const closeOnDesktop = () => {
			if (desktop.matches) setSheet(false);
		};
		desktop.addEventListener("change", closeOnDesktop);
		return () => desktop.removeEventListener("change", closeOnDesktop);
	}, []);
	const user =
		session.state.kind === "ready" ? session.state.session.user : undefined;
	const admin = user?.roles.includes("system_admin") ?? false;
	const loginUrl = safeDeploymentUrl(import.meta.env.VITE_PLATFORM_LOGIN_URL);
	const logoutUrl = safeDeploymentUrl(import.meta.env.VITE_PLATFORM_LOGOUT_URL);
	const connectionUrl =
		session.state.kind === "ready" &&
		session.state.connection?.status === "available"
			? safeDeploymentUrl(
					session.state.connection.publicOrigin +
						session.state.connection.mcpPath,
				)
			: undefined;
	const development =
		import.meta.env.DEV &&
		import.meta.env.VITE_PLATFORM_DEVELOPMENT_MODE === "controlled";
	// 未匹配任何路由时不要按路径前缀猜标题（否则落到「Agent 详情」，#2297）。
	const notFound = useRouterState({
		select: (state) => state.matches.some((match) => match.globalNotFound),
	});
	const title =
		session.state.kind !== "ready"
			? "登录"
			: notFound
				? "页面不存在"
				: normalizedPathname === "/"
					? "工作台"
					: selectingConversation
						? "选择 Agent 开始对话"
						: chatContext || pathname.includes("/conversations")
							? "对话"
							: pathname.includes("/configuration")
								? "配置与生命周期"
								: normalizedPathname === "/admin/audit"
									? "平台审计"
									: normalizedPathname === "/audit"
										? "我的执行审计"
										: normalizedPathname === "/admin/agents"
											? "Agent 管理"
											: normalizedPathname.startsWith("/admin")
												? "创建审批"
												: normalizedPathname === "/my-agents/new"
													? "创建申请"
													: normalizedPathname.startsWith("/my-agents/") &&
															normalizedPathname.endsWith("/edit")
														? "编辑申请"
														: normalizedPathname.startsWith("/my-agents/") &&
																normalizedPathname !== "/my-agents"
															? "申请详情"
															: normalizedPathname.startsWith("/my-agents")
																? "我的 Agent"
																: normalizedPathname ===
																		"/my-settings/api-credentials"
																	? "API 凭证与应用"
																	: normalizedPathname ===
																			"/my-settings/relay-key"
																		? "个人 Relay Key"
																		: normalizedPathname.startsWith(
																					"/skills/manage",
																				)
																			? "Skill Hub 管理"
																			: normalizedPathname === "/skills" ||
																					normalizedPathname.startsWith(
																						"/skills/",
																					)
																				? "Skill Hub"
																				: normalizedPathname === "/eval"
																					? "评测"
																					: normalizedPathname === "/ops"
																						? "运维观测"
																						: normalizedPathname === "/agents"
																							? "Agent 目录"
																							: "Agent 详情";
	useEffect(() => {
		document.title = `${title} · Agora Agent`;
	}, [title]);
	const navigation = (
		<>
			<Link className="platform-brand" to="/" onClick={() => setSheet(false)}>
				<span className="platform-brand-mark" aria-hidden="true">
					A
				</span>
				<div>
					<strong>Agora Agent</strong>
					<small>Platform workspace</small>
				</div>
			</Link>
			<nav aria-label="主导航">
				<nav aria-label="工作区" className="platform-nav-group">
					<p className="platform-nav-label">工作区</p>
					<Link
						aria-current={normalizedPathname === "/" ? "page" : undefined}
						className={`platform-nav-item ${normalizedPathname === "/" ? "selected" : ""}`}
						to="/"
						onClick={() => setSheet(false)}
					>
						<House size={17} strokeWidth={1.8} aria-hidden="true" />
						工作台
					</Link>
					<Link
						aria-current={
							pathname.startsWith("/agents") && !selectingConversation
								? "page"
								: undefined
						}
						className={`platform-nav-item ${pathname.startsWith("/agents") && !selectingConversation ? "selected" : ""}`}
						to="/agents"
						search={{ mode: undefined }}
						activeOptions={{ explicitUndefined: true }}
						onClick={() => setSheet(false)}
					>
						<Bot size={17} strokeWidth={1.8} aria-hidden="true" />
						Agent 目录
					</Link>
					<Link
						aria-current={chatContext ? "page" : undefined}
						className={`platform-nav-item ${chatContext ? "selected" : ""}`}
						to="/agents"
						search={{ mode: "conversation" }}
						onClick={() => setSheet(false)}
					>
						<MessageCircle size={17} strokeWidth={1.8} aria-hidden="true" />
						对话
					</Link>
					<Link
						aria-current={
							normalizedPathname.startsWith("/skills") &&
							normalizedPathname !== "/skills/manage"
								? "page"
								: undefined
						}
						className={`platform-nav-item ${normalizedPathname.startsWith("/skills") && normalizedPathname !== "/skills/manage" ? "selected" : ""}`}
						to="/skills"
						activeOptions={{ exact: true }}
						onClick={() => setSheet(false)}
					>
						<Layers size={17} strokeWidth={1.8} aria-hidden="true" />
						Skill Hub
					</Link>
				</nav>
				<nav aria-label="我的管理" className="platform-nav-group">
					<p className="platform-nav-label">我的管理</p>
					<Link
						aria-current={
							normalizedPathname.startsWith("/my-agents") &&
							normalizedPathname !== "/my-agents/new"
								? "page"
								: undefined
						}
						className={`platform-nav-item ${normalizedPathname.startsWith("/my-agents") && normalizedPathname !== "/my-agents/new" ? "selected" : ""}`}
						to="/my-agents"
						onClick={() => setSheet(false)}
					>
						<Layers size={17} strokeWidth={1.8} aria-hidden="true" />
						我的 Agent
					</Link>
					<Link
						aria-current={
							normalizedPathname === "/my-agents/new" ? "page" : undefined
						}
						className={`platform-nav-item ${normalizedPathname === "/my-agents/new" ? "selected" : ""}`}
						to="/my-agents/new"
						onClick={() => setSheet(false)}
					>
						<Plus size={17} strokeWidth={1.8} aria-hidden="true" />
						创建申请
					</Link>
					<Link
						aria-current={normalizedPathname === "/audit" ? "page" : undefined}
						className={`platform-nav-item ${normalizedPathname === "/audit" ? "selected" : ""}`}
						to="/audit"
						onClick={() => setSheet(false)}
					>
						<ClipboardMinus size={17} strokeWidth={1.8} aria-hidden="true" />
						我的执行审计
					</Link>
					<Link
						aria-current={
							normalizedPathname === "/skills/manage" ? "page" : undefined
						}
						className={`platform-nav-item ${normalizedPathname === "/skills/manage" ? "selected" : ""}`}
						to="/skills/manage"
						onClick={() => setSheet(false)}
					>
						<Layers size={17} strokeWidth={1.8} aria-hidden="true" />
						Skill Hub 管理
					</Link>
					<Link
						aria-current={
							normalizedPathname === "/my-settings/api-credentials"
								? "page"
								: undefined
						}
						className={`platform-nav-item ${normalizedPathname === "/my-settings/api-credentials" ? "selected" : ""}`}
						to="/my-settings/api-credentials"
						onClick={() => setSheet(false)}
					>
						<KeyRound size={17} strokeWidth={1.8} aria-hidden="true" />
						API 凭证与应用
					</Link>
					<Link
						aria-current={
							normalizedPathname === "/my-settings/relay-key"
								? "page"
								: undefined
						}
						className={`platform-nav-item ${normalizedPathname === "/my-settings/relay-key" ? "selected" : ""}`}
						to="/my-settings/relay-key"
						onClick={() => setSheet(false)}
					>
						<KeyRound size={17} strokeWidth={1.8} aria-hidden="true" />
						个人 Relay Key
					</Link>
					{connectionUrl ? (
						<a
							className="platform-nav-item platform-nav-external"
							href={connectionUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							<span>
								<KeyRound size={17} strokeWidth={1.8} aria-hidden="true" />
								我的 Connection
							</span>
							<ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
						</a>
					) : (
						<span
							className="platform-nav-item"
							aria-disabled="true"
							title={
								session.state.kind === "ready" &&
								session.state.connection?.status === "unavailable"
									? `Connection: ${session.state.connection.reason}`
									: "Connection: unavailable"
							}
						>
							<KeyRound size={17} strokeWidth={1.8} aria-hidden="true" />
							我的 Connection（暂不可用）
						</span>
					)}
				</nav>
				{admin && (
					<nav aria-label="系统管理" className="platform-nav-group">
						<p className="platform-nav-label">系统管理</p>
						<Link
							aria-current={
								normalizedPathname.startsWith("/admin/approvals")
									? "page"
									: undefined
							}
							className={`platform-nav-item ${normalizedPathname.startsWith("/admin/approvals") ? "selected" : ""}`}
							to="/admin/approvals"
							onClick={() => setSheet(false)}
						>
							<Check size={17} strokeWidth={1.8} aria-hidden="true" />
							创建审批
						</Link>
						<Link
							aria-current={
								normalizedPathname === "/admin/agents" ? "page" : undefined
							}
							className={`platform-nav-item ${normalizedPathname === "/admin/agents" ? "selected" : ""}`}
							to="/admin/agents"
							onClick={() => setSheet(false)}
						>
							<List size={17} strokeWidth={1.8} aria-hidden="true" />
							Agent 管理
						</Link>
						<Link
							aria-current={
								normalizedPathname === "/admin/audit" ? "page" : undefined
							}
							className={`platform-nav-item ${normalizedPathname === "/admin/audit" ? "selected" : ""}`}
							to="/admin/audit"
							onClick={() => setSheet(false)}
						>
							<ClipboardMinus size={17} strokeWidth={1.8} aria-hidden="true" />
							平台审计
						</Link>
						<Link
							aria-current={normalizedPathname === "/eval" ? "page" : undefined}
							className={`platform-nav-item ${normalizedPathname === "/eval" ? "selected" : ""}`}
							to="/eval"
							onClick={() => setSheet(false)}
						>
							<Activity size={17} strokeWidth={1.8} aria-hidden="true" />
							评测
						</Link>
						<Link
							aria-current={normalizedPathname === "/ops" ? "page" : undefined}
							className={`platform-nav-item ${normalizedPathname === "/ops" ? "selected" : ""}`}
							to="/ops"
							onClick={() => setSheet(false)}
						>
							<Activity size={17} strokeWidth={1.8} aria-hidden="true" />
							运维观测
						</Link>
					</nav>
				)}
			</nav>
			<div className="platform-nav-bottom">
				<div className="platform-identity">
					<Avatar className="platform-avatar" aria-hidden="true">
						<AvatarFallback>
							{user?.displayName.slice(0, 1) ?? "访"}
						</AvatarFallback>
					</Avatar>
					<div>
						{user?.displayName ?? "尚未登录"}
						<small>
							{user ? (admin ? "系统管理员" : "员工") : "登录后进入工作空间"}
						</small>
					</div>
				</div>
				{user && logoutUrl && (
					<LogoutAction
						endpoint={logoutUrl}
						onLoggedOut={() => session.refetch()}
					/>
				)}
			</div>
		</>
	);
	if (session.state.kind !== "ready") {
		return (
			<main className="login-page">
				<section className="login-panel" aria-labelledby="login-heading">
					<div className="login-brand" aria-hidden="true">
						A
					</div>
					<p className="login-eyebrow">AGORA AGENT PLATFORM</p>
					<h1 id="login-heading">登录工作空间</h1>
					<p className="login-lead" role="status" aria-live="polite">
						{session.isFetching
							? "正在确认登录状态…"
							: session.state.kind !== "loading" &&
								(session.state.retryable
									? "暂时无法确认登录状态，请重试。"
									: "请先登录，再查看 Agent、提交申请或继续对话。")}
					</p>
					{session.state.kind !== "loading" && (
						<div className="space-y-4">
							{loginUrl ? (
								development ? (
									<a className={buttonVariants()} href={loginUrl}>
										选择开发测试身份
									</a>
								) : (
									<LoginAction
										endpoint={loginUrl}
										onLoggedIn={async () => {
											const result = await session.refetch();
											if (result.data?.kind !== "ready")
												throw new Error("Login session was not established");
										}}
									/>
								)
							) : (
								<p role="status">登录入口尚未配置。</p>
							)}
							<Button
								variant="outline"
								onClick={() => void session.refetch()}
								disabled={session.isFetching}
							>
								{session.isFetching ? "正在检查…" : "重新检查"}
							</Button>
						</div>
					)}
				</section>
			</main>
		);
	}
	return (
		<div
			className={
				pathname.startsWith("/chat/")
					? "platform-shell platform-shell-chat"
					: "platform-shell"
			}
		>
			<a className="platform-skip-link" href="#main-content">
				跳至主要内容
			</a>
			<Sidebar className="platform-sidebar">{navigation}</Sidebar>
			<div className="platform-workspace">
				<header className="platform-topbar">
					<Sheet open={sheet} onOpenChange={setSheet}>
						<SheetTrigger
							render={
								<Button
									variant="outline"
									size="icon"
									className="mobile-menu"
									aria-label="打开导航"
								/>
							}
						>
							<Menu aria-hidden="true" />
						</SheetTrigger>
						<SheetContent
							side="left"
							showCloseButton={false}
							className="platform-nav-sheet"
						>
							<SheetHeader className="sr-only">
								<SheetTitle>主导航</SheetTitle>
								<SheetDescription>
									选择页面，或关闭导航返回当前页面。
								</SheetDescription>
							</SheetHeader>
							<SheetClose
								className={buttonVariants({
									variant: "ghost",
									size: "icon",
									className: "absolute top-3 right-3",
								})}
								aria-label="关闭导航"
							>
								<X aria-hidden="true" />
							</SheetClose>
							{navigation}
						</SheetContent>
					</Sheet>
					<Breadcrumb className="platform-breadcrumb">
						<BreadcrumbList>
							<BreadcrumbItem>
								{normalizedPathname.startsWith("/admin")
									? "系统管理"
									: normalizedPathname.startsWith("/my-agents") ||
											normalizedPathname === "/audit" ||
											normalizedPathname.startsWith("/my-settings") ||
											normalizedPathname.startsWith("/skills")
										? "我的管理"
										: normalizedPathname === "/eval" ||
												normalizedPathname === "/ops"
											? "系统管理"
											: "工作区"}
							</BreadcrumbItem>
							<BreadcrumbItem>
								<BreadcrumbPage>{title}</BreadcrumbPage>
							</BreadcrumbItem>
						</BreadcrumbList>
					</Breadcrumb>
					{user && (
						<Avatar
							className="platform-user"
							aria-label={`当前用户：${user.displayName}`}
						>
							<AvatarFallback>{user.displayName.slice(0, 1)}</AvatarFallback>
						</Avatar>
					)}
					{development && (
						<span className="text-muted-foreground text-xs">
							本地开发 · 测试身份
						</span>
					)}
				</header>
				<div id="main-content" tabIndex={-1} className="min-w-0 flex-1">
					<AuthenticatedContent
						// A login generation can outlive a role change. Both boundaries
						// must reset feature caches and drafts, including older deployments.
						key={sessionBoundaryKey}
						session={session.state.session}
					>
						{children}
					</AuthenticatedContent>
				</div>
			</div>
		</div>
	);
}
