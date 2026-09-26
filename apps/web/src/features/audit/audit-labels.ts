import type { AuditRecord } from "./audit-query.js";

export const auditActionLabels: Record<AuditRecord["action"], string> = {
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
	"api.credential.issued": "签发 API 凭证",
	"api.credential.revoked": "撤销 API 凭证",
	"api.credential.delivery.granted": "授予凭证获取权限",
	"api.credential.delivery.revoked": "撤销凭证获取权限",
	"api.agent.grant.granted": "授予 Agent 权限",
	"api.agent.grant.revoked": "撤销 Agent 权限",
	"task.api.access": "任务 API 访问",
	"task.api.submit.result": "任务提交结果",
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
};

export const auditResultLabels: Record<AuditRecord["result"], string> = {
	succeeded: "成功",
	rejected: "已拒绝",
	failed: "失败",
	accepted: "已受理",
	intent: "操作意图",
	started: "执行中",
	submitted: "已提交",
	waiting: "等待中",
	processing: "执行中",
	completed: "已完成",
	cancelled: "已取消",
	unknown: "结果待核实",
};

export const taskAuditReasonLabels: Record<
	NonNullable<AuditRecord["taskApi"]>["reason"],
	string
> = {
	request_accepted: "访问获准",
	task_accepted: "任务已受理",
	task_replayed: "幂等重放",
	idempotency_conflict: "幂等请求冲突",
	agent_unavailable: "Agent 不可用",
	conversation_unavailable: "会话不可用",
	model_unavailable: "模型不可用",
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

export function auditOutcomeLabel(record: AuditRecord) {
	if (
		record.taskApi?.phase === "submit.result" &&
		record.result === "succeeded"
	)
		return record.taskApi.reason === "task_replayed"
			? "幂等重放"
			: record.taskApi.reason === "task_accepted"
				? "已受理"
				: auditResultLabels[record.result];
	if (record.taskApi?.phase === "access" && record.result === "succeeded")
		return "访问获准";
	return auditResultLabels[record.result];
}

export function auditTimestamp(value: string) {
	return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
