import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { IdentifierText } from "@/components/ui/identifier-text";
import { Timestamp } from "@/components/ui/timestamp";
import { type DirectoryNames, DirectoryNameText } from "../directory-names.js";
import {
	auditActionLabels,
	auditOutcomeLabel,
	auditPrincipalLabels,
	auditResultTone,
	auditSubjectLabels,
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

/** 列表与详情中需要按目录解析的用户主体 ID。 */
export function auditUserIds(records: readonly AuditRecord[]) {
	return records.flatMap((record) => [
		...(record.actor.kind === "user" ? [record.actor.actorId] : []),
		...(record.originalPrincipal?.kind === "user"
			? [record.originalPrincipal.id]
			: []),
	]);
}

/**
 * 审计主体：用户显示目录姓名，未解析时附 ID 短形式；详情面板附可复制的完整 ID 以便核对。
 * 后台组件与应用主体不在目录中，保持原标识。
 */
export function AuditPrincipalName({
	kind,
	id,
	names,
	detail = false,
	label = "主体 ID",
}: {
	kind: AuditRecord["actor"]["kind"];
	id: string;
	names: DirectoryNames;
	detail?: boolean;
	/** 详情面板复制按钮的对象名，同一面板内的多个主体需要不同名称。 */
	label?: string;
}) {
	if (kind !== "user") return <>{id}</>;
	const name = names.resolve(id);
	return (
		<>
			<DirectoryNameText
				name={name}
				status={names.status}
				identifier={!detail}
			/>
			{detail ? (
				<>
					{" "}
					<IdentifierText value={id} label={label} copyable />
				</>
			) : null}
		</>
	);
}

export function AuditRecordDetail({
	record,
	names,
}: {
	record: AuditRecord;
	names: DirectoryNames;
}) {
	const fact = record.operation?.fact;
	const connection = fact?.kind === "tool" ? fact.connection : undefined;
	return (
		<div>
			<div className="mb-5 flex flex-wrap items-center gap-3">
				<h2 className="font-semibold text-base">
					{auditActionLabels[record.action]}
				</h2>
				<Badge tone={auditResultTone(record.result)}>
					{auditOutcomeLabel(record)}
				</Badge>
			</div>
			<Section title="操作与身份">
				<Field label="操作摘要">{record.summary}</Field>
				<Field label="审计 ID">{record.auditId}</Field>
				<Field label="发生时间">
					<Timestamp value={record.occurredAt} style="absolute" />
				</Field>
				<Field label="可信操作主体">
					{auditPrincipalLabels[record.actor.kind]} ·{" "}
					<AuditPrincipalName
						kind={record.actor.kind}
						id={record.actor.actorId}
						names={names}
						detail
						label="可信操作主体 ID"
					/>
				</Field>
				<Field label="原发起主体">
					{record.originalPrincipal ? (
						<>
							{auditPrincipalLabels[record.originalPrincipal.kind]} ·{" "}
							<AuditPrincipalName
								kind={record.originalPrincipal.kind}
								id={record.originalPrincipal.id}
								names={names}
								detail
								label="原发起主体 ID"
							/>
						</>
					) : null}
				</Field>
				<Field label="实际后台组件">{record.executor}</Field>
				<Field label="对象类型">
					{auditSubjectLabels[record.subject.kind]}
				</Field>
				<Field label="对象 ID">{record.subject.subjectId}</Field>
				<Field label="授权记录引用">{record.authorizationRecordId}</Field>
			</Section>
			<Section title="请求与执行关联">
				<Field label="请求尝试 ID">{record.requestId}</Field>
				<Field label="原 Execution ID">{record.executionId}</Field>
				<Field label="Agent ID">{record.agentId}</Field>
				<Field label="Conversation ID">{record.conversationId}</Field>
				<Field label="Trace ID">{record.traceId}</Field>
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
					<Field label="订阅 ID">{record.taskApi.subscriptionId}</Field>
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
					<Field label="操作引用">{fact.operationRef}</Field>
					<Field label="尝试引用">{fact.attemptRef}</Field>
					<Field label="父操作引用">{fact.parentOperationRef}</Field>
					<Field label="事件 ID">{record.operation?.eventId}</Field>
					<Field label="开始时间">
						{fact.startedAt ? (
							<Timestamp value={fact.startedAt} style="absolute" />
						) : null}
					</Field>
					<Field label="完成时间">
						{fact.finishedAt ? (
							<Timestamp value={fact.finishedAt} style="absolute" />
						) : null}
					</Field>
					<Field label="已确认耗时">
						{fact.durationMs === undefined ? "未采集" : `${fact.durationMs} ms`}
					</Field>
					<Field label="失败或未知原因">{fact.failureCode}</Field>
					{fact.kind === "model" ? (
						<>
							<Field label="模型 ID">{fact.model.modelId}</Field>
							<Field label="模型选项">{fact.model.modelOptionId}</Field>
							<Field label="配置版本">{fact.model.configVersion}</Field>
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
							<Field label="工具 ID">{fact.toolId}</Field>
							<Field label="结果引用">{fact.resultRef}</Field>
						</>
					)}
				</Section>
			)}
			{connection && (
				<Section title="Connection 关联">
					<Field label="服务引用">{connection.serviceRef}</Field>
					<Field label="调用引用">{connection.callRef}</Field>
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
