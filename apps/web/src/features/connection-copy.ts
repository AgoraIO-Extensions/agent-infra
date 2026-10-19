/**
 * Connection 授权提示的共享文案：Agent 详情「连接器」与对话「会话上下文」的 needs-auth 正文。
 * Platform 不保存 Connection 授权状态，文案只说明去哪里完成授权，不断言当前主体是否已授权。
 */
export const connectionNeedsAuthDescription =
	"使用前需在独立 Connection 完成当前账号的授权；具体 Action allowlist 由 Connection Grant 决定，Platform 不保存或编辑这份授权。";
