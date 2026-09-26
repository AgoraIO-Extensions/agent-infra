import type { AccessPolicyDraft } from "@agent-infra/connection-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Check,
	ChevronRight,
	Pencil,
	Plus,
	Search,
	ShieldX,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { connectionApi } from "../api";
import { Button } from "../components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../components/ui/dialog";
import { ConsoleShell, PageError } from "../shell";
import { PageHeader } from "../views";
import "./approval-policies-page.css";

type StageDraft = AccessPolicyDraft["stages"][number];

const newStage = (ordinal: number): StageDraft => ({
	approverCandidateIds: [],
	name: `第 ${ordinal} 级审批`,
	quorumType: "ANY",
	timeoutSeconds: 3 * 86_400,
});

export function ApprovalPoliciesPage() {
	const client = useQueryClient();
	const catalog = useQuery({
		queryKey: ["approval-catalog"],
		queryFn: connectionApi.listApprovalPolicyCatalog,
	});
	const [providerReleaseId, setProviderReleaseId] = useState("");
	const [profileId, setProfileId] = useState("");
	const [policyId, setPolicyId] = useState("");
	const selectedPolicyId = useRef(policyId);
	selectedPolicyId.current = policyId;
	const [creatingNew, setCreatingNew] = useState(false);
	const [editingDraft, setEditingDraft] = useState<{
		revision: string;
		draft: AccessPolicyDraft;
	} | null>(null);
	const editable = !policyId || Boolean(editingDraft);
	const [stageIndex, setStageIndex] = useState(0);
	const [stages, setStages] = useState<StageDraft[]>([newStage(1)]);
	const [candidateLabels, setCandidateLabels] = useState<
		Record<string, string>
	>({});
	const [query, setQuery] = useState("");
	const [allowPermanent, setAllowPermanent] = useState(false);
	const [durationDays, setDurationDays] = useState(90);
	const [disclaimerIds, setDisclaimerIds] = useState<string[]>([]);
	const [tab, setTab] = useState<"chain" | "catalog">("chain");
	const [profileName, setProfileName] = useState("");
	const [selectedActions, setSelectedActions] = useState<string[]>([]);
	const [disclaimerContent, setDisclaimerContent] = useState("");
	const [disclaimerMaterial, setDisclaimerMaterial] = useState(false);
	const [disclaimerKind, setDisclaimerKind] = useState<"GLOBAL" | "PROVIDER">(
		"GLOBAL",
	);
	const [notice, setNotice] = useState("");
	const [blockedId, setBlockedId] = useState("");
	const [rerouteSearch, setRerouteSearch] = useState("");
	const [rerouteCandidateIds, setRerouteCandidateIds] = useState<string[]>([]);
	const [rerouteLabels, setRerouteLabels] = useState<Record<string, string>>(
		{},
	);
	const [rerouteReason, setRerouteReason] = useState("");
	const [campaignOpen, setCampaignOpen] = useState(false);
	const [campaignProfileId, setCampaignProfileId] = useState("");
	const [campaignTriggerKind, setCampaignTriggerKind] = useState<
		"DISCLAIMER" | "POLICY" | "PROVIDER_RELEASE"
	>("DISCLAIMER");
	const [campaignTriggerVersionId, setCampaignTriggerVersionId] = useState("");
	const [campaignDeadline, setCampaignDeadline] = useState("");
	const [campaignReason, setCampaignReason] = useState("");
	const [policyPublishOpen, setPolicyPublishOpen] = useState(false);
	const [policyMaterial, setPolicyMaterial] = useState(false);
	const [policyDeadline, setPolicyDeadline] = useState("");
	const [policyReason, setPolicyReason] = useState("");
	const [policyRevokeOpen, setPolicyRevokeOpen] = useState(false);
	const [policyRevokeReason, setPolicyRevokeReason] = useState("");
	const blocked = useQuery({
		queryKey: ["approval-routing-blocked"],
		queryFn: connectionApi.listApprovalRoutingBlocked,
		refetchInterval: 30_000,
	});
	const outboxFailures = useQuery({
		queryKey: ["approval-outbox-failures"],
		queryFn: connectionApi.listOutboxFailures,
		refetchInterval: 30_000,
	});
	const retryOutbox = useMutation({
		mutationFn: (input: { id: string; attempts: number }) =>
			connectionApi.retryOutboxFailure(input.id, input.attempts),
		onSuccess: async () => {
			setNotice("投递事件已重新排队。");
			await client.invalidateQueries({
				queryKey: ["approval-outbox-failures"],
			});
		},
	});
	const authorizations = useQuery({
		queryKey: ["approval-admin-authorizations"],
		queryFn: connectionApi.listAdminAccessAuthorizations,
		refetchInterval: 30_000,
	});
	const revokeAuthorization = useMutation({
		mutationFn: connectionApi.revokeAdminAccessAuthorization,
		onSuccess: async () => {
			setNotice("连接资格已撤销。 ");
			await client.invalidateQueries({
				queryKey: ["approval-admin-authorizations"],
			});
		},
	});
	const createCampaign = useMutation({
		mutationFn: connectionApi.createReapprovalCampaign,
		onSuccess: async (created) => {
			setCampaignOpen(false);
			setCampaignReason("");
			setNotice(`重审活动已创建，涉及 ${created.affectedConnections} 个连接。`);
			await client.invalidateQueries({
				queryKey: ["approval-admin-authorizations"],
			});
		},
	});
	const campaignProfile = catalog.data?.profiles.find(
		(item) => item.id === campaignProfileId,
	);
	const campaignProvider = catalog.data?.providers.find(
		(item) => item.providerReleaseId === campaignProfile?.providerReleaseId,
	);
	const triggerOptions =
		campaignTriggerKind === "DISCLAIMER"
			? (catalog.data?.disclaimers
					.filter(
						(item) =>
							item.status === "PUBLISHED" &&
							item.materialChange &&
							(item.kind === "GLOBAL" ||
								item.providerId === campaignProvider?.provider),
					)
					.map((item) => ({
						id: item.id,
						label: `${item.kind} · ${item.locale} · ${item.id}`,
					})) ?? [])
			: campaignTriggerKind === "POLICY"
				? (catalog.data?.policies
						.filter(
							(item) =>
								item.status === "PUBLISHED" &&
								item.capabilityProfileId === campaignProfileId &&
								item.providerReleaseId === campaignProfile?.providerReleaseId,
						)
						.map((item) => ({ id: item.id, label: item.id })) ?? [])
				: (catalog.data?.providers
						.filter(
							(item) =>
								item.provider === campaignProvider?.provider &&
								item.providerReleaseId !== campaignProfile?.providerReleaseId,
						)
						.map((item) => ({
							id: item.providerReleaseId,
							label: item.providerReleaseId,
						})) ?? []);
	const selectedBlocked =
		blocked.data?.requests.find((item) => item.id === blockedId) ??
		blocked.data?.requests[0];
	const blockedStage = selectedBlocked?.stages.find(
		(item) => item.ordinal === selectedBlocked.currentStageOrdinal,
	);
	const rerouteCandidates = useQuery({
		queryKey: ["approval-employees", rerouteSearch],
		queryFn: () => connectionApi.searchApprovalEmployees(rerouteSearch),
		enabled: rerouteSearch.trim().length >= 2,
	});
	const reroute = useMutation({
		mutationFn: connectionApi.rerouteApprovalRequest,
		onSuccess: async () => {
			setNotice("当前阶段已重新分配审批人。 ");
			setRerouteCandidateIds([]);
			setRerouteReason("");
			await client.invalidateQueries({
				queryKey: ["approval-routing-blocked"],
			});
		},
	});

	const provider = catalog.data?.providers.find(
		(item) => item.providerReleaseId === providerReleaseId,
	);
	const profile = catalog.data?.profiles.find((item) => item.id === profileId);
	const activeStage = stages[stageIndex];
	const selectedPolicy = catalog.data?.policies.find(
		(item) => item.id === policyId,
	);
	const published = selectedPolicy?.status === "PUBLISHED";
	useEffect(() => {
		if (creatingNew || policyId || !catalog.data?.policies.length) return;
		const first = catalog.data.policies[0];
		if (!first) return;
		setPolicyId(first.id);
		setProfileId(first.capabilityProfileId);
		setProviderReleaseId(first.providerReleaseId);
	}, [catalog.data, creatingNew, policyId]);
	const savedStages = useQuery({
		queryKey: ["approval-policy-stages", policyId],
		queryFn: () => connectionApi.getApprovalPolicyStages(policyId),
		enabled: Boolean(policyId),
	});
	const savedStage = savedStages.data?.stages[stageIndex];
	const candidates = useQuery({
		queryKey: ["approval-employees", query],
		queryFn: () => connectionApi.searchApprovalEmployees(query),
		enabled: query.trim().length >= 2 && !published,
	});
	const refresh = () =>
		client.invalidateQueries({ queryKey: ["approval-catalog"] });
	const loadDraft = useMutation({
		mutationFn: connectionApi.getConnectionAccessPolicyDraft,
		onSuccess: (result) => {
			if (result.policyId !== selectedPolicyId.current) return;
			setEditingDraft({ revision: result.revision, draft: result.draft });
			setStages(result.draft.stages);
			setCandidateLabels(
				Object.fromEntries(
					result.candidates.map((candidate) => [
						candidate.candidateId,
						candidate.displayName,
					]),
				),
			);
			setProviderReleaseId(result.draft.providerReleaseId);
			setProfileId(result.draft.capabilityProfileId);
			setDisclaimerIds(result.draft.disclaimerVersionIds);
			setAllowPermanent(result.draft.allowPermanent);
			setDurationDays(result.draft.defaultDurationDays ?? 90);
			setStageIndex(0);
			setQuery("");
		},
	});
	const updatePolicy = useMutation({
		mutationFn: connectionApi.updateConnectionAccessPolicy,
		onSuccess: async (_result, input) => {
			if (input.policyId === selectedPolicyId.current) {
				setEditingDraft(null);
				setNotice("策略草稿已更新。");
			}
			await refresh();
			await client.invalidateQueries({ queryKey: ["approval-policy-stages"] });
		},
	});
	const createPolicy = useMutation({
		mutationFn: connectionApi.createConnectionAccessPolicy,
		onSuccess: async (created) => {
			setPolicyId(created.policyVersionId);
			setNotice("策略草稿已保存。检查审批链后发布。 ");
			await refresh();
		},
	});
	const publishPolicy = useMutation({
		mutationFn: connectionApi.publishConnectionAccessPolicy,
		onSuccess: async (_result, input) => {
			setPolicyPublishOpen(false);
			setNotice(
				input.body.materialChange
					? "策略已发布，既有连接已进入限期重审。"
					: "策略已发布，新申请将使用此版本。",
			);
			await refresh();
			await client.invalidateQueries({
				queryKey: ["approval-admin-authorizations"],
			});
		},
	});
	const revokePolicy = useMutation({
		mutationFn: connectionApi.revokeConnectionAccessPolicy,
		onSuccess: async (result) => {
			setPolicyRevokeOpen(false);
			setPolicyRevokeReason("");
			setNotice(
				`策略已撤销，终止 ${result.canceledRequests} 项申请，暂停 ${result.suspendedConnections} 个连接资格。`,
			);
			await refresh();
			await client.invalidateQueries({
				queryKey: ["approval-admin-authorizations"],
			});
			await client.invalidateQueries({
				queryKey: ["approval-routing-blocked"],
			});
		},
	});
	const createProfile = useMutation({
		mutationFn: connectionApi.createApprovalCapabilityProfile,
		onSuccess: async (created) => {
			await connectionApi.publishApprovalCapabilityProfile(
				created.capabilityProfileId,
			);
			setProfileId(created.capabilityProfileId);
			setNotice("能力包已发布。 ");
			await refresh();
		},
	});
	const createDisclaimer = useMutation({
		mutationFn: connectionApi.createApprovalDisclaimer,
		onSuccess: async (created) => {
			await connectionApi.publishApprovalDisclaimer(
				created.disclaimerVersionId,
			);
			setDisclaimerIds((current) => [...current, created.disclaimerVersionId]);
			setDisclaimerContent("");
			setDisclaimerMaterial(false);
			setNotice("免责声明版本已发布。 ");
			await refresh();
		},
	});
	const busy =
		loadDraft.isPending ||
		updatePolicy.isPending ||
		createPolicy.isPending ||
		publishPolicy.isPending ||
		revokePolicy.isPending ||
		createProfile.isPending ||
		createDisclaimer.isPending;
	const error =
		loadDraft.error ||
		updatePolicy.error ||
		createPolicy.error ||
		publishPolicy.error ||
		revokePolicy.error ||
		createProfile.error ||
		createDisclaimer.error ||
		reroute.error ||
		revokeAuthorization.error ||
		createCampaign.error;

	function updateStage(update: Partial<StageDraft>) {
		setStages((current) =>
			current.map((stage, index) =>
				index === stageIndex ? { ...stage, ...update } : stage,
			),
		);
	}
	function selectPolicy(id: string) {
		const next = catalog.data?.policies.find((item) => item.id === id);
		if (!next) return;
		setEditingDraft(null);
		setPolicyId(id);
		setCreatingNew(false);
		setProfileId(next.capabilityProfileId);
		setProviderReleaseId(next.providerReleaseId);
		setStageIndex(0);
		setTab("chain");
	}
	function savePolicy() {
		if (!profile || !provider) {
			setNotice("请先选择已发布能力包。");
			return;
		}
		const base = editingDraft?.draft;
		const body: AccessPolicyDraft = {
			allowPermanent,
			capabilityProfileId: profile.id,
			connectTtlSeconds: base?.connectTtlSeconds ?? 7 * 86_400,
			defaultDurationDays:
				base && durationDays === (base.defaultDurationDays ?? 90)
					? base.defaultDurationDays
					: durationDays,
			disclaimerVersionIds: disclaimerIds,
			durations: [
				...(base && durationDays === (base.defaultDurationDays ?? 90)
					? base.durations.filter((duration) => duration.kind === "FINITE")
					: [{ days: durationDays, kind: "FINITE" as const }]),
				...(allowPermanent ? [{ kind: "PERMANENT" as const }] : []),
			],
			priority: base?.priority ?? 100,
			providerReleaseId: provider.providerReleaseId,
			renewalLeadSeconds: base?.renewalLeadSeconds ?? 14 * 86_400,
			requestTtlSeconds: base?.requestTtlSeconds ?? 14 * 86_400,
			stages,
		};
		if (editingDraft)
			updatePolicy.mutate({ policyId, revision: editingDraft.revision, body });
		else createPolicy.mutate(body);
	}

	return (
		<ConsoleShell>
			<PageHeader title="连接审批策略" />
			{catalog.isError ? <PageError error={catalog.error} /> : null}
			{error ? <PageError error={error} /> : null}
			{notice ? (
				<p role="status" className="approval-notice">
					{notice}
				</p>
			) : null}
			<div className="approval-layout">
				<aside className="approval-list" aria-label="审批策略列表">
					<div className="approval-list-header">
						<strong>策略版本</strong>
						<Button
							size="icon"
							title="新建策略"
							aria-label="新建策略"
							onClick={() => {
								setCreatingNew(true);
								setEditingDraft(null);
								setPolicyId("");
								setStages([newStage(1)]);
								setStageIndex(0);
							}}
						>
							<Plus size={16} />
						</Button>
					</div>
					{catalog.data?.policies.map((item) => (
						<button
							key={item.id}
							className={policyId === item.id ? "active" : ""}
							onClick={() => selectPolicy(item.id)}
							type="button"
						>
							<b>
								{catalog.data?.profiles.find(
									(profile) => profile.id === item.capabilityProfileId,
								)?.name ?? item.capabilityProfileId}
							</b>
							<span>
								{item.status} ·{" "}
								{catalog.data?.providers.find(
									(provider) =>
										provider.providerReleaseId === item.providerReleaseId,
								)?.provider ?? item.providerReleaseId}
							</span>
							<ChevronRight size={16} />
						</button>
					))}
					{catalog.isPending ? <p role="status">正在加载策略…</p> : null}
				</aside>
				<section className="approval-editor">
					<div className="approval-editor-head">
						<div>
							<span>{provider?.provider ?? "选择连接器"}</span>
							<h2>{profile?.name ?? "新建审批策略"}</h2>
							<p>
								{published
									? "已发布版本不可修改。"
									: "顺序审批完成后才允许员工连接外部账号。"}
							</p>
						</div>
						<span className="status">{selectedPolicy?.status ?? "新草稿"}</span>
					</div>
					<div className="approval-tabs" role="tablist">
						<button
							type="button"
							className={tab === "chain" ? "active" : ""}
							onClick={() => setTab("chain")}
							role="tab"
							aria-selected={tab === "chain"}
						>
							审批链
						</button>
						<button
							type="button"
							className={tab === "catalog" ? "active" : ""}
							onClick={() => setTab("catalog")}
							role="tab"
							aria-selected={tab === "catalog"}
						>
							能力与条款
						</button>
					</div>
					{tab === "chain" ? (
						<div className="approval-chain-layout">
							<div className="approval-chain">
								<div className="approval-terminal">员工提交申请</div>
								{(policyId && !editingDraft && savedStages.data
									? savedStages.data.stages
									: stages
								).map((stage, index) => (
									<button
										key={"id" in stage ? stage.id : index}
										type="button"
										className={stageIndex === index ? "active" : ""}
										onClick={() => setStageIndex(index)}
									>
										<span>{index + 1}</span>
										<div>
											<b>{stage.name}</b>
											<small>
												{stage.quorumType}
												{stage.quorumType === "AT_LEAST_N"
													? ` · ${stage.quorumCount} 人`
													: ""}{" "}
												·{" "}
												{"approvers" in stage
													? stage.approvers.length
													: stage.approverCandidateIds.length}{" "}
												位审批人
											</small>
										</div>
									</button>
								))}
								<div className="approval-terminal">开放 Provider 连接</div>
								{editable && stages.length < 10 ? (
									<Button
										variant="secondary"
										onClick={() => {
											setStages((value) => [
												...value,
												newStage(value.length + 1),
											]);
											setStageIndex(stages.length);
										}}
									>
										<Plus size={15} />
										增加阶段
									</Button>
								) : null}
							</div>
							<aside className="approval-inspector">
								{activeStage && editable ? (
									<>
										<span>第 {stageIndex + 1} 级</span>
										<label>
											阶段名称
											<input
												value={activeStage.name}
												maxLength={120}
												onChange={(event) =>
													updateStage({ name: event.target.value })
												}
											/>
										</label>
										<label>
											通过规则
											<select
												value={activeStage.quorumType}
												onChange={(event) =>
													updateStage({
														quorumType: event.target
															.value as StageDraft["quorumType"],
														quorumCount:
															event.target.value === "AT_LEAST_N"
																? 1
																: undefined,
													})
												}
											>
												<option value="ANY">任意一人</option>
												<option value="ALL">全部通过</option>
												<option value="AT_LEAST_N">至少 N 人</option>
											</select>
										</label>
										{activeStage.quorumType === "AT_LEAST_N" ? (
											<label>
												最少人数
												<input
													type="number"
													min={1}
													max={Math.max(
														1,
														activeStage.approverCandidateIds.length,
													)}
													value={activeStage.quorumCount ?? 1}
													onChange={(event) =>
														updateStage({
															quorumCount: Number(event.target.value),
														})
													}
												/>
											</label>
										) : null}
										<label>
											处理时限（天）
											<input
												type="number"
												min={1}
												max={30}
												value={activeStage.timeoutSeconds / 86_400}
												onChange={(event) =>
													updateStage({
														timeoutSeconds: Number(event.target.value) * 86_400,
													})
												}
											/>
										</label>
										<label>
											审批人
											<div className="approval-search">
												<Search size={15} />
												<input
													placeholder="姓名或邮箱"
													value={query}
													onChange={(event) => setQuery(event.target.value)}
												/>
											</div>
										</label>
										{candidates.data?.candidates.map((candidate) => (
											<button
												type="button"
												className="approval-candidate"
												key={candidate.candidateId}
												onClick={() => {
													if (
														!stages.some((stage) =>
															stage.approverCandidateIds.includes(
																candidate.candidateId,
															),
														)
													)
														updateStage({
															approverCandidateIds: [
																...activeStage.approverCandidateIds,
																candidate.candidateId,
															],
														});
													setCandidateLabels((value) => ({
														...value,
														[candidate.candidateId]: candidate.displayName,
													}));
													setQuery("");
												}}
											>
												{candidate.displayName}
												<small>{candidate.email}</small>
											</button>
										))}
										<div className="approval-chips">
											{activeStage.approverCandidateIds.map((id) => (
												<span key={id}>
													{candidateLabels[id] ?? "已选员工"}
													<button
														type="button"
														title="移除审批人"
														onClick={() =>
															updateStage({
																approverCandidateIds:
																	activeStage.approverCandidateIds.filter(
																		(value) => value !== id,
																	),
															})
														}
													>
														×
													</button>
												</span>
											))}
										</div>
										{stages.length > 1 ? (
											<Button
												variant="secondary"
												onClick={() => {
													setStages((value) =>
														value.filter((_, index) => index !== stageIndex),
													);
													setStageIndex(0);
												}}
											>
												<Trash2 size={15} />
												删除阶段
											</Button>
										) : null}
									</>
								) : policyId && savedStage ? (
									<>
										<span>第 {savedStage.ordinal} 级</span>
										<h3>{savedStage.name}</h3>
										<p>
											通过规则：
											{savedStage.quorumType === "ANY"
												? "任意一人"
												: savedStage.quorumType === "ALL"
													? "全部通过"
													: `至少 ${savedStage.quorumCount} 人`}
										</p>
										<p>处理时限：{savedStage.timeoutSeconds / 86_400} 天</p>
										<strong>审批人</strong>
										<ul className="approval-inspector-approvers">
											{savedStage.approvers.map((approver) => (
												<li key={approver.displayName}>
													{approver.displayName}
													{approver.email ? (
														<small>{approver.email}</small>
													) : null}
												</li>
											))}
										</ul>
									</>
								) : (
									<p>{policyId ? "正在加载审批阶段…" : "请选择审批阶段。"}</p>
								)}
							</aside>
						</div>
					) : (
						<div className="approval-catalog-editor">
							<label>
								Provider
								<select
									value={providerReleaseId}
									disabled={Boolean(policyId)}
									onChange={(event) => {
										setProviderReleaseId(event.target.value);
										setProfileId("");
										setSelectedActions([]);
									}}
								>
									<option value="">选择连接器</option>
									{catalog.data?.providers.map((item) => (
										<option
											key={item.providerReleaseId}
											value={item.providerReleaseId}
										>
											{item.provider} · {item.providerReleaseId}
										</option>
									))}
								</select>
							</label>
							<label>
								能力包
								<select
									value={profileId}
									disabled={Boolean(policyId)}
									onChange={(event) => setProfileId(event.target.value)}
								>
									<option value="">选择已发布能力包</option>
									{catalog.data?.profiles
										.filter(
											(item) =>
												item.providerReleaseId === providerReleaseId &&
												item.status === "PUBLISHED",
										)
										.map((item) => (
											<option key={item.id} value={item.id}>
												{item.name} · {item.effectCeiling}
											</option>
										))}
								</select>
							</label>
							{editable ? (
								<>
									<div className="approval-subsection">
										<h3>新能力包</h3>
										<input
											placeholder="能力包名称"
											value={profileName}
											onChange={(event) => setProfileName(event.target.value)}
										/>
										<div className="approval-action-list">
											{provider?.actions.map((action) => (
												<label key={action.id}>
													<input
														type="checkbox"
														checked={selectedActions.includes(action.id)}
														onChange={() =>
															setSelectedActions((value) =>
																value.includes(action.id)
																	? value.filter((id) => id !== action.id)
																	: [...value, action.id],
															)
														}
													/>
													{action.name}
													<small>{action.effect}</small>
												</label>
											))}
										</div>
										<Button
											disabled={
												busy || !profileName.trim() || !selectedActions.length
											}
											onClick={() =>
												createProfile.mutate({
													providerReleaseId,
													name: profileName,
													actionVersionIds: selectedActions,
												})
											}
										>
											发布能力包
										</Button>
									</div>
									<div className="approval-subsection">
										<h3>免责声明</h3>
										<fieldset>
											<legend>已发布版本</legend>
											{catalog.data?.disclaimers
												.filter((item) => item.status === "PUBLISHED")
												.map((item) => (
													<span className="approval-disclaimer" key={item.id}>
														<input
															type="checkbox"
															checked={disclaimerIds.includes(item.id)}
															onChange={() =>
																setDisclaimerIds((value) =>
																	value.includes(item.id)
																		? value.filter((id) => id !== item.id)
																		: [...value, item.id],
																)
															}
														/>
														{item.kind} · {item.locale}
													</span>
												))}
										</fieldset>
										<select
											value={disclaimerKind}
											onChange={(event) =>
												setDisclaimerKind(
													event.target.value as "GLOBAL" | "PROVIDER",
												)
											}
										>
											<option value="GLOBAL">全局基础条款</option>
											<option value="PROVIDER">Provider 附加条款</option>
										</select>
										<textarea
											placeholder="填写已批准的正式免责声明正文"
											value={disclaimerContent}
											onChange={(event) =>
												setDisclaimerContent(event.target.value)
											}
										/>
										<label className="approval-toggle">
											<input
												type="checkbox"
												checked={disclaimerMaterial}
												onChange={(event) =>
													setDisclaimerMaterial(event.target.checked)
												}
											/>
											重大内容变化
										</label>
										<Button
											disabled={
												busy ||
												!disclaimerContent.trim() ||
												(disclaimerKind === "PROVIDER" && !provider)
											}
											onClick={() =>
												createDisclaimer.mutate({
													kind: disclaimerKind,
													locale: "zh-CN",
													content: disclaimerContent,
													materialChange: disclaimerMaterial,
													...(disclaimerKind === "PROVIDER"
														? { providerId: provider?.provider }
														: {}),
												})
											}
										>
											发布免责声明版本
										</Button>
									</div>
									<label>
										允许时长（天）
										<input
											type="number"
											min={1}
											max={3650}
											value={durationDays}
											onChange={(event) =>
												setDurationDays(Number(event.target.value))
											}
										/>
									</label>
									<label className="approval-toggle">
										<input
											type="checkbox"
											checked={allowPermanent}
											onChange={(event) =>
												setAllowPermanent(event.target.checked)
											}
										/>
										允许永久有效
									</label>
								</>
							) : null}
						</div>
					)}
					<div className="approval-editor-actions">
						{editable ? (
							<>
								<Button disabled={busy || !profile} onClick={savePolicy}>
									保存草稿
								</Button>
								{editingDraft ? (
									<Button
										variant="secondary"
										disabled={busy}
										onClick={() => setEditingDraft(null)}
									>
										取消编辑
									</Button>
								) : null}
							</>
						) : selectedPolicy?.status === "DRAFT" ? (
							<>
								<Button
									variant="secondary"
									disabled={busy}
									onClick={() => loadDraft.mutate(policyId)}
								>
									<Pencil size={16} />
									编辑草稿
								</Button>
								<Button
									disabled={busy}
									onClick={() => {
										setPolicyMaterial(false);
										setPolicyDeadline("");
										setPolicyReason("");
										setPolicyPublishOpen(true);
									}}
								>
									<Check size={16} />
									发布策略
								</Button>
							</>
						) : selectedPolicy?.status === "PUBLISHED" ? (
							<Button
								variant="danger"
								disabled={busy}
								onClick={() => {
									setPolicyRevokeReason("");
									setPolicyRevokeOpen(true);
								}}
							>
								<ShieldX size={16} /> 撤销策略
							</Button>
						) : null}
					</div>
				</section>
			</div>
			<ApprovalDelegationsPanel />
			<section className="approval-routing" aria-label="审批异常处理">
				<div className="section-heading">
					<div>
						<h2>需要管理员处理</h2>
						<p>仅处理当前无法完成审批的申请。</p>
					</div>
					<span className="status">{blocked.data?.requests.length ?? 0}</span>
				</div>
				{blocked.isError ? (
					<PageError error={blocked.error} />
				) : blocked.data?.requests.length ? (
					<div className="approval-routing-layout">
						<div className="approval-routing-list">
							{blocked.data.requests.map((item) => (
								<button
									key={item.id}
									type="button"
									className={selectedBlocked?.id === item.id ? "active" : ""}
									onClick={() => {
										setBlockedId(item.id);
										setRerouteCandidateIds([]);
										setRerouteReason("");
									}}
								>
									<strong>
										{item.applicantDisplayName} · {item.providerId}
									</strong>
									<small>
										{item.capabilityProfileName} · 第 {item.currentStageOrdinal}{" "}
										级
									</small>
								</button>
							))}
						</div>
						{selectedBlocked && blockedStage ? (
							<div className="approval-routing-form">
								<h3>{blockedStage.name}</h3>
								<label>
									重新选择审批人
									<div className="approval-search">
										<Search size={15} />
										<input
											value={rerouteSearch}
											placeholder="姓名或邮箱"
											onChange={(event) => setRerouteSearch(event.target.value)}
										/>
									</div>
								</label>
								{rerouteCandidates.data?.candidates.map((candidate) => (
									<button
										type="button"
										className="approval-candidate"
										key={candidate.candidateId}
										onClick={() => {
											setRerouteCandidateIds((ids) =>
												ids.includes(candidate.candidateId)
													? ids
													: [...ids, candidate.candidateId],
											);
											setRerouteLabels((labels) => ({
												...labels,
												[candidate.candidateId]: candidate.displayName,
											}));
											setRerouteSearch("");
										}}
									>
										{candidate.displayName}
										<small>{candidate.email}</small>
									</button>
								))}
								<div className="approval-chips">
									{rerouteCandidateIds.map((id) => (
										<span key={id}>
											{rerouteLabels[id] ?? "已选员工"}
											<button
												type="button"
												title="移除审批人"
												aria-label={`移除 ${rerouteLabels[id] ?? "审批人"}`}
												onClick={() =>
													setRerouteCandidateIds((ids) =>
														ids.filter((candidateId) => candidateId !== id),
													)
												}
											>
												×
											</button>
										</span>
									))}
								</div>
								<label>
									调整原因
									<textarea
										value={rerouteReason}
										maxLength={1000}
										onChange={(event) => setRerouteReason(event.target.value)}
									/>
								</label>
								<Button
									disabled={
										reroute.isPending ||
										!rerouteCandidateIds.length ||
										!rerouteReason.trim()
									}
									onClick={() =>
										reroute.mutate({
											requestId: selectedBlocked.id,
											body: {
												approverCandidateIds: rerouteCandidateIds,
												expectedRequestRevision: selectedBlocked.revision,
												expectedStageRevision: blockedStage.revision,
												expectedRoutingRevision: blockedStage.routingRevision,
												reason: rerouteReason.trim(),
											},
										})
									}
								>
									重新分配
								</Button>
							</div>
						) : null}
					</div>
				) : (
					<p>{blocked.isPending ? "正在加载…" : "当前没有需要处理的申请。"}</p>
				)}
			</section>
			<section className="approval-authorizations" aria-label="投递异常">
				<div className="section-heading">
					<h2>投递异常</h2>
					<span className="status">
						{outboxFailures.data?.events.length ?? 0}
					</span>
				</div>
				{outboxFailures.isError ? (
					<PageError error={outboxFailures.error} />
				) : null}
				{retryOutbox.isError ? <PageError error={retryOutbox.error} /> : null}
				{outboxFailures.data?.events.length ? (
					<div className="table-scroll">
						<table className="management-table">
							<thead>
								<tr>
									<th>事件</th>
									<th>失败次数</th>
									<th>创建时间</th>
									<th className="table-action">操作</th>
								</tr>
							</thead>
							<tbody>
								{outboxFailures.data.events.map((event) => (
									<tr key={event.id}>
										<td className="primary-cell">{event.topic}</td>
										<td>{event.attemptCount}</td>
										<td>{new Date(event.createdAt).toLocaleString()}</td>
										<td className="table-action">
											<Button
												variant="secondary"
												disabled={retryOutbox.isPending}
												onClick={() =>
													retryOutbox.mutate({
														id: event.id,
														attempts: event.attemptCount,
													})
												}
											>
												重投递
											</Button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<p>{outboxFailures.isPending ? "正在加载…" : "当前没有投递异常。"}</p>
				)}
			</section>
			<section className="approval-authorizations" aria-label="连接资格">
				<div className="section-heading">
					<div>
						<h2>连接资格</h2>
						<p>当前个人 Connection 的审批有效状态。</p>
					</div>
					<Button variant="secondary" onClick={() => setCampaignOpen(true)}>
						发起重审
					</Button>
				</div>
				{authorizations.isError ? (
					<PageError error={authorizations.error} />
				) : authorizations.data?.authorizations.length ? (
					<div className="table-scroll">
						<table className="management-table">
							<thead>
								<tr>
									<th>员工</th>
									<th>Provider</th>
									<th>状态</th>
									<th>有效期</th>
									<th className="table-action">操作</th>
								</tr>
							</thead>
							<tbody>
								{authorizations.data.authorizations.map((item) => (
									<tr key={item.id}>
										<td className="primary-cell">{item.ownerDisplayName}</td>
										<td>{item.providerId}</td>
										<td>{item.state}</td>
										<td>
											{item.validUntil
												? new Date(item.validUntil).toLocaleString()
												: "永久"}
										</td>
										<td className="table-action">
											<Button
												variant="danger"
												size="icon"
												title="撤销资格"
												aria-label={`撤销 ${item.ownerDisplayName} 的 ${item.providerId} 资格`}
												disabled={revokeAuthorization.isPending}
												onClick={() => {
													if (
														window.confirm(
															`确认立即撤销 ${item.ownerDisplayName} 的 ${item.providerId} 连接资格？`,
														)
													)
														revokeAuthorization.mutate({
															authorizationId: item.id,
															body: { expectedRevision: item.revision },
														});
												}}
											>
												<ShieldX size={16} />
											</Button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<p>
						{authorizations.isPending
							? "正在加载…"
							: "当前没有可管理的连接资格。"}
					</p>
				)}
			</section>
			<Dialog open={policyPublishOpen} onOpenChange={setPolicyPublishOpen}>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>发布审批策略</DialogTitle>
					</DialogHeader>
					{publishPolicy.isError ? (
						<PageError error={publishPolicy.error} />
					) : null}
					<div className="approval-campaign-form">
						<label className="approval-checkbox">
							<input
								type="checkbox"
								checked={policyMaterial}
								onChange={(event) => setPolicyMaterial(event.target.checked)}
							/>
							重大变更，既有资格限期重审
						</label>
						{policyMaterial ? (
							<>
								<label>
									重审截止时间
									<input
										type="datetime-local"
										value={policyDeadline}
										onChange={(event) => setPolicyDeadline(event.target.value)}
									/>
								</label>
								<label>
									变更原因
									<textarea
										value={policyReason}
										onChange={(event) => setPolicyReason(event.target.value)}
									/>
								</label>
							</>
						) : null}
						<div className="approval-panel-actions">
							<Button
								variant="secondary"
								onClick={() => setPolicyPublishOpen(false)}
							>
								取消
							</Button>
							<Button
								disabled={
									publishPolicy.isPending ||
									!policyId ||
									(policyMaterial &&
										(!policyReason.trim() ||
											!policyDeadline ||
											Date.parse(policyDeadline) <= Date.now()))
								}
								onClick={() =>
									publishPolicy.mutate({
										policyId,
										body: policyMaterial
											? {
													materialChange: true,
													reapprovalDeadlineAt: new Date(
														policyDeadline,
													).toISOString(),
													reason: policyReason.trim(),
												}
											: { materialChange: false },
									})
								}
							>
								确认发布
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
			<Dialog open={policyRevokeOpen} onOpenChange={setPolicyRevokeOpen}>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>紧急撤销策略</DialogTitle>
					</DialogHeader>
					{revokePolicy.isError ? (
						<PageError error={revokePolicy.error} />
					) : null}
					<div className="approval-campaign-form">
						<p>未完成申请将终止，相关连接资格与新调用将立即暂停。</p>
						<label>
							撤销原因
							<textarea
								value={policyRevokeReason}
								onChange={(event) => setPolicyRevokeReason(event.target.value)}
							/>
						</label>
						<div className="approval-panel-actions">
							<Button
								variant="secondary"
								onClick={() => setPolicyRevokeOpen(false)}
							>
								取消
							</Button>
							<Button
								variant="danger"
								disabled={
									revokePolicy.isPending ||
									!selectedPolicy ||
									!policyRevokeReason.trim()
								}
								onClick={() =>
									selectedPolicy &&
									revokePolicy.mutate({
										policyId: selectedPolicy.id,
										body: {
											expectedRevision: selectedPolicy.revision,
											reason: policyRevokeReason.trim(),
										},
									})
								}
							>
								确认撤销
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
			<Dialog open={campaignOpen} onOpenChange={setCampaignOpen}>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>发起连接重审</DialogTitle>
						<DialogClose asChild>
							<Button
								variant="secondary"
								size="icon"
								type="button"
								aria-label="关闭"
							>
								<X size={16} />
							</Button>
						</DialogClose>
					</DialogHeader>
					<div className="approval-campaign-form">
						<label>
							目标能力包
							<select
								value={campaignProfileId}
								onChange={(event) => {
									setCampaignProfileId(event.target.value);
									setCampaignTriggerVersionId("");
								}}
							>
								<option value="">选择能力包</option>
								{catalog.data?.profiles.map((item) => (
									<option key={item.id} value={item.id}>
										{catalog.data?.providers.find(
											(provider) =>
												provider.providerReleaseId === item.providerReleaseId,
										)?.provider ?? item.providerReleaseId}{" "}
										· {item.name}
									</option>
								))}
							</select>
						</label>
						<label>
							触发变化
							<select
								value={campaignTriggerKind}
								onChange={(event) => {
									setCampaignTriggerKind(
										event.target.value as typeof campaignTriggerKind,
									);
									setCampaignTriggerVersionId("");
								}}
							>
								<option value="DISCLAIMER">重大免责声明</option>
								<option value="POLICY">审批策略</option>
								<option value="PROVIDER_RELEASE">Provider 版本</option>
							</select>
						</label>
						<label>
							已发布版本
							<select
								value={campaignTriggerVersionId}
								onChange={(event) =>
									setCampaignTriggerVersionId(event.target.value)
								}
							>
								<option value="">选择版本</option>
								{triggerOptions.map((item) => (
									<option key={item.id} value={item.id}>
										{item.label}
									</option>
								))}
							</select>
						</label>
						<label>
							重审截止时间
							<input
								type="datetime-local"
								value={campaignDeadline}
								onChange={(event) => setCampaignDeadline(event.target.value)}
							/>
						</label>
						<label>
							原因
							<textarea
								maxLength={1000}
								value={campaignReason}
								onChange={(event) => setCampaignReason(event.target.value)}
							/>
						</label>
						<div className="approval-panel-actions">
							<Button
								variant="secondary"
								onClick={() => setCampaignOpen(false)}
							>
								取消
							</Button>
							<Button
								disabled={
									createCampaign.isPending ||
									!campaignProfile ||
									!campaignTriggerVersionId ||
									!campaignReason.trim() ||
									!Number.isFinite(Date.parse(campaignDeadline))
								}
								onClick={() => {
									if (
										!campaignProfile ||
										!window.confirm(
											`确认对 ${campaignProfile.name} 的连接发起限期重审？`,
										)
									)
										return;
									createCampaign.mutate({
										capabilityProfileId: campaignProfile.id,
										providerReleaseId: campaignProfile.providerReleaseId,
										triggerKind: campaignTriggerKind,
										triggerVersionId: campaignTriggerVersionId,
										deadlineAt: new Date(campaignDeadline).toISOString(),
										reason: campaignReason.trim(),
									});
								}}
							>
								发起重审
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</ConsoleShell>
	);
}

function ApprovalDelegationsPanel() {
	const client = useQueryClient();
	const delegations = useQuery({
		queryKey: ["approval-delegations"],
		queryFn: connectionApi.listApprovalDelegations,
	});
	const [approverSearch, setApproverSearch] = useState("");
	const [delegateSearch, setDelegateSearch] = useState("");
	const [approver, setApprover] = useState<{ id: string; name: string }>();
	const [delegate, setDelegate] = useState<{ id: string; name: string }>();
	const [startsAt, setStartsAt] = useState("");
	const [endsAt, setEndsAt] = useState("");
	const [notice, setNotice] = useState("");
	const approverCandidates = useQuery({
		queryKey: ["approval-employees", approverSearch],
		queryFn: () => connectionApi.searchApprovalEmployees(approverSearch),
		enabled: approverSearch.trim().length >= 2 && !approver,
	});
	const delegateCandidates = useQuery({
		queryKey: ["approval-employees", delegateSearch],
		queryFn: () => connectionApi.searchApprovalEmployees(delegateSearch),
		enabled: delegateSearch.trim().length >= 2 && !delegate,
	});
	const create = useMutation({
		mutationFn: connectionApi.createApprovalDelegation,
		onSuccess: async () => {
			setNotice("审批代理已创建。");
			setApprover(undefined);
			setDelegate(undefined);
			setApproverSearch("");
			setDelegateSearch("");
			await client.invalidateQueries({ queryKey: ["approval-delegations"] });
		},
	});
	const revoke = useMutation({
		mutationFn: (input: { id: string; revision: string }) =>
			connectionApi.revokeApprovalDelegation(input.id, input.revision),
		onSuccess: async () => {
			setNotice("审批代理已撤销。");
			await client.invalidateQueries({ queryKey: ["approval-delegations"] });
		},
	});
	return (
		<section className="approval-delegations" aria-label="审批代理">
			<div className="section-heading">
				<h2>审批代理</h2>
			</div>
			{notice ? <p role="status">{notice}</p> : null}
			{delegations.isError ? <PageError error={delegations.error} /> : null}
			{create.isError ? <PageError error={create.error} /> : null}
			{revoke.isError ? <PageError error={revoke.error} /> : null}
			<form
				className="approval-delegation-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (!approver || !delegate || !startsAt || !endsAt) return;
					create.mutate({
						principalCandidateId: approver.id,
						delegateCandidateId: delegate.id,
						startsAt: new Date(startsAt).toISOString(),
						endsAt: new Date(endsAt).toISOString(),
					});
				}}
			>
				{(
					[
						{
							label: "原审批人",
							value: approverSearch,
							setValue: setApproverSearch,
							selected: approver,
							setSelected: setApprover,
							candidates: approverCandidates,
						},
						{
							label: "代理审批人",
							value: delegateSearch,
							setValue: setDelegateSearch,
							selected: delegate,
							setSelected: setDelegate,
							candidates: delegateCandidates,
						},
					] as const
				).map((field) => (
					<div className="approval-delegation-person" key={field.label}>
						<label>
							{field.label}
							<input
								value={field.value}
								placeholder="搜索员工"
								onChange={(event) => {
									field.setValue(event.target.value);
									field.setSelected(undefined);
								}}
							/>
						</label>
						{!field.selected && field.candidates.data?.candidates.length ? (
							<div className="approval-delegation-candidates">
								{field.candidates.data.candidates.map((candidate) => (
									<button
										type="button"
										key={candidate.candidateId}
										onClick={() => {
											field.setSelected({
												id: candidate.candidateId,
												name: candidate.displayName,
											});
											field.setValue(candidate.displayName);
										}}
									>
										{candidate.displayName}
										{candidate.email ? ` · ${candidate.email}` : ""}
									</button>
								))}
							</div>
						) : null}
					</div>
				))}
				<label>
					开始时间
					<input
						type="datetime-local"
						value={startsAt}
						onChange={(event) => setStartsAt(event.target.value)}
					/>
				</label>
				<label>
					结束时间
					<input
						type="datetime-local"
						value={endsAt}
						onChange={(event) => setEndsAt(event.target.value)}
					/>
				</label>
				<Button
					disabled={
						create.isPending ||
						!approver ||
						!delegate ||
						!startsAt ||
						!endsAt ||
						new Date(endsAt) <= new Date(startsAt) ||
						new Date(endsAt) <= new Date()
					}
					type="submit"
				>
					添加代理
				</Button>
			</form>
			<div className="approval-delegation-list">
				{delegations.data?.delegations.map((item) => (
					<div key={item.id}>
						<strong>
							{item.principalName} → {item.delegateName}
						</strong>
						<span>
							{new Date(item.startsAt).toLocaleString()} -{" "}
							{new Date(item.endsAt).toLocaleString()} · {item.status}
						</span>
						{item.status === "ACTIVE" ? (
							<Button
								size="text"
								variant="secondary"
								disabled={revoke.isPending}
								onClick={() =>
									revoke.mutate({ id: item.id, revision: item.revision })
								}
							>
								撤销
							</Button>
						) : null}
					</div>
				))}
			</div>
		</section>
	);
}
