import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { AuditIdentifier } from "./audit-identifier.js";
import {
	auditActionLabels,
	auditOutcomeLabel,
	auditPrincipalLabels,
	auditTimestamp,
	taskAuditReasonLabels,
} from "./audit-labels.js";
import type { AuditRecord } from "./audit-query.js";

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="min-w-0">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="mt-1 break-all">{children ?? "未提供"}</dd>
		</div>
	);
}
function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="border-t py-5">
			<h3 className="mb-4 font-semibold text-base">{title}</h3>
			<dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
				{children}
			</dl>
		</section>
	);
}
function Identifier({
	value,
	label,
}: {
	value: string | null | undefined;
	label: string;
}) {
	return <AuditIdentifier value={value} label={label} />;
}

export function AuditRecordDetail({ record }: { record: AuditRecord }) {
	const fact = record.operation?.fact;
	const connection = fact?.kind === "tool" ? fact.connection : undefined;
	return (
		<div>
			<div className="mb-5 flex flex-wrap items-center gap-3">
				<h2 className="font-semibold text-base">
					{auditActionLabels[record.action]}
				</h2>
				<Badge variant="outline" data-result={record.result}>
					{auditOutcomeLabel(record)}
				</Badge>
			</div>
			<Section title="操作与身份">
				<Field label="操作摘要">{record.summary}</Field>
				<Field label="审计 ID">
					<Identifier value={record.auditId} label="审计 ID" />
				</Field>
				<Field label="发生时间">{auditTimestamp(record.occurredAt)}</Field>
				<Field label="可信操作主体">
					{auditPrincipalLabels[record.actor.kind]} ·{" "}
					<Identifier value={record.actor.actorId} label="可信操作主体 ID" />
				</Field>
				<Field label="原发起主体">
					{record.originalPrincipal ? (
						<>
							{auditPrincipalLabels[record.originalPrincipal.kind]} ·{" "}
							<Identifier
								value={record.originalPrincipal.id}
								label="原发起主体 ID"
							/>
						</>
					) : null}
				</Field>
				<Field label="实际后台组件">{record.executor}</Field>
				<Field label="对象类型">{record.subject.kind}</Field>
				<Field label="对象 ID">
					<Identifier value={record.subject.subjectId} label="对象 ID" />
				</Field>
				<Field label="授权记录引用">
					<Identifier
						value={record.authorizationRecordId}
						label="授权记录引用"
					/>
				</Field>
			</Section>
			<Section title="请求与执行关联">
				<Field label="请求尝试 ID">
					<Identifier value={record.requestId} label="请求尝试 ID" />
				</Field>
				<Field label="原 Execution ID">
					<Identifier value={record.executionId} label="原 Execution ID" />
				</Field>
				<Field label="Agent ID">
					<Identifier value={record.agentId} label="Agent ID" />
				</Field>
				<Field label="Conversation ID">
					<Identifier value={record.conversationId} label="Conversation ID" />
				</Field>
				<Field label="Trace ID">
					<Identifier value={record.traceId} label="Trace ID" />
				</Field>
				<Field label="动作代码">{record.action}</Field>
			</Section>
			{record.taskApi && (
				<Section title="请求尝试结果">
					<Field label="请求操作">
						{
							{
								submit: "提交任务",
								read: "读取任务",
								cancel: "取消任务",
								subscribe: "订阅结果",
							}[record.taskApi.operation]
						}
					</Field>
					<Field label="请求阶段">
						{
							{
								access: "访问校验",
								"subscription.started": "订阅建立",
								"subscription.ended": "订阅结束",
							}[record.taskApi.phase]
						}
					</Field>
					<Field label="结果原因">
						{taskAuditReasonLabels[record.taskApi.reason]}
					</Field>
					<Field label="订阅 ID">
						<Identifier value={record.taskApi.subscriptionId} label="订阅 ID" />
					</Field>
				</Section>
			)}
			{fact && (
				<Section title="实际执行事实">
					<Field label="操作类型">
						{fact.kind === "model" ? "模型" : "工具"}
					</Field>
					<Field label="事实阶段">
						{
							{
								intent: "操作意图",
								started: "执行中",
								completed: "操作已完成",
								failed: "操作失败",
								unknown: "结果待核实",
							}[fact.phase]
						}
					</Field>
					<Field label="操作引用">
						<Identifier value={fact.operationRef} label="操作引用" />
					</Field>
					<Field label="尝试引用">
						<Identifier value={fact.attemptRef} label="尝试引用" />
					</Field>
					<Field label="父操作引用">
						<Identifier value={fact.parentOperationRef} label="父操作引用" />
					</Field>
					<Field label="事件 ID">
						<Identifier value={record.operation?.eventId} label="事件 ID" />
					</Field>
					<Field label="开始时间">
						{fact.startedAt ? auditTimestamp(fact.startedAt) : null}
					</Field>
					<Field label="完成时间">
						{fact.finishedAt ? auditTimestamp(fact.finishedAt) : null}
					</Field>
					<Field label="已确认耗时">
						{fact.durationMs === undefined ? "未采集" : `${fact.durationMs} ms`}
					</Field>
					<Field label="失败或未知原因">{fact.failureCode}</Field>
					{fact.kind === "model" ? (
						<>
							<Field label="模型 ID">
								<Identifier value={fact.model.modelId} label="模型 ID" />
							</Field>
							<Field label="模型选项">
								<Identifier value={fact.model.modelOptionId} label="模型选项" />
							</Field>
							<Field label="配置版本">
								<Identifier value={fact.model.configVersion} label="配置版本" />
							</Field>
							<Field label="推理强度">{fact.model.reasoningLevel}</Field>
							<Field label="输入 Token">
								{fact.usage?.inputTokens ?? "未采集"}
							</Field>
							<Field label="输出 Token">
								{fact.usage?.outputTokens ?? "未采集"}
							</Field>
							<Field label="缓存输入 Token">
								{fact.usage?.cachedInputTokens ?? "未采集"}
							</Field>
						</>
					) : (
						<>
							<Field label="工具 ID">
								<Identifier value={fact.toolId} label="工具 ID" />
							</Field>
							<Field label="结果引用">
								<Identifier value={fact.resultRef} label="结果引用" />
							</Field>
						</>
					)}
				</Section>
			)}
			{connection && (
				<Section title="Connection 关联">
					<Field label="服务引用">
						<Identifier value={connection.serviceRef} label="服务引用" />
					</Field>
					<Field label="调用引用">
						<Identifier value={connection.callRef} label="调用引用" />
					</Field>
					<Field label="核实状态">
						{connection.verification === "verified"
							? "关联已核实"
							: "关联未核实"}
					</Field>
					{connection.verification === "unverified" && (
						<Field label="未核实原因">{connection.reason}</Field>
					)}
				</Section>
			)}
		</div>
	);
}
