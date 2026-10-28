import type { ChipTone } from "@/lib/status-tone";
import type { AuditRecord } from "./audit-query.js";

export const auditActionLabels: Record<AuditRecord["action"], string> = {
	"connection.installation.begin": "发起 Connection 安装",
	"connection.installation.confirm": "确认 Connection 安装",
	"skill.version.register": "Skill 版本登记",
	"skill.version.review": "Skill 版本审核",
	"skill.version.revoke": "Skill 版本撤销",
	"skill.version.read": "Skill 版本读取",
	"skill.version.refused": "Skill 操作拒绝",
	"agent.application.submitted": "提交创建申请",
	"agent.application.updated": "修改创建申请",
	"agent.application.resubmitted": "重新提交申请",
	"agent.application.withdrawn": "撤回申请",
	"agent.application.approved": "批准创建申请",
	"agent.application.rejected": "驳回创建申请",
	"agent.lifecycle.stopped": "停止 Agent",
	"agent.lifecycle.restarted": "重启 Agent",
	"agent.lifecycle.creation_retried": "重试创建",
	"agent.lifecycle.disabled": "停用 Agent",
	"agent.workload.creation_succeeded": "实例创建成功",
	"agent.workload.creation_failed": "实例创建失败",
	"agent.workload.service_starting": "服务启动中",
	"agent.workload.service_ready": "服务就绪",
	"agent.workload.service_updating": "服务更新中",
	"agent.workload.service_unavailable": "服务暂不可用",
	"agent.configuration.revised": "修改 Agent 配置",
	"agent.access.updated": "修改可用范围",
	"api.access.rejected": "拒绝 API 访问",
	"api.application.created": "创建应用",
	"application.credential.issued": "签发应用 API 凭证",
	"application.credential.rotated": "轮换应用 API 凭证",
	"application.credential.delivery": "交付应用 API 凭证",
	"application.credential.metadata.read": "查看应用 API 凭证元数据",
	"application.credential.revoked": "撤销应用 API 凭证",
	"api.credential.issued": "签发 API 凭证",
	"api.credential.revoked": "撤销 API 凭证",
	"api.credential.narrowed": "收窄个人 API 凭证",
	"api.credential.metadata.read": "查看个人 API 凭证元数据",
	"api.credential.delivery.granted": "授予凭证获取权限",
	"api.credential.delivery.revoked": "撤销凭证获取权限",
	"api.agent.grant.granted": "授予 Agent 权限",
	"api.agent.grant.revoked": "撤销 Agent 权限",
	"api.agent.metadata.read": "API Agent 元数据读取",
	"api.agent.create.accepted": "API 创建 Agent",
	"api.agent.create.replayed": "Agent 创建请求重放",
	"api.agent.create.refused": "Agent 创建请求拒绝",
	"api.agent.state.read": "读取 Agent 状态",
	"api.agent.manager.granted": "授予 Agent API 管理权限",
	"api.agent.manager.revoked": "撤销 Agent API 管理权限",
	"api.agent.manager.replayed": "管理授权请求重放",
	"api.agent.lifecycle.refused": "生命周期请求拒绝",
	"api.agent.use.granted": "授予应用 Agent 使用权限",
	"api.agent.use.revoked": "撤销应用 Agent 使用权限",
	"api.agent.use.replayed": "重试应用 Agent 使用授权",
	"api.agent.use.refused": "拒绝应用 Agent 使用授权变更",
	"api.agent.manager.refused": "管理授权请求拒绝",
	"api.agent.state.refused": "状态读取拒绝",
	"platform.user.disabled": "停用平台用户",
	"platform.user.reenabled": "解除平台用户停用",
	"relay_key.personal.read": "查看个人 Relay Key 状态",
	"relay_key.personal.replace": "替换个人 Relay Key",
	"relay_key.personal.revoke": "撤销个人 Relay Key",
	"relay_key.agent_default.replace": "替换 Agent 默认 Relay Key",
	"skill.project.create": "创建 Skill 项目",
	"skill.project.update": "更新 Skill 项目",
	"skill.project.list": "列出 Skill 项目",
	"skill.project.read": "查看 Skill 项目",
	"relay_key.agent_default.read": "查看 Agent 默认 Relay Key 状态",
	"relay_key.agent_default.candidates": "查询 Agent 默认 Relay Key 候选",
	"task.api.access": "任务 API 访问",
	"task.api.subscription.started": "建立结果订阅",
	"task.api.subscription.ended": "结束结果订阅",
	"task.authorization.accepted": "保存任务授权",
	"task.status.changed": "任务状态变化",
	"task.control.created": "创建任务控制",
	"execution.operation.observed": "记录执行操作",
	"conversation.task.accepted": "受理对话任务",
	"conversation.message.accepted": "受理对话消息",
	"conversation.regeneration.accepted": "受理重新生成",
	"conversation.stop.accepted": "受理停止请求",
	"conversation.model_selection.updated": "切换模型选择",
	"conversation.model_selection.fell_back": "模型选择回退",
	"conversation.task.status": "对话任务状态",
	"secret.decrypt": "解密凭证",
	"secret.activate": "激活凭证版本",
	"secret.rewrap": "更新凭证加密",
	"secret.retire-key": "退役加密密钥",
	"audit.query.completed": "完成审计查询",
	"audit.query.failed": "审计查询失败",
	"wecom.setup_started": "开始企业微信配置",
	"wecom.credentials_submitted": "提交企业微信凭证",
	"wecom.setup_cancelled": "取消企业微信配置",
	"wecom.setup_expired": "企业微信配置过期",
	"wecom.setup_failed": "企业微信配置失败",
	"wecom.callback_verified": "验证企业微信回调",
	"wecom.setup_activated": "启用企业微信配置",
	"wecom.connection_verifying": "验证企业微信连接",
	"wecom.connection_connected": "企业微信连接成功",
	"wecom.connection_disconnected": "企业微信连接断开",
	"wecom.connection_auth_failed": "企业微信认证失败",
	"wecom.denied": "拒绝企业微信消息",
	"wecom.unavailable": "企业微信渠道不可用",
	"wecom.conflict": "企业微信消息冲突",
	"wecom.accepted": "受理企业微信消息",
	"wecom.unknown": "企业微信消息状态待核实",
	"wecom.sending": "发送企业微信消息中",
	"wecom.sent": "企业微信消息已发送",
	"wecom.failed": "企业微信消息发送失败",
	"wecom.cancelled": "取消企业微信消息",
	"wecom.expired": "企业微信消息过期",
	"wecom.abandoned": "放弃企业微信消息",
	"wecom.conversation_started": "企业微信开始新会话",
	"wecom.conversation_unavailable": "企业微信会话不可用",
	"wecom.media_rejected": "拒绝企业微信媒体消息",
};

export const auditResultLabels: Record<AuditRecord["result"], string> = {
	succeeded: "成功",
	rejected: "已拒绝",
	failed: "失败",
	accepted: "已受理",
	intent: "操作意图",
	// G5-09：两个值语义不同、在「结果」筛选里不能同名。started 是单次模型 / 工具操作已实际开始
	// （execution.operation.observed 的 fact.phase，完成与失败另有记录），与执行详情的操作阶段同为
	// 「已开始」；processing 是任务 / Execution 状态（task.status.changed），与对话页同为「处理中」。
	started: "已开始",
	submitted: "已提交",
	waiting: "等待中",
	processing: "处理中",
	completed: "已完成",
	cancelled: "已取消",
	unknown: "结果待核实",
};

export const taskAuditReasonLabels: Record<
	NonNullable<AuditRecord["taskApi"]>["reason"],
	string
> = {
	request_accepted: "访问获准",
	invalid_request: "请求无效",
	authentication_required: "需要登录",
	authorization_revoked: "授权已撤销",
	missing_scope: "凭证范围不足",
	resource_unavailable: "资源不可用",
	capacity_full: "等待容量已满",
	conflict: "操作冲突",
	dependency_unavailable: "依赖暂不可用",
	client_disconnected: "客户端断开",
	stream_ended: "订阅结束",
	subscription_unconfirmed: "订阅结果未确认",
};

export const auditPrincipalLabels = {
	user: "用户",
	application: "应用",
	system: "后台组件",
	unknown: "未确认主体",
};

export const auditSubjectLabels: Record<
	AuditRecord["subject"]["kind"],
	string
> = {
	agent_application: "创建申请",
	agent: "Agent",
	secret: "Secret",
	secret_key: "Secret 键",
	grant: "授权记录",
	unknown: "未确认对象",
	conversation: "Conversation",
	execution: "Execution",
	configuration: "配置",
	api_credential: "API 凭证",
	application: "应用",
};

/**
 * 对象列的主文字（F-03）：服务端按当前权限返回的 Agent / 创建申请名称；其他对象显示类型，
 * 有可见的所属 Agent 时附上 Agent 名称。没有名称时只给类型，ID 始终以短形式另行显示。
 */
export function auditObjectName(record: AuditRecord) {
	const type = auditSubjectLabels[record.subject.kind];
	if (record.subject.displayName) return record.subject.displayName;
	if (record.agentDisplayName && record.subject.kind !== "agent")
		return `${record.agentDisplayName} · ${type}`;
	return type;
}

export function auditOutcomeLabel(record: AuditRecord) {
	if (
		record.taskApi?.phase === "access" &&
		(record.result === "accepted" || record.result === "succeeded")
	)
		return "访问获准";
	return auditResultLabels[record.result];
}

// 审计结果只有成功与失败带颜色，其余结果（含已拒绝）保持中性，与 statusTone 不同。
export function auditResultTone(result: AuditRecord["result"]): ChipTone {
	if (result === "succeeded") return "green";
	if (result === "failed") return "red";
	return "gray";
}
