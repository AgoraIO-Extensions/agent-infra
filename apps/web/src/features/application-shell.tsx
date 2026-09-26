import {
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import {
	ArrowUpRight,
	CheckCheck,
	ClipboardList,
	Grid2X2,
	Layers,
	Menu,
	X,
} from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useState,
} from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
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
	const [sheet, setSheet] = useState(false);
	const user =
		session.state.kind === "ready" ? session.state.session.user : undefined;
	const admin = user?.roles.includes("system_admin") ?? false;
	const loginUrl = safeDeploymentUrl(import.meta.env.VITE_PLATFORM_LOGIN_URL);
	const logoutUrl = safeDeploymentUrl(import.meta.env.VITE_PLATFORM_LOGOUT_URL);
	const connectionUrl = safeDeploymentUrl(import.meta.env.VITE_CONNECTION_URL);
	const development =
		import.meta.env.DEV &&
		import.meta.env.VITE_PLATFORM_DEVELOPMENT_MODE === "controlled";
	const title = pathname.includes("/conversations")
		? "文本对话与个人历史"
		: pathname.includes("/configuration")
			? "配置与生命周期"
			: pathname === "/admin/audit"
				? "平台审计"
				: pathname === "/audit"
					? "我的执行审计"
					: pathname.startsWith("/admin")
						? "审批"
						: pathname === "/my-agents/new"
							? "创建申请"
							: pathname.startsWith("/my-agents")
								? "我的 Agent"
								: pathname === "/agents" || pathname === "/agents/"
									? "Agent"
									: "Agent 详情";
	const navigation = (
		<>
			<div className="platform-brand">
				<span className="platform-brand-mark">
					<Layers size={21} aria-hidden="true" />
				</span>
				<div>
					Agent Platform<small>工作空间</small>
				</div>
			</div>
			<p className="platform-nav-label">工作台</p>
			<nav aria-label="主导航">
				<Link
					className={`platform-nav-item ${pathname.startsWith("/agents") ? "selected" : ""}`}
					to="/agents"
					onClick={() => setSheet(false)}
				>
					<Grid2X2 size={19} aria-hidden="true" />
					Agent
				</Link>
				<Link
					className={`platform-nav-item ${pathname.startsWith("/my-agents") ? "selected" : ""}`}
					to="/my-agents"
					onClick={() => setSheet(false)}
				>
					<Layers size={19} aria-hidden="true" />
					我的 Agent
				</Link>
				<Link
					className={`platform-nav-item ${pathname === "/audit" ? "selected" : ""}`}
					to="/audit"
					onClick={() => setSheet(false)}
				>
					<ClipboardList size={19} aria-hidden="true" />
					我的执行审计
				</Link>
				{admin && (
					<Link
						className={`platform-nav-item ${pathname.startsWith("/admin/approvals") ? "selected" : ""}`}
						to="/admin/approvals"
						onClick={() => setSheet(false)}
					>
						<CheckCheck size={19} aria-hidden="true" />
						审批
					</Link>
				)}
				{admin && (
					<Link
						className={`platform-nav-item ${pathname === "/admin/audit" ? "selected" : ""}`}
						to="/admin/audit"
						onClick={() => setSheet(false)}
					>
						<ClipboardList size={19} aria-hidden="true" />
						平台审计
					</Link>
				)}
			</nav>
			<div className="platform-nav-bottom">
				{connectionUrl ? (
					<a
						className="platform-nav-item"
						href={connectionUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						我的 Connection
						<ArrowUpRight size={16} aria-hidden="true" />
					</a>
				) : (
					<p className="platform-nav-label">Connection 尚未接入</p>
				)}
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
					<a className="platform-nav-item" href={logoutUrl}>
						退出登录
					</a>
				)}
			</div>
		</>
	);
	return (
		<div className="platform-shell">
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
									variant="ghost"
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
							<BreadcrumbItem>工作台</BreadcrumbItem>
							<BreadcrumbSeparator />
							<BreadcrumbItem>
								<BreadcrumbPage>{title}</BreadcrumbPage>
							</BreadcrumbItem>
						</BreadcrumbList>
					</Breadcrumb>
					{development && (
						<span className="text-muted-foreground text-xs">
							本地开发 · 测试身份
						</span>
					)}
				</header>
				<div id="main-content" tabIndex={-1} className="min-w-0 flex-1">
					{session.state.kind === "ready" ? (
						<AuthenticatedContent
							// A login generation can outlive a role change. Both boundaries
							// must reset feature caches and drafts, including older deployments.
							key={sessionBoundaryKey}
							session={session.state.session}
						>
							{children}
						</AuthenticatedContent>
					) : (
						<main className="platform-content max-w-2xl">
							<h1 className="font-semibold text-[28px]">
								{session.state.kind === "loading"
									? "正在确认登录状态…"
									: "登录工作空间"}
							</h1>
							{session.state.kind !== "loading" && (
								<div className="mt-5 space-y-4">
									<p className="text-muted-foreground">
										{session.state.retryable
											? "暂时无法确认登录状态，请重试。"
											: "请先登录，再查看 Agent、提交申请或继续对话。"}
									</p>
									{loginUrl ? (
										<a className={buttonVariants()} href={loginUrl}>
											{development ? "选择开发测试身份" : "前往登录"}
										</a>
									) : (
										<p role="status">登录入口尚未配置。</p>
									)}
									<Button
										variant="outline"
										onClick={() => void session.refetch()}
										disabled={session.isFetching}
									>
										重新检查
									</Button>
								</div>
							)}
						</main>
					)}
				</div>
			</div>
		</div>
	);
}
