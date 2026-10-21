import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { shortIdentifier } from "@/components/ui/identifier-text";
import { Timestamp } from "@/components/ui/timestamp";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
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

/**
 * 设计 dl.facts 的一对 dt / dd（标签列 150px、13px，dt muted）；
 * mono 用于 ID 与引用类字段，值缺失时显示「未提供」。
 */
function Field({
	label,
	mono = false,
	children,
}: {
	label: string;
	mono?: boolean;
	children: ReactNode;
}) {
	const value = children ?? "未提供";
	return (
		<>
			<dt>{label}</dt>
			<dd className={mono && children != null ? "font-mono" : undefined}>
				{value}
			</dd>
		</>
	);
}
function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="border-t py-5">
			<h3 className="mb-4 font-semibold text-base">{title}</h3>
			<dl className="review-facts">{children}</dl>
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
 * 审计主体名称：用户显示目录姓名（未解析时附 ID 短形式）；应用有服务端按权限返回的名称时
 * 显示「应用 · 名称」；其余（含无权查看名称的应用）显示类型中文名加等宽 ID 短形式。
 * 列表行内不提供展开或复制按钮。
 */
export function AuditPrincipalName({
	kind,
	id,
	displayName = null,
	names,
}: {
	kind: AuditRecord["actor"]["kind"];
	id: string;
	displayName?: string | null;
	names: DirectoryNames;
}) {
	if (kind === "application" && displayName)
		return (
			<span title={id}>
				{auditPrincipalLabels.application} · {displayName}
			</span>
		);
	if (kind !== "user")
		return (
			<>
				{auditPrincipalLabels[kind]}{" "}
				<code className="font-mono" title={id}>
					{shortIdentifier(id)}
				</code>
			</>
		);
	return (
		<DirectoryNameText
			name={names.resolve(id)}
			status={names.status}
			identifier
		/>
	);
}

/** 详情中的主体：先显示名称，完整 ID 作为等宽次要文字保留以便核对。 */
function AuditPrincipalDetail({
	kind,
	id,
	displayName,
	names,
}: {
	kind: AuditRecord["actor"]["kind"];
	id: string;
	displayName: string | null;
	names: DirectoryNames;
}) {
	return (
		<>
			{kind === "user" ? (
				<DirectoryNameText name={names.resolve(id)} status={names.status} />
			) : kind === "application" && displayName ? (
				`${auditPrincipalLabels.application} · ${displayName}`
			) : (
				auditPrincipalLabels[kind]
			)}
			{/* 设计 small.mono：ID 行 11px / 1.65，与列表「对象」列的 IdentifierText 相同（E3-09）。 */}
			<small className="block break-all font-mono text-[11px] text-muted-foreground leading-[1.65]">
				{id}
			</small>
		</>
	);
}

/** 服务端可能为其返回名称的对象类型（Agent 与创建申请）。 */
const nameableSubjects = new Set<AuditRecord["subject"]["kind"]>([
	"agent",
	"agent_application",
]);

/** 详情标题：读取成功后为「{事件} · {结果}」。 */
export function auditDetailHeading(record: AuditRecord) {
	return `${auditActionLabels[record.action]} · ${auditOutcomeLabel(record)}`;
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
			<Section title="操作与身份">
				<Field label="结果">
					<Badge tone={auditResultTone(record.result)}>
						{auditOutcomeLabel(record)}
					</Badge>
				</Field>
				<Field label="事件">{auditActionLabels[record.action]}</Field>
				<Field label="操作摘要">{record.summary}</Field>
				<Field label="审计 ID" mono>
					{record.auditId}
				</Field>
				<Field label="发生时间">
					<Timestamp value={record.occurredAt} style="absolute" />
				</Field>
				<Field label="可信操作主体">
					<AuditPrincipalDetail
						kind={record.actor.kind}
						id={record.actor.actorId}
						displayName={record.actor.displayName}
						names={names}
					/>
				</Field>
				<Field label="原发起主体">
					{record.originalPrincipal ? (
						<AuditPrincipalDetail
							kind={record.originalPrincipal.kind}
							id={record.originalPrincipal.id}
							displayName={record.originalPrincipal.displayName}
							names={names}
						/>
					) : null}
				</Field>
				<Field label="实际后台组件">{record.executor}</Field>
				<Field label="对象类型">
					{auditSubjectLabels[record.subject.kind]}
				</Field>
				{/* 名称由服务端按当前权限返回；无权或无法确认时显示「未提供」，不区分原因。 */}
				{nameableSubjects.has(record.subject.kind) && (
					<Field label="对象名称">{record.subject.displayName}</Field>
				)}
				<Field label="对象 ID" mono>
					{record.subject.subjectId}
				</Field>
				<Field label="授权记录引用" mono>
					{record.authorizationRecordId}
				</Field>
			</Section>
			<Section title="请求与执行关联">
				<Field label="请求尝试 ID" mono>
					{record.requestId}
				</Field>
				<Field label="原 Execution ID" mono>
					{record.executionId}
				</Field>
				{record.agentId !== null && (
					<Field label="Agent 名称">{record.agentDisplayName}</Field>
				)}
				<Field label="Agent ID" mono>
					{record.agentId}
				</Field>
				<Field label="Conversation ID" mono>
					{record.conversationId}
				</Field>
				<Field label="Trace ID" mono>
					{record.traceId}
				</Field>
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
					<Field label="订阅 ID" mono>
						{record.taskApi.subscriptionId}
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
					<Field label="操作引用" mono>
						{fact.operationRef}
					</Field>
					<Field label="尝试引用" mono>
						{fact.attemptRef}
					</Field>
					<Field label="父操作引用" mono>
						{fact.parentOperationRef}
					</Field>
					<Field label="事件 ID" mono>
						{record.operation?.eventId}
					</Field>
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
							<Field label="模型 ID" mono>
								{fact.model.modelId}
							</Field>
							<Field label="模型选项" mono>
								{fact.model.modelOptionId}
							</Field>
							<Field label="配置版本" mono>
								{fact.model.configVersion}
							</Field>
							<Field label="推理强度">
								{fact.model.reasoningLevel
									? reasoningLevelLabel(fact.model.reasoningLevel)
									: null}
							</Field>
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
							<Field label="工具 ID" mono>
								{fact.toolId}
							</Field>
							<Field label="结果引用" mono>
								{fact.resultRef}
							</Field>
						</>
					)}
				</Section>
			)}
			{connection && (
				<Section title="Connection 关联">
					<Field label="服务引用" mono>
						{connection.serviceRef}
					</Field>
					<Field label="调用引用" mono>
						{connection.callRef}
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
