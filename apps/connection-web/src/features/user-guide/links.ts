const docs =
	"https://github.com/AgoraIO-Extensions/agent-infra/blob/connection/docs";

// Only published pages and documented endpoints, never examples or credentials.
const destinations: Record<string, string> = {
	"/connection/agent/llms.txt": "/connection/agent/llms.txt",
	"/connection/agent/": "/connection/agent/",
	"/connection/login": "/connection/login",
	"/connection/": "/connection/",
	"/llms.txt": "/llms.txt",
	"/mcp": "/mcp",
	登录控制台: "/connection/login",
	"Connection 控制台": "/connection/connections",
	控制台: "/connection/connections",
	"“我的 Connection”": "/connection/connections",
	"“待我审批”": "/connection/approvals",
	"“访问令牌”": "/connection/tokens",
	访问令牌页面: "/connection/tokens",
	"“审批管理”": "/connection/admin/approval",
	"“Agent 接入”": "/connection/admin/agents",
	"“共享 Connection”": "/connection/admin/shared-connections",
	"“管理员”": "/connection/admin/administrators",
	"“操作记录”": "/connection/admin/action-calls",
	"Connection PRD": `${docs}/prd/PRD-connection-M1.md`,
	"Connection HLD": `${docs}/architecture/HLD-connection-M1.md`,
	"Connection 生产部署说明": `${docs}/architecture/connection-production.md`,
};
const pattern = new RegExp(
	`(${Object.keys(destinations)
		.sort((a, b) => b.length - a.length)
		.map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|")})`,
	"g",
);

export function guideLinkParts(text: string) {
	return text
		.split(pattern)
		.filter(Boolean)
		.map((part) => ({
			text: part,
			href: Object.hasOwn(destinations, part) ? destinations[part] : undefined,
		}));
}
