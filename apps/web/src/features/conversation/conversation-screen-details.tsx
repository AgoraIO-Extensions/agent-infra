import { useEffect, useRef } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "../../components/ui/button.js";
import type {
	ExecutionDetailProjectionV2,
	PersistedConversationEventV2,
} from "../../pilot/generated-v2/types.gen.js";
import {
	commandFailure,
	executionStatusLabels,
} from "./conversation-screen-state.js";

export function ConversationExecutionDetails({
	data,
	loading,
	failed,
	onRetry,
	onClose,
}: {
	data?: ExecutionDetailProjectionV2;
	loading: boolean;
	failed: boolean;
	onRetry: () => void;
	onClose: () => void;
}) {
	const title = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		title.current?.focus();
	}, []);
	return (
		<section
			aria-label="执行详情"
			className="space-y-4 border-border border-t py-6"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 ref={title} tabIndex={-1} className="font-semibold text-xl">
					执行详情
				</h2>
				<Button variant="outline" onClick={onClose}>
					返回对话
				</Button>
			</div>
			{loading && <p role="status">正在读取执行记录…</p>}
			{failed && (
				<Alert className="space-y-2">
					<AlertDescription>执行记录暂时无法读取。</AlertDescription>
					<Button variant="outline" onClick={onRetry}>
						重新读取详情
					</Button>
				</Alert>
			)}
			{data && (
				<>
					<p>{executionStatusLabels[data.status]}</p>
					<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
						<dt>执行标识</dt>
						<dd className="break-all font-mono">{data.executionId}</dd>
						<dt>开始时间</dt>
						<dd>{data.startedAt ?? "未提供"}</dd>
						<dt>结束时间</dt>
						<dd>{data.finishedAt ?? "尚未确认结束"}</dd>
					</dl>
					{data.error && (
						<Alert variant="destructive">
							<AlertDescription>
								{commandFailure(data.error.code)}
							</AlertDescription>
						</Alert>
					)}
					<h3 className="font-semibold">过程摘要</h3>
					{data.processSummary.length ? (
						<ul className="space-y-3">
							{data.processSummary.map((item, index) => (
								<li
									key={`${item.occurredAt}-${index}`}
									className="border-border border-l-2 pl-3"
								>
									<p>{item.summary}</p>
									<p className="text-muted-foreground text-sm">
										{item.kind === "agent_summary"
											? "Agent 提供的摘要"
											: "Platform 记录"}{" "}
										· {item.occurredAt}
									</p>
								</li>
							))}
						</ul>
					) : (
						<p className="text-muted-foreground">尚无过程摘要。</p>
					)}
					<h3 className="font-semibold">模型与工具调用事实</h3>
					<OperationFacts events={data.events} />
					<p className="text-muted-foreground text-sm">
						未提供的耗时、用量或外部操作结果保持未知。Connection
						关联引用不授予访问权限。
					</p>
					<Button variant="outline" disabled={loading} onClick={onRetry}>
						核实原执行状态
					</Button>
				</>
			)}
		</section>
	);
}
function OperationFacts({
	events,
}: {
	events: readonly PersistedConversationEventV2[];
}) {
	const operations = new Map<
		string,
		Extract<PersistedConversationEventV2, { type: "execution.operation" }>
	>();
	for (const event of events)
		if (event.type === "execution.operation")
			operations.set(
				JSON.stringify([event.payload.operationRef, event.payload.attemptRef]),
				event,
			);
	if (!operations.size)
		return <p className="text-muted-foreground">尚无经采集的调用事实。</p>;
	const phases = {
		intent: "准备中",
		started: "已开始",
		completed: "已完成",
		failed: "失败",
		unknown: "结果待核实",
	};
	return (
		<ul className="space-y-4">
			{[...operations.values()].map((event) => {
				const fact = event.payload;
				return (
					<li
						key={event.eventId}
						className="space-y-2 border-border border-l-2 pl-3"
					>
						<p className="break-words font-medium">
							{fact.kind === "model"
								? `模型 · ${fact.model.modelId}`
								: `工具 · ${fact.toolId}`}{" "}
							· {phases[fact.phase]}
						</p>
						<p className="text-sm">
							耗时：
							{fact.durationMs === undefined
								? "未采集"
								: `${fact.durationMs} ms`}
						</p>
						{fact.kind === "model" && (
							<>
								<p className="text-sm">
									推理强度：{fact.model.reasoningLevel ?? "未提供"}
								</p>
								<p className="text-sm">
									输入 / 输出 Token：{fact.usage?.inputTokens ?? "未采集"} /{" "}
									{fact.usage?.outputTokens ?? "未采集"}
								</p>
							</>
						)}
						{fact.failureCode && (
							<p className="text-destructive text-sm">
								失败分类：{fact.failureCode}
							</p>
						)}
						{fact.kind === "tool" && fact.connection && (
							<p className="break-all text-sm">
								Connection 原调用关联：
								{fact.connection.verification === "verified"
									? `已核实 · ${fact.connection.callRef}`
									: "待核实；不能据此判定外部操作成功"}
							</p>
						)}
						{fact.kind === "tool" && fact.resultRef && (
							<p className="break-all text-sm">结果引用：{fact.resultRef}</p>
						)}
					</li>
				);
			})}
		</ul>
	);
}
