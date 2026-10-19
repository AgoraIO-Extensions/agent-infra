import {
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import {
	Link,
	useLinkProps,
	useLocation,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
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
	Shield,
	X,
} from "lucide-react";
import {
	createContext,
	Fragment,
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
import { LoadingLine } from "@/components/ui/spinner";
import type { BrowserSessionProjectionV1 } from "../pilot/generated/types.gen";
import { connectionEntryUrl } from "./connection-entry";
import { LoginPage } from "./login-page";
import { LogoutAction } from "./logout-action";
import {
	type NavigationKey,
	navigationGroups,
	navigationLabels,
	resolvePageChrome,
	signInDocumentTitle,
} from "./page-chrome";
import { PageStateCard } from "./page-state-card";
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

/**
 * 品牌链接回到工作台，但它不是导航项：去掉 Link 在「/」上自动补的 aria-current 与
 * data-status，当前页只由「工作台」导航项标出（N-21）。
 */
function BrandLink({
	ref,
	onClick,
	children,
}: {
	ref?: RefObject<HTMLAnchorElement | null>;
	onClick: () => void;
	children: ReactNode;
}) {
	const {
		"aria-current": _current,
		"data-status": _status,
		...props
	} = useLinkProps({ to: "/", onClick }, ref) as ReturnType<
		typeof useLinkProps
	> & { "data-status"?: string };
	return (
		<a {...props} className="platform-brand">
			{children}
		</a>
	);
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
	const [sheet, setSheet] = useState(false);
	const sessionKind = session.state.kind;
	// 只有服务端确认未登录（401、retryable: false）才整页渲染登录页；
	// 确认中与可重试失败都留在壳层骨架内，不出现登录标题与「尚未登录」（R4-02）。
	const confirmedAnonymous =
		session.state.kind === "unavailable" && !session.state.retryable;
	const sessionUnavailable =
		session.state.kind === "unavailable" && session.state.retryable;
	const router = useRouter();
	const expiredReason = useLocation({
		select: (location) =>
			(location.search as Record<string, unknown>).reason === "expired",
	});
	// 过期只保存在内存：已就绪的会话变为确认未登录，且不是用户主动退出。
	const [sessionExpired, setSessionExpired] = useState(false);
	const authenticatedBefore = useRef(false);
	const loggedOut = useRef(false);
	useEffect(() => {
		if (sessionKind === "ready") {
			authenticatedBefore.current = true;
			loggedOut.current = false;
			setSessionExpired(false);
		} else if (confirmedAnonymous) {
			if (authenticatedBefore.current && !loggedOut.current)
				setSessionExpired(true);
			authenticatedBefore.current = false;
			loggedOut.current = false;
		}
		// 离开就绪态时窄屏导航随应用壳卸载；重新登录后不应自动再次展开。
		if (sessionKind !== "ready") setSheet(false);
	}, [sessionKind, confirmedAnonymous]);
	// 会话就绪后去掉 reason 参数，保留其他查询参数，避免之后退出时误报过期。
	useEffect(() => {
		if (sessionKind !== "ready" || !expiredReason) return;
		const { pathname, search, hash } = router.history.location;
		const params = new URLSearchParams(search);
		params.delete("reason");
		const query = params.toString();
		router.history.replace(`${pathname}${query ? `?${query}` : ""}${hash}`);
	}, [sessionKind, expiredReason, router]);
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
	// 与 Agent 详情「打开 Connection」、对话上下文条共用同一个入口函数（NI-01 / NI-68、BR-04）。
	const connectionUrl =
		session.state.kind === "ready"
			? connectionEntryUrl(session.state.connection)
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
	// 确认未登录时整页是登录入口，标签页标题与登录页一致；确认中沿用目标页标题。
	const documentTitle = confirmedAnonymous
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
			<Fragment key="connection">
				<span
					className="platform-nav-item platform-nav-unavailable"
					aria-disabled="true"
					aria-describedby={reasonId}
				>
					<KeyRound {...navigationIconProps} />
					{navigationLabels.connection}
					{/* 设计宽度 219px 内保持单行：chip 用「不可用」且不带状态圆点。 */}
					<Badge tone="gray" className="platform-nav-chip before:hidden">
						不可用
					</Badge>
				</span>
				{/* 说明放在项外，避免读屏把内容与描述各读一遍；不展示原始 reason 值。 */}
				<span id={reasonId} className="sr-only">
					Connection 服务当前不可用。
				</span>
			</Fragment>
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
						{/* 设计 renderSidebar：item('credentials','API 凭证','key')。 */}
						<KeyRound {...navigationIconProps} />
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
			case "skill-reviews":
				// 设计 renderSidebar：item('skill-reviews','Skill 审核','shield')。
				return (
					<Link
						key={key}
						{...navigationItemProps(key)}
						to="/admin/skill-reviews"
					>
						<Shield {...navigationIconProps} />
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
			<BrandLink ref={brandRef} onClick={closeSheet}>
				<span className="platform-brand-mark" aria-hidden="true">
					A
				</span>
				<div>
					<strong>Agora Agent</strong>
					<small>Platform workspace</small>
				</div>
			</BrandLink>
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
						onLoggedOut={() => {
							// 主动退出后的未登录不是「登录已过期」。
							loggedOut.current = true;
							return session.refetch();
						}}
					/>
				)}
			</div>
		</>
	);
	// 会话确认期与可重试失败的侧栏骨架：品牌块与导航占位行同宽、同位置，
	// 不渲染可点击的导航项、身份卡与「尚未登录」；就绪后只在末尾追加系统管理分组。
	const renderNavigationSkeleton = () => (
		<>
			<div className="platform-brand" aria-hidden="true">
				<span className="platform-brand-mark">A</span>
				<div>
					<strong>Agora Agent</strong>
					<small>Platform workspace</small>
				</div>
			</div>
			<div className="platform-nav-skeleton" aria-hidden="true">
				{navigationGroups
					.filter((group) => !group.administratorOnly)
					.map((group) => (
						<div key={group.label} className="platform-nav-group">
							<p className="platform-nav-label">{group.label}</p>
							{group.items.map((key) => (
								<span key={key} className="platform-nav-item">
									<span className="platform-skeleton-line" />
								</span>
							))}
						</div>
					))}
			</div>
		</>
	);
	if (confirmedAnonymous)
		return (
			<LoginPage
				loginUrl={loginUrl}
				development={development}
				expired={sessionExpired || expiredReason}
				onLoggedIn={async () => {
					const result = await session.refetch();
					if (result.data?.kind !== "ready")
						throw new Error("Login session was not established");
				}}
			/>
		);
	const ready = session.state.kind === "ready";
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
				{ready ? renderNavigation("sidebar") : renderNavigationSkeleton()}
			</Sidebar>
			<div className="platform-workspace">
				<header className="platform-topbar">
					{ready ? (
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
					) : (
						// 确认期保留菜单按钮的位置与尺寸，但不提供导航入口。
						<span
							className="mobile-menu platform-menu-placeholder"
							aria-hidden="true"
						/>
					)}
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
					) : sessionUnavailable ? (
						// 重试用尽仍无法确认：登录状态未知，不给登录表单，只提供重新检查。
						<main className="platform-content">
							<PageStateCard
								kind="unavailable"
								headingLevel={1}
								description="暂时无法确认登录状态，请稍后重试。"
								action={
									<Button
										variant="outline"
										onClick={() => void session.refetch()}
										disabled={session.isFetching}
									>
										{session.isFetching ? "正在检查…" : "重新检查"}
									</Button>
								}
							/>
						</main>
					) : (
						<main className="platform-content">
							<LoadingLine>正在确认登录状态…</LoadingLine>
						</main>
					)}
				</div>
			</div>
		</div>
	);
}
