/**
 * 路由外观表：面包屑、document.title 与当前导航项都从这里取值，
 * 保证同一路由在顶栏、标签页标题和侧栏中使用同一个分组与页面名。
 *
 * 未登记的路由按「页面不存在」处理，不按路径前缀猜测（#2297）。
 */

export type NavigationGroup = "工作区" | "我的管理" | "系统管理";

/** 侧栏导航项；顺序与名称以设计稿 renderSidebar 为准。 */
export const navigationLabels = {
	workbench: "工作台",
	agents: "Agent 目录",
	chat: "对话",
	skills: "Skill Hub",
	"my-agents": "我的 Agent",
	"application-form": "创建申请",
	"my-skills": "我的 Skill",
	"personal-keys": "个人 Relay Key",
	credentials: "API 凭证",
	audit: "我的执行审计",
	connection: "我的 Connection",
	approvals: "创建审批",
	"admin-agents": "Agent 管理",
	"skill-reviews": "Skill 审核",
	eval: "评测",
	"platform-audit": "平台审计",
	ops: "运维观测",
} as const;

export type NavigationKey = keyof typeof navigationLabels;

/**
 * 侧栏分组与顺序。设计稿中的 Builder 在 main 尚无路由，暂不列出；
 * 运维观测不在设计稿中，保留在系统管理末尾，去留待产品结论。
 */
export const navigationGroups: readonly {
	label: NavigationGroup;
	administratorOnly: boolean;
	items: readonly NavigationKey[];
}[] = [
	{
		label: "工作区",
		administratorOnly: false,
		items: ["workbench", "agents", "chat", "skills"],
	},
	{
		label: "我的管理",
		administratorOnly: false,
		items: [
			"my-agents",
			"application-form",
			"my-skills",
			"personal-keys",
			"credentials",
			"audit",
			"connection",
		],
	},
	{
		label: "系统管理",
		administratorOnly: true,
		items: [
			"approvals",
			"admin-agents",
			"skill-reviews",
			"eval",
			"platform-audit",
			"ops",
		],
	},
];

export type PageChrome = {
	/** 当前高亮的导航项；未登记路由没有当前项。 */
	navKey?: NavigationKey;
	/** 面包屑上级。 */
	crumbParent: string;
	/** 面包屑当前页，也是页面名。 */
	title: string;
	/** 浏览器标签页标题。 */
	documentTitle: string;
};

const productName = "Agora Agent";

function chrome(
	crumbParent: string,
	title: string,
	navKey?: NavigationKey,
): PageChrome {
	return {
		navKey,
		crumbParent,
		title,
		documentTitle: `${title} · ${productName}`,
	};
}

function groupOf(key: NavigationKey): NavigationGroup {
	const group = navigationGroups.find((candidate) =>
		candidate.items.includes(key),
	);
	if (!group) throw new Error(`Navigation item ${key} has no group`);
	return group.label;
}

/** 导航页本身：上级为所在分组，页面名为导航名称。 */
function navigationPage(key: NavigationKey): PageChrome {
	return chrome(groupOf(key), navigationLabels[key], key);
}

export const workbenchChrome: PageChrome = {
	...navigationPage("workbench"),
	documentTitle: `${productName} · Platform`,
};
export const notFoundChrome: PageChrome = chrome("工作区", "页面不存在");
/** 未登录时整页为登录入口，标题与设计稿 login.html 一致。 */
export const signInDocumentTitle = `登录 · ${productName}`;
const conversationSelectionChrome = chrome(
	"工作区",
	"选择 Agent 开始对话",
	"chat",
);

const segment = "[^/]+";
const rules: readonly { pattern: RegExp; chrome: PageChrome }[] = [
	{ pattern: /^\/$/, chrome: workbenchChrome },
	{ pattern: /^\/agents$/, chrome: navigationPage("agents") },
	{
		pattern: new RegExp(`^/agents/${segment}$`),
		chrome: chrome("Agent 目录", "Agent 详情", "agents"),
	},
	{
		pattern: new RegExp(`^/agents/${segment}/configuration$`),
		chrome: chrome("Agent 目录", "Owner 配置", "agents"),
	},
	// 旧会话入口与 /chat 都会重定向到对话，过渡期间保持对话高亮。
	{
		pattern: new RegExp(`^/agents/${segment}/conversations$`),
		chrome: navigationPage("chat"),
	},
	{ pattern: /^\/chat(?:\/.*)?$/, chrome: navigationPage("chat") },
	{ pattern: /^\/skills$/, chrome: navigationPage("skills") },
	{ pattern: /^\/skills\/manage$/, chrome: navigationPage("my-skills") },
	// 设计 skill-editor：['我的 Skill','创建与发布']，侧栏仍高亮我的 Skill。
	{
		pattern: /^\/skills\/manage\/new$/,
		chrome: chrome("我的 Skill", "创建与发布", "my-skills"),
	},
	{
		pattern: new RegExp(`^/skills/${segment}$`),
		chrome: chrome("Skill Hub", "Skill 详情", "skills"),
	},
	{ pattern: /^\/my-agents$/, chrome: navigationPage("my-agents") },
	{ pattern: /^\/my-agents\/new$/, chrome: navigationPage("application-form") },
	{
		pattern: new RegExp(`^/my-agents/${segment}$`),
		chrome: chrome("我的管理", "申请详情", "my-agents"),
	},
	{
		pattern: new RegExp(`^/my-agents/${segment}/edit$`),
		chrome: chrome("我的管理", "编辑申请", "my-agents"),
	},
	{
		pattern: /^\/my-settings\/relay-key$/,
		chrome: navigationPage("personal-keys"),
	},
	{
		pattern: /^\/my-settings\/api-credentials$/,
		chrome: navigationPage("credentials"),
	},
	{ pattern: /^\/audit$/, chrome: navigationPage("audit") },
	{ pattern: /^\/admin\/approvals$/, chrome: navigationPage("approvals") },
	{ pattern: /^\/admin\/agents$/, chrome: navigationPage("admin-agents") },
	{
		pattern: /^\/admin\/skill-reviews$/,
		chrome: navigationPage("skill-reviews"),
	},
	{ pattern: /^\/admin\/audit$/, chrome: navigationPage("platform-audit") },
	{ pattern: /^\/eval$/, chrome: navigationPage("eval") },
	{ pattern: /^\/ops$/, chrome: navigationPage("ops") },
];

/** 去掉尾部斜杠，根路径保持为 "/"。 */
export function normalizePathname(pathname: string): string {
	return pathname.replace(/\/+$/, "") || "/";
}

export function resolvePageChrome({
	pathname,
	conversationSelection = false,
	notFound = false,
}: {
	pathname: string;
	/** `/agents?mode=conversation`：从对话入口选择 Agent。 */
	conversationSelection?: boolean;
	/** 路由器判定的全局未匹配。 */
	notFound?: boolean;
}): PageChrome {
	if (notFound) return notFoundChrome;
	const path = normalizePathname(pathname);
	if (path === "/agents" && conversationSelection)
		return conversationSelectionChrome;
	return (
		rules.find((rule) => rule.pattern.test(path))?.chrome ?? notFoundChrome
	);
}
