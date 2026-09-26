import type {
	AccessRequestSubmit,
	AccessRequestsResponse,
} from "@agent-infra/connection-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { connectionApi } from "../api";
import { Button } from "../components/ui/button";
import { PageError } from "../shell";
import "./approval-policies-page.css";

const openStates = new Set([
	"SUBMITTED",
	"IN_REVIEW",
	"ROUTING_BLOCKED",
	"APPROVED_PENDING_CONNECTION",
]);
const requestLabels: Record<string, string> = {
	APPROVED_PENDING_CONNECTION: "待连接",
	CANCELED: "已取消",
	CONSUMED: "已连接",
	EXPIRED: "已到期",
	IN_REVIEW: "审批中",
	REJECTED: "已拒绝",
	ROUTING_BLOCKED: "待管理员处理",
	SUBMITTED: "已提交",
};
const stageLabels: Record<string, string> = {
	APPROVED: "已通过",
	NOT_STARTED: "等待前置审批",
	PENDING: "审批中",
	REJECTED: "已拒绝",
	SKIPPED_BY_CANCEL: "已取消",
};

export function AccessRequestPanel(props: {
	onSubmitted: () => void;
	providerId: string;
	renewalTarget: {
		capabilityProfileId: string;
		id: string;
		providerReleaseId: string;
	} | null;
	requests: AccessRequestsResponse["requests"];
	requestsError: unknown;
	requestsPending: boolean;
	startProviderId: string;
	startSignal: number;
}) {
	const client = useQueryClient();
	const options = useQuery({
		queryKey: ["connection-access-options"],
		queryFn: connectionApi.getConnectionAccessOptions,
	});
	const [showNew, setShowNew] = useState(false);
	const [selectedRequestId, setSelectedRequestId] = useState("");
	const [optionPolicyId, setOptionPolicyId] = useState<string | null>(null);
	const [purpose, setPurpose] = useState("");
	const [durationIndex, setDurationIndex] = useState(0);
	const [confirmed, setConfirmed] = useState<string[]>([]);
	const providerOptions =
		options.data?.options.filter(
			(item) =>
				item.providerId === props.providerId &&
				(!props.renewalTarget ||
					(item.capabilityProfileId ===
						props.renewalTarget.capabilityProfileId &&
						item.providerReleaseId === props.renewalTarget.providerReleaseId)),
		) ?? [];
	const providerRequests = props.requests.filter(
		(item) => item.providerId === props.providerId,
	);
	const openRequest = providerRequests.find((item) =>
		openStates.has(item.state),
	);
	const selectedRequest = showNew
		? null
		: (providerRequests.find((item) => item.id === selectedRequestId) ??
			openRequest ??
			providerRequests[0]);
	const canConnect =
		!selectedRequest?.renewal &&
		selectedRequest?.state === "APPROVED_PENDING_CONNECTION" &&
		Boolean(
			selectedRequest.connectExpiresAt &&
				Date.parse(selectedRequest.connectExpiresAt) > Date.now(),
		);
	const finalStepStatus = selectedRequest
		? ({
				CANCELED: "已取消",
				EXPIRED: "已过期",
				REJECTED: "未通过",
			}[selectedRequest.state] ??
			(selectedRequest.renewal
				? selectedRequest.state === "CONSUMED"
					? "已续期"
					: "等待审批"
				: canConnect
					? "可连接"
					: selectedRequest.state === "APPROVED_PENDING_CONNECTION"
						? "连接窗口已过期"
						: selectedRequest.state === "CONSUMED"
							? "已连接"
							: "等待审批"))
		: "";
	const selectedOption = providerOptions.find(
		(item) => item.policyVersionId === optionPolicyId,
	);
	const durations = props.renewalTarget
		? selectedOption?.durations.filter((item) => item.kind === "FINITE")
		: selectedOption?.durations;
	const submit = useMutation({
		mutationFn: (body: AccessRequestSubmit) =>
			props.renewalTarget
				? connectionApi.submitConnectionAccessRenewal({
						authorizationId: props.renewalTarget.id,
						body,
					})
				: connectionApi.submitConnectionAccessRequest(body),
		onSuccess: async (created) => {
			setShowNew(false);
			setSelectedRequestId(created.requestId);
			setOptionPolicyId(null);
			setPurpose("");
			setConfirmed([]);
			props.onSubmitted();
			await client.invalidateQueries({
				queryKey: ["connection-access-requests"],
			});
		},
	});
	const cancel = useMutation({
		mutationFn: connectionApi.cancelConnectionAccessRequest,
		onSuccess: () =>
			client.invalidateQueries({ queryKey: ["connection-access-requests"] }),
	});
	useEffect(() => {
		if (!props.startSignal || props.startProviderId !== props.providerId)
			return;
		setShowNew(true);
		setOptionPolicyId(null);
	}, [props.providerId, props.startProviderId, props.startSignal]);

	function start(index: number) {
		setShowNew(true);
		setOptionPolicyId(providerOptions[index]?.policyVersionId ?? null);
		setDurationIndex(0);
		setPurpose("");
		setConfirmed([]);
	}

	function apply() {
		const duration = durations?.[durationIndex];
		if (
			!selectedOption ||
			!duration ||
			!purpose.trim() ||
			!selectedOption.disclaimers.every((item) => confirmed.includes(item.id))
		)
			return;
		submit.mutate({
			providerReleaseId: selectedOption.providerReleaseId,
			capabilityProfileId: selectedOption.capabilityProfileId,
			policyVersionId: selectedOption.policyVersionId,
			presentationId: selectedOption.presentationId,
			purpose: purpose.trim(),
			duration,
			disclaimerConfirmations: selectedOption.disclaimers.map((item) => ({
				disclaimerVersionId: item.id,
				contentSha256: item.contentSha256,
				locale: item.locale,
			})),
		});
	}

	return (
		<section
			className="connection-access-panel"
			id={`connection-access-${props.providerId}`}
			aria-label="审批与连接进度"
		>
			{options.isError ? <PageError error={options.error} /> : null}
			{props.requestsError ? <PageError error={props.requestsError} /> : null}
			{submit.isError ? <PageError error={submit.error} /> : null}
			{cancel.isError ? <PageError error={cancel.error} /> : null}
			<div className="connection-subheading">
				<div>
					<strong>审批与连接进度</strong>
					<p>
						{selectedRequest?.capabilityProfileName ??
							(props.renewalTarget ? "续期申请" : "连接申请")}
					</p>
				</div>
				{selectedRequest ? (
					<span className="status">
						{requestLabels[selectedRequest.state] ?? selectedRequest.state}
					</span>
				) : null}
			</div>
			{selectedRequest ? (
				<>
					{providerRequests.length > 1 ? (
						<label className="approval-history-select">
							申请记录
							<select
								value={selectedRequest.id}
								onChange={(event) => setSelectedRequestId(event.target.value)}
							>
								{providerRequests.map((item) => (
									<option key={item.id} value={item.id}>
										{item.capabilityProfileName} ·{" "}
										{new Date(item.createdAt).toLocaleDateString()} ·{" "}
										{requestLabels[item.state] ?? item.state}
									</option>
								))}
							</select>
						</label>
					) : null}
					<div className="approval-request-meta">
						<div>
							<span>能力包</span>
							<strong>{selectedRequest.capabilityProfileName}</strong>
						</div>
						<div>
							<span>申请时长</span>
							<strong>
								{selectedRequest.duration.kind === "PERMANENT"
									? "永久"
									: `${selectedRequest.duration.days} 天`}
							</strong>
						</div>
						<div>
							<span>申请截止</span>
							<strong>
								{new Date(selectedRequest.expiresAt).toLocaleString()}
							</strong>
						</div>
					</div>
					<ol className="approval-timeline">
						{selectedRequest.stages.map((stage) => (
							<li
								key={stage.ordinal}
								className={
									stage.ordinal === selectedRequest.currentStageOrdinal
										? "current"
										: ""
								}
							>
								<div className="approval-stage-detail">
									<strong>{stage.name}</strong>
									{stage.decisions?.map((decision) => (
										<small
											key={`${decision.approverName}-${decision.decidedAt}`}
										>
											{decision.approverName}
											{decision.actorName !== decision.approverName
												? `（${decision.actorName} 代审）`
												: ""}{" "}
											· {decision.decision === "APPROVE" ? "通过" : "拒绝"} ·{" "}
											{new Date(decision.decidedAt).toLocaleString()}
											{decision.comment ? ` · ${decision.comment}` : ""}
										</small>
									))}
								</div>
								<span>
									{stage.state === "SKIPPED_BY_CANCEL" &&
									selectedRequest.state === "EXPIRED"
										? "未完成"
										: (stageLabels[stage.state] ?? stage.state)}
								</span>
							</li>
						))}
						<li>
							<strong>
								{selectedRequest.renewal ? "续期资格" : "连接账号"}
							</strong>
							<span>{finalStepStatus}</span>
						</li>
					</ol>
					<div className="approval-panel-actions">
						{canConnect ? (
							<a
								className="button button-primary"
								href={`/connection/connections?provider=${encodeURIComponent(props.providerId)}&intent=connect&accessRequestId=${encodeURIComponent(selectedRequest.id)}`}
							>
								连接账号
							</a>
						) : openStates.has(selectedRequest.state) ? (
							<Button
								variant="danger"
								disabled={cancel.isPending}
								onClick={() => cancel.mutate(selectedRequest.id)}
							>
								取消申请
							</Button>
						) : !openRequest ? (
							<Button
								variant="secondary"
								onClick={() => {
									setShowNew(true);
									setOptionPolicyId(null);
								}}
							>
								<Plus size={15} />
								重新申请
							</Button>
						) : null}
					</div>
				</>
			) : selectedOption ? (
				<>
					<div className="approval-request-meta">
						<div>
							<span>能力包</span>
							<strong>{selectedOption.capabilityProfileName}</strong>
						</div>
						<div>
							<span>权限</span>
							<strong>
								{selectedOption.effectCeiling === "WRITE"
									? "读取与写入"
									: "只读"}
							</strong>
						</div>
					</div>
					<div className="approval-request-form">
						<label>
							用途
							<textarea
								value={purpose}
								maxLength={2000}
								onChange={(event) => setPurpose(event.target.value)}
							/>
						</label>
						<label>
							申请时长
							<select
								value={durationIndex}
								onChange={(event) =>
									setDurationIndex(Number(event.target.value))
								}
							>
								{durations?.map((duration, index) => (
									<option key={index} value={index}>
										{duration.kind === "PERMANENT"
											? "永久有效"
											: `${duration.days} 天`}
									</option>
								))}
							</select>
						</label>
						<fieldset>
							<legend>免责声明</legend>
							{selectedOption.disclaimers.map((item) => (
								<label key={item.id} className="approval-disclaimer-confirm">
									<input
										type="checkbox"
										checked={confirmed.includes(item.id)}
										onChange={() =>
											setConfirmed((current) =>
												current.includes(item.id)
													? current.filter((id) => id !== item.id)
													: [...current, item.id],
											)
										}
									/>
									<span>{item.content}</span>
								</label>
							))}
						</fieldset>
						<div className="approval-panel-actions">
							<Button
								variant="secondary"
								onClick={() => setOptionPolicyId(null)}
							>
								<X size={15} />
								返回
							</Button>
							<Button
								disabled={
									submit.isPending ||
									!purpose.trim() ||
									!selectedOption.disclaimers.every((item) =>
										confirmed.includes(item.id),
									)
								}
								onClick={apply}
							>
								提交申请
							</Button>
						</div>
					</div>
				</>
			) : (
				<>
					{options.isPending || props.requestsPending ? (
						<div
							className="skeleton-block"
							role="status"
							aria-label="正在加载申请"
						/>
					) : providerOptions.length ? (
						<div className="approval-option-list">
							{providerOptions.map((item, index) => (
								<button
									type="button"
									key={`${item.policyVersionId}-${item.capabilityProfileId}`}
									onClick={() => start(index)}
								>
									<strong>{item.capabilityProfileName}</strong>
									<span>
										{item.effectCeiling === "WRITE" ? "读取与写入" : "只读"}
									</span>
									<ChevronRight size={16} />
								</button>
							))}
						</div>
					) : (
						<p>当前没有可申请的连接能力。</p>
					)}
				</>
			)}
		</section>
	);
}
