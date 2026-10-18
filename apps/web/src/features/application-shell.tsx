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
	FlaskConical,
	House,
	KeyRound,
	Layers,
	List,
	Menu,
	MessageCircle,
	Plus,
	Settings2,
	X,
} from "lucide-react";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
	type NavigationKey,
	navigationGroups,
	navigationLabels,
	resolvePageChrome,
	signInDocumentTitle,
} from "./page-chrome";
import {
	BrowserSessionQueryContext,
	useBrowserSession,
} from "./use-browser-session";

const navigationIconProps = {
	size: 17,
	strokeWidth: 1.8,
	"aria-hidden": true,
} as const;

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
	const conversationSelection = useLocation({
		select: (location) => location.search.mode === "conversation",
	});
	const [sheet, setSheet] = useState(false);
	const sheetBrand = useRef<HTMLAnchorElement>(null);
	const navigationId = useId();
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
	const chrome = resolvePageChrome({
		pathname,
		conversationSelection,
		notFound,
	});
	// 未登录时整页是登录入口，标签页标题与登录页一致。
	const documentTitle =
		session.state.kind === "unavailable"
			? signInDocumentTitle
			: chrome.documentTitle;
	useEffect(() => {
		document.title = documentTitle;
	}, [documentTitle]);
	const closeSheet = () => setSheet(false);
	// 当前项只由路由外观表决定；exact 防止 Link 按前缀自动补 aria-current（N-21）。
	const navigationItemProps = (key: NavigationKey) => {
		const current = chrome.navKey === key;
		return {
			"aria-current": current ? ("page" as const) : undefined,
			className: current ? "platform-nav-item selected" : "platform-nav-item",
			activeOptions: { exact: true },
			onClick: closeSheet,
		};
	};
	const connectionUnavailable = (surface: string) => {
		const reasonId = `${navigationId}-${surface}-connection-reason`;
		return (
			<span
				key="connection"
				className="platform-nav-item platform-nav-unavailable"
				aria-disabled="true"
				aria-describedby={reasonId}
			>
				<KeyRound {...navigationIconProps} />
				{navigationLabels.connection}
				{/* 设计宽度 219px 内保持单行：chip 用「不可用」且不带状态圆点。 */}
				<Badge variant="outline" className="platform-nav-chip">
					不可用
				</Badge>
				{/* 不展示原始 reason 值，只给出中文说明。 */}
				<span id={reasonId} className="sr-only">
					Connection 服务当前不可用。
				</span>
			</span>
		);
	};
	const renderNavigationItem = (key: NavigationKey, surface: string) => {
		const label = navigationLabels[key];
		switch (key) {
			case "workbench":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/">
						<House {...navigationIconProps} />
						{label}
					</Link>
				);
			case "agents":
				return (
					<Link
						key={key}
						{...navigationItemProps(key)}
						to="/agents"
						search={{ mode: undefined }}
						activeOptions={{ exact: true, explicitUndefined: true }}
					>
						<Bot {...navigationIconProps} />
						{label}
					</Link>
				);
			case "chat":
				return (
					<Link
						key={key}
						{...navigationItemProps(key)}
						to="/agents"
						search={{ mode: "conversation" }}
					>
						<MessageCircle {...navigationIconProps} />
						{label}
					</Link>
				);
			case "skills":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/skills">
						<Layers {...navigationIconProps} />
						{label}
					</Link>
				);
			case "my-agents":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/my-agents">
						<Layers {...navigationIconProps} />
						{label}
					</Link>
				);
			case "application-form":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/my-agents/new">
						<Plus {...navigationIconProps} />
						{label}
					</Link>
				);
			case "my-skills":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/skills/manage">
						<Layers {...navigationIconProps} />
						{label}
					</Link>
				);
			case "personal-keys":
				return (
					<Link
						key={key}
						{...navigationItemProps(key)}
						to="/my-settings/relay-key"
					>
						<KeyRound {...navigationIconProps} />
						{label}
					</Link>
				);
			case "credentials":
				return (
					<Link
						key={key}
						{...navigationItemProps(key)}
						to="/my-settings/api-credentials"
					>
						<Settings2 {...navigationIconProps} />
						{label}
					</Link>
				);
			case "audit":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/audit">
						<ClipboardMinus {...navigationIconProps} />
						{label}
					</Link>
				);
			case "connection":
				return connectionUrl ? (
					<a
						key={key}
						className="platform-nav-item platform-nav-external"
						href={connectionUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						<span>
							<KeyRound {...navigationIconProps} />
							{label}
						</span>
						<ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
					</a>
				) : (
					connectionUnavailable(surface)
				);
			case "approvals":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/admin/approvals">
						<Check {...navigationIconProps} />
						{label}
					</Link>
				);
			case "admin-agents":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/admin/agents">
						<List {...navigationIconProps} />
						{label}
					</Link>
				);
			case "eval":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/eval">
						<FlaskConical {...navigationIconProps} />
						{label}
					</Link>
				);
			case "platform-audit":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/admin/audit">
						<ClipboardMinus {...navigationIconProps} />
						{label}
					</Link>
				);
			case "ops":
				return (
					<Link key={key} {...navigationItemProps(key)} to="/ops">
						<Activity {...navigationIconProps} />
						{label}
					</Link>
				);
		}
	};
	const renderNavigation = (
		surface: "sidebar" | "sheet",
		brandRef?: RefObject<HTMLAnchorElement | null>,
	) => (
		<>
			<Link
				ref={brandRef}
				className="platform-brand"
				to="/"
				onClick={closeSheet}
			>
				<span className="platform-brand-mark" aria-hidden="true">
					A
				</span>
				<div>
					<strong>Agora Agent</strong>
					<small>Platform workspace</small>
				</div>
			</Link>
			<nav aria-label="主导航">
				{navigationGroups
					.filter((group) => admin || !group.administratorOnly)
					.map((group) => (
						<nav
							key={group.label}
							aria-label={group.label}
							className="platform-nav-group"
						>
							<p className="platform-nav-label">{group.label}</p>
							{group.items.map((key) => renderNavigationItem(key, surface))}
						</nav>
					))}
			</nav>
			<div className="platform-nav-bottom">
				<div className="platform-identity">
					<Avatar className="platform-avatar" aria-hidden="true">
						<AvatarFallback>
							{user?.displayName.slice(0, 1) ?? "访"}
						</AvatarFallback>
					</Avatar>
					<div>
						<strong>{user?.displayName ?? "尚未登录"}</strong>
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
			<Sidebar className="platform-sidebar">
				{renderNavigation("sidebar")}
			</Sidebar>
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
							aria-modal="true"
							// 设计稿：打开后焦点落在品牌链接，Esc 关闭后回到「打开导航」。
							initialFocus={sheetBrand}
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
							{renderNavigation("sheet", sheetBrand)}
						</SheetContent>
					</Sheet>
					<Breadcrumb className="platform-breadcrumb">
						<BreadcrumbList>
							<BreadcrumbItem>{chrome.crumbParent}</BreadcrumbItem>
							<BreadcrumbItem>
								<BreadcrumbPage>{chrome.title}</BreadcrumbPage>
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
							<h1 className="font-semibold text-[28px]">登录工作空间</h1>
							<p className="mt-5 text-muted-foreground" role="status">
								{session.isFetching
									? "正在确认登录状态…"
									: session.state.kind !== "loading" &&
										(session.state.retryable
											? "暂时无法确认登录状态，请重试。"
											: "请先登录，再查看 Agent、提交申请或继续对话。")}
							</p>
							{session.state.kind !== "loading" && (
								<div className="mt-5 space-y-4">
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
														throw new Error(
															"Login session was not established",
														);
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
						</main>
					)}
				</div>
			</div>
		</div>
	);
}
