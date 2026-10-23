import { createHmac } from "node:crypto";

/**
 * 会话 Sandbox 文件交换凭据绑定的分配事实。取值只来自 Platform DB 中该 Session 当前的
 * Sandbox 分配（Worker 经 Store claim 取得，Platform API 按执行重新读取），不来自请求、
 * Runtime 回包或 Pod 名称。
 */
export interface SessionSandboxFileExchangeBindingV1 {
	readonly namespace: string;
	readonly sandboxId: string;
	readonly generation: number;
	readonly resourceFence: number;
}

const namespacePattern = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const sandboxIdPattern = /^[\x21-\x7e]{1,256}$/;

/**
 * 会话 Sandbox 的 Runtime 文件交换凭据（#3276，工程 Spec §10.1.1、§15.4.2）。
 *
 * 部署服务 token 对独立用途 `session-sandbox-file-exchange-v1`、namespace、Sandbox ID、
 * Session 代次与 resourceFence 做 HMAC-SHA256（base64url）。Worker 把它写进本 Sandbox
 * 自己的 Secret；Platform API 按执行当前的 Sandbox 分配重新计算后比较，不另行存储。
 * 用途与 `session-sandbox-v1` 传输 token 不同，两者不能互换；代次或 resourceFence
 * 前进后旧值不再匹配，部署 token 轮换会使全部派生值一起失效。
 */
export function sessionSandboxFileExchangeTokenV1(
	deploymentServiceToken: string,
	binding: SessionSandboxFileExchangeBindingV1,
): string {
	if (
		typeof deploymentServiceToken !== "string" ||
		deploymentServiceToken.length === 0 ||
		typeof binding?.namespace !== "string" ||
		!namespacePattern.test(binding.namespace) ||
		typeof binding.sandboxId !== "string" ||
		!sandboxIdPattern.test(binding.sandboxId) ||
		!Number.isSafeInteger(binding.generation) ||
		binding.generation < 1 ||
		!Number.isSafeInteger(binding.resourceFence) ||
		binding.resourceFence < 1
	)
		throw new TypeError("Session Sandbox file exchange binding is invalid");
	return createHmac("sha256", deploymentServiceToken)
		.update(
			`session-sandbox-file-exchange-v1\0${binding.namespace}\0${binding.sandboxId}\0${binding.generation}\0${binding.resourceFence}`,
		)
		.digest("base64url");
}
