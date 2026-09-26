import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useState } from "react";

import { connectionApi } from "../api";
import { Button } from "../components/ui/button";
import { ConsoleShell, PageError } from "../shell";
import { EmptyState, PageHeader } from "../views";
import "./approval-policies-page.css";

export function ApprovalQueuePage() {
	const queryClient = useQueryClient();
	const queue = useQuery({
		queryKey: ["connection-approval-queue"],
		queryFn: connectionApi.listConnectionApprovalQueue,
		refetchInterval: 30_000,
	});
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [comment, setComment] = useState("");
	const [decision, setDecision] = useState<"APPROVE" | "REJECT" | null>(null);
	const selected =
		queue.data?.requests.find((item) => item.id === selectedId) ??
		queue.data?.requests[0];
	const submit = useMutation({
		mutationFn: connectionApi.decideConnectionAccessRequest,
		onSuccess: async () => {
			setDecision(null);
			setComment("");
			await queryClient.invalidateQueries({
				queryKey: ["connection-approval-queue"],
			});
		},
	});
	const stage = selected?.stages.find(
		(item) => item.ordinal === selected.currentStageOrdinal,
	);

	function confirm() {
		if (
			!selected ||
			!stage ||
			!decision ||
			(decision === "REJECT" && !comment.trim())
		)
			return;
		submit.mutate({
			requestId: selected.id,
			body: {
				approverPrincipalId: selected.approverPrincipalId,
				decision,
				...(comment.trim() ? { comment: comment.trim() } : {}),
				expectedRequestRevision: selected.revision,
				expectedStageRevision: stage.revision,
				expectedRoutingRevision: stage.routingRevision,
			},
		});
	}

	return (
		<ConsoleShell>
			<PageHeader title="待我审批" />
			{queue.isError ? <PageError error={queue.error} /> : null}
			{submit.isError ? <PageError error={submit.error} /> : null}
			{queue.isPending ? (
				<div
					className="skeleton-block"
					role="status"
					aria-label="正在加载审批"
				/>
			) : !queue.data?.requests.length ? (
				<EmptyState title="暂无待审批申请">
					新的连接申请会出现在这里。
				</EmptyState>
			) : (
				<div className="connector-workspace">
					<aside className="approval-list" aria-label="待审批申请">
						{queue.data.requests.map((item) => (
							<button
								type="button"
								key={item.id}
								className={selected?.id === item.id ? "active" : ""}
								onClick={() => {
									setSelectedId(item.id);
									setDecision(null);
									setComment("");
								}}
							>
								<b>{item.applicantDisplayName}</b>
								<span>
									{item.providerId} · {item.capabilityProfileName}
								</span>
							</button>
						))}
					</aside>
					{selected ? (
						<section className="approval-queue-detail">
							<h2>
								{selected.applicantDisplayName} · {selected.providerId}
							</h2>
							<p>
								{selected.capabilityProfileName} ·{" "}
								{selected.duration.kind === "PERMANENT"
									? "永久有效"
									: `${selected.duration.days} 天`}
							</p>
							<dl>
								<dt>申请理由</dt>
								<dd>{selected.purpose}</dd>
								<dt>审批阶段</dt>
								<dd>{stage?.name ?? "待处理"}</dd>
								<dt>提交时间</dt>
								<dd>{new Date(selected.createdAt).toLocaleString()}</dd>
							</dl>
							{decision ? (
								<div className="approval-decision">
									<label>
										审批意见
										<textarea
											value={comment}
											maxLength={2000}
											placeholder={
												decision === "REJECT" ? "请填写拒绝原因" : "可选"
											}
											onChange={(event) => setComment(event.target.value)}
										/>
									</label>
									<div>
										<Button
											variant="secondary"
											onClick={() => setDecision(null)}
										>
											取消
										</Button>
										<Button
											disabled={
												submit.isPending ||
												(decision === "REJECT" && !comment.trim())
											}
											onClick={confirm}
										>
											确认{decision === "APPROVE" ? "通过" : "拒绝"}
										</Button>
									</div>
								</div>
							) : (
								<div className="approval-decision-actions">
									<Button
										variant="secondary"
										onClick={() => setDecision("REJECT")}
									>
										<X size={16} />
										拒绝
									</Button>
									<Button onClick={() => setDecision("APPROVE")}>
										<Check size={16} />
										通过
									</Button>
								</div>
							)}
						</section>
					) : null}
				</div>
			)}
		</ConsoleShell>
	);
}
