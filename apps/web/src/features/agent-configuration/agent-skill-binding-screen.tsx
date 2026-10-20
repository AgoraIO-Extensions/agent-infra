import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field } from "@/components/ui/field";
import { IdentifierText } from "@/components/ui/identifier-text";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { LoadingLine } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import type {
	AgentProjectionV2,
	SkillHubAgentBindingCommandV1,
	SkillHubVersionMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";
import type { BrowserSessionState } from "../browser-session.js";
import { RecoveryButton } from "../recovery-button.js";
import { loadSkillHubDirectory } from "../skill-hub/skill-hub.js";
import {
	bindSkillHubAgentVersion,
	readSkillHubAgentBindings,
	type SkillHubManagementRequestError,
} from "../skill-hub/skill-hub-management.js";
import { isAgentConfigurationOwner } from "./agent-configuration.js";
import {
	nextSkillBindingCollection,
	type SkillBindingCandidate,
	type SkillBindingStatus,
	skillBindingCollectionWithout,
	skillBindingView,
	skillGrantSummary,
} from "./agent-skill-binding.js";

export const agentSkillHeadingId = "agent-skill-heading";

/** 绑定卡标题的稳定 id：写入成功后按固定版本找回对应卡片（W-30）。 */
function bindingTitleId(skillVersionId: string) {
	return `skill-binding-title-${skillVersionId}`;
}

/** 确认后的焦点目标：某张绑定卡的标题，或页面 h1（skillVersionId 为 null）。 */
type FocusTarget = { readonly skillVersionId: string | null };

function focusTargetElement(target: FocusTarget) {
	return (
		(target.skillVersionId
			? document.getElementById(bindingTitleId(target.skillVersionId))
			: null) ?? document.getElementById(agentSkillHeadingId)
	);
}

/** 弹窗关闭时的焦点去处（Base UI finalFocus）；interim 为提交仍在进行时的暂留元素。 */
type ConfirmFinalFocus = (
	interim?: () => HTMLElement | null,
) => () => HTMLElement | boolean;

type SessionState = BrowserSessionState | { kind: "loading" };

type AgentSkillBindingScreenProps = {
	agent: AgentProjectionV2;
	/**
	 * 服务端给出的当前 Agent Version（#2903，只对当前 Owner 返回）。为 null 时（读取失败或
	 * 部署未配置）不发出绑定读写请求，也不让用户手填。
	 */
	agentVersion: string | null;
	/** 当前 Agent Version 仍在读取。 */
	agentVersionPending?: boolean;
	session: SessionState;
	/** 轮询同步进度时一并重读 Agent 详情（Runtime 装配摘要在 Agent 投影里）。 */
	onRefreshAgent?: () => void;
	readBindings?: typeof readSkillHubAgentBindings;
	bindVersion?: typeof bindSkillHubAgentVersion;
	loadDirectory?: typeof loadSkillHubDirectory;
};

function requestStatus(error: unknown) {
	return (error as SkillHubManagementRequestError | undefined)?.status;
}

function isRetryableSkillError(error: unknown) {
	const status = requestStatus(error);
	return (
		(error as SkillHubManagementRequestError | undefined)?.retryable !==
			false && ![401, 403, 404].includes(status ?? 0)
	);
}

function versionLabel(version: { readonly name: string; version: string }) {
	return `${version.name} · v${version.version}`;
}

/** 同一输入的重试复用同一个 Idempotency-Key，改变选择后换新 key（AC-6）。 */
function useStableIdempotencyKey() {
	const last = useRef<{ input: string; key: string }>(undefined);
	return (input: unknown) => {
		const serialized = JSON.stringify(input);
		if (last.current?.input !== serialized)
			last.current = { input: serialized, key: crypto.randomUUID() };
		return last.current.key;
	};
}

function NoPermission({ agentId }: { agentId: string }) {
	return (
		<Alert tone="warn" icon={<ShieldAlert aria-hidden="true" />}>
			<AlertTitle>没有权限</AlertTitle>
			<AlertDescription>
				只有当前 Owner 可以管理这个 Agent 的 Skill 绑定。
			</AlertDescription>
			<AlertAction>
				{/* exact：/agents/$agentId 是当前地址的前缀，不让 Link 补 aria-current（N-21）。 */}
				<Link
					activeOptions={{ exact: true }}
					className={buttonVariants({ variant: "outline" })}
					params={{ agentId }}
					to="/agents/$agentId"
				>
					返回 Agent 详情
				</Link>
			</AlertAction>
		</Alert>
	);
}

/**
 * Agent 的 Skill 页（O-02）：从 Owner 配置进入，按绑定显示固定版本、四阶段同步状态与操作。
 * 只对当前 Owner 开放；纯管理员与员工看到无权限说明，不发绑定请求。
 */
export function AgentSkillBindingScreen({
	agent,
	agentVersion,
	agentVersionPending = false,
	session,
	onRefreshAgent,
	readBindings = readSkillHubAgentBindings,
	bindVersion = bindSkillHubAgentVersion,
	loadDirectory = loadSkillHubDirectory,
}: AgentSkillBindingScreenProps) {
	const isOwner =
		session.kind === "ready" &&
		isAgentConfigurationOwner(agent, session.session);
	return (
		<section
			aria-labelledby={agentSkillHeadingId}
			className="agent-skill-bindings"
			data-od-id="agent-skill-bindings-page"
		>
			{/* 站内跳转用路由 Link，不整页重新加载（查询缓存与会话状态保留）。 */}
			<Link
				activeOptions={{ exact: true }}
				className={buttonVariants({ variant: "ghost" })}
				params={{ agentId: agent.agentId }}
				to="/agents/$agentId/configuration"
			>
				<ArrowLeft aria-hidden="true" data-icon="inline-start" />
				返回 Owner 配置
			</Link>
			<header className="page-heading agent-skill-heading">
				<div>
					<p className="page-eyebrow">Owner 配置 / Skill</p>
					<h1 id={agentSkillHeadingId} tabIndex={-1}>
						Agent 的 Skill
					</h1>
					<p>{agent.name} · 固定 Skill 版本，完成同步后才能在对话中使用。</p>
				</div>
				<div className="agent-skill-heading-actions">
					<Link className={buttonVariants({ variant: "outline" })} to="/skills">
						<Plus aria-hidden="true" data-icon="inline-start" />
						浏览 Skill Hub
					</Link>
				</div>
			</header>
			{session.kind === "loading" ? (
				<LoadingLine>正在确认权限…</LoadingLine>
			) : !isOwner ? (
				<NoPermission agentId={agent.agentId} />
			) : agentVersionPending ? (
				<LoadingLine>正在读取当前 Agent 版本…</LoadingLine>
			) : agentVersion === null ? (
				<Alert tone="info">
					<AlertTitle>暂时无法读取当前 Agent 版本</AlertTitle>
					<AlertDescription>
						Skill 固定绑定到 Agent
						的确定版本；平台读取到当前版本后，这里会显示绑定、同步进度和可绑定的版本。当前绑定不受影响。
					</AlertDescription>
				</Alert>
			) : (
				<AgentSkillBindings
					agent={agent}
					agentVersion={agentVersion}
					bindVersion={bindVersion}
					loadDirectory={loadDirectory}
					onRefreshAgent={onRefreshAgent}
					readBindings={readBindings}
				/>
			)}
		</section>
	);
}

function AgentSkillBindings({
	agent,
	agentVersion,
	bindVersion,
	loadDirectory,
	onRefreshAgent,
	readBindings,
}: {
	agent: AgentProjectionV2;
	agentVersion: string;
	bindVersion: typeof bindSkillHubAgentVersion;
	loadDirectory: typeof loadSkillHubDirectory;
	onRefreshAgent?: () => void;
	readBindings: typeof readSkillHubAgentBindings;
}) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const runtimeSkills = agent.capabilities.skills;
	const queryKey = [
		"agents",
		agent.agentId,
		"versions",
		agentVersion,
		"skills",
	] as const;
	const [settling, setSettling] = useState(false);
	const bindings = useQuery({
		queryKey,
		queryFn: () => readBindings(agent.agentId, agentVersion),
		retry: false,
		// 存在等待同步或已同步未装配的项时每 2 秒重读，全部进入终态后停止。
		refetchInterval: settling ? 2000 : false,
	});
	const directory = useQuery({
		queryKey: ["skill-hub", "directory", "agent-binding"],
		queryFn: () => loadDirectory(),
		retry: false,
	});
	const items = bindings.data?.bindings ?? [];
	const views = items.map((binding) => ({
		binding,
		view: skillBindingView(binding, runtimeSkills),
	}));
	const anySettling = views.some(({ view }) => view.settling);
	useEffect(() => setSettling(anySettling), [anySettling]);
	// 轮询时一并重读 Agent 详情：Runtime 装配摘要在 Agent 投影里。
	const refreshAgent = useRef(onRefreshAgent);
	refreshAgent.current = onRefreshAgent;
	useEffect(() => {
		if (!settling) return;
		const timer = window.setInterval(() => refreshAgent.current?.(), 2000);
		return () => window.clearInterval(timer);
	}, [settling]);
	// 某项首次变为对话可用时给一次 Toast。
	const usable = new Set(
		views
			.filter(({ view }) => view.usable)
			.map(({ binding }) => binding.skillVersion.skillVersionId),
	);
	const previousUsable = useRef<Set<string>>(undefined);
	const usableKey = [...usable].sort().join("|");
	useEffect(() => {
		if (!bindings.data) return;
		const current = new Set(usableKey ? usableKey.split("|") : []);
		const before = previousUsable.current;
		previousUsable.current = current;
		if (before && [...current].some((id) => !before.has(id)))
			toast("同步与装配已确认，Skill 可在对话中选择");
	}, [bindings.data, usableKey, toast]);

	const [conflict, setConflict] = useState(false);
	const [writeFailure, setWriteFailure] = useState(false);
	const [forbidden, setForbidden] = useState(false);
	const [writing, setWriting] = useState(false);
	// W-30：确认绑定、解除绑定或更换版本后，焦点交给结果卡片标题或页面 h1，不落到 body。
	// 弹窗关闭（finalFocus）时写入可能仍在进行：先落在暂留元素，成功并回读后再移到结果目标。
	const confirmResult = useRef<
		| { readonly state: "pending" | "failed" }
		| { readonly state: "done"; readonly target: FocusTarget }
		| null
	>(null);
	const [focusRequest, setFocusRequest] = useState<
		(FocusTarget & { readonly revision: number }) | null
	>(null);
	useEffect(() => {
		if (!focusRequest) return;
		// 回读失败时列表被错误提示替换：焦点落在页面 h1。
		if (bindings.isError) {
			document.getElementById(agentSkillHeadingId)?.focus();
			setFocusRequest(null);
			return;
		}
		// 等回读到写入后的配置修订再找目标卡片；找不到时落在页面 h1。
		if (
			!bindings.data ||
			bindings.data.configurationRevision < focusRequest.revision
		)
			return;
		focusTargetElement(focusRequest)?.focus();
		setFocusRequest(null);
	}, [focusRequest, bindings.data, bindings.isError]);
	const openConfirm = () => {
		confirmResult.current = null;
	};
	const finalFocus: ConfirmFinalFocus = (interim) => () => {
		const result = confirmResult.current;
		// 取消、Esc 或写入失败：回到触发按钮。
		if (!result || result.state === "failed") return true;
		if (result.state === "done")
			return focusTargetElement(result.target) ?? false;
		return interim?.() ?? false;
	};
	const idempotencyKey = useStableIdempotencyKey();
	const readOnly = agent.managementStatus === "disabled";
	const published =
		directory.data?.kind === "ready" ? directory.data.versions : [];

	const write = async (
		next: SkillHubAgentBindingCommandV1["bindings"],
		focusAfter: FocusTarget,
		successMessage = "已提交绑定，等待同步",
	): Promise<boolean> => {
		if (!bindings.data || writing) return false;
		confirmResult.current = { state: "pending" };
		const body: SkillHubAgentBindingCommandV1 = {
			schemaVersion: 1,
			expectedConfigurationRevision: bindings.data.configurationRevision,
			bindings: next,
		};
		setWriting(true);
		setConflict(false);
		setWriteFailure(false);
		try {
			const result = await bindVersion(
				agent.agentId,
				agentVersion,
				body,
				idempotencyKey({ agentVersion, body }),
			);
			toast(successMessage);
			await queryClient.invalidateQueries({ queryKey });
			confirmResult.current = { state: "done", target: focusAfter };
			setFocusRequest({
				...focusAfter,
				revision: result.configurationRevision,
			});
			return true;
		} catch (error) {
			confirmResult.current = { state: "failed" };
			const status = requestStatus(error);
			if (status === 403) setForbidden(true);
			else if (status === 409) {
				setConflict(true);
				await bindings.refetch();
			} else setWriteFailure(true);
			return false;
		} finally {
			setWriting(false);
		}
	};

	if (forbidden || requestStatus(bindings.error) === 403)
		return <NoPermission agentId={agent.agentId} />;
	if (bindings.isPending)
		return <LoadingLine>正在读取 Skill 绑定…</LoadingLine>;
	if (bindings.isError || !bindings.data) {
		const retryable = isRetryableSkillError(bindings.error);
		return (
			<Alert tone="danger" role="alert">
				<AlertTitle>
					{retryable ? "暂时无法读取 Skill 绑定" : "无法读取 Skill 绑定"}
				</AlertTitle>
				<AlertDescription>
					{retryable
						? "当前绑定不受影响，可以重新读取。"
						: "这个 Agent 的 Skill 绑定当前不可用，请刷新页面或返回 Owner 配置。"}
				</AlertDescription>
				{retryable ? (
					<AlertAction>
						<RecoveryButton
							variant="outline"
							recoveryKey="重新读取"
							busy={bindings.isFetching}
							onClick={() => void bindings.refetch()}
						>
							<RefreshCw aria-hidden="true" data-icon="inline-start" />
							{bindings.isFetching ? "正在重新读取…" : "重新读取"}
						</RecoveryButton>
					</AlertAction>
				) : null}
			</Alert>
		);
	}

	return (
		<>
			<Alert tone="info" icon={null} className="agent-skill-version-notice">
				{/* 部署配置的 Agent Version 没有显示名：按内部标识的等宽短形式显示，title 为完整值（W-37）。 */}
				<AlertTitle>
					当前 Agent 版本：
					<IdentifierText value={agentVersion} label="Agent 版本" />
				</AlertTitle>
				<AlertDescription>
					升级前需要确认；已受理的任务继续使用原版本。
				</AlertDescription>
			</Alert>
			{conflict ? (
				<Alert tone="warn" role="status" className="agent-skill-notice">
					<AlertDescription>
						绑定已被其他修改更新，已重新读取，请确认后再试。
					</AlertDescription>
				</Alert>
			) : null}
			{writeFailure ? (
				<Alert tone="danger" role="alert" className="agent-skill-notice">
					<AlertDescription>绑定未完成，请重试。</AlertDescription>
				</Alert>
			) : null}
			{views.length === 0 ? (
				<Empty className="agent-skill-empty">
					<EmptyHeader>
						<EmptyMedia>
							<Plus aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>还未绑定 Skill</EmptyTitle>
						<EmptyDescription>
							先加入自己的库，再绑定到当前 Agent 版本。
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				views.map(({ binding, view }, index) => (
					<SkillBindingCard
						key={binding.skillVersion.skillVersionId}
						agentId={agent.agentId}
						binding={binding}
						finalFocus={finalFocus}
						onDialogOpen={openConfirm}
						otherVersions={published.filter(
							(version) =>
								version.skillId === binding.skillVersion.skillId &&
								version.skillVersionId !== binding.skillVersion.skillVersionId,
						)}
						readOnly={readOnly}
						view={view}
						writing={writing}
						onChangeVersion={(target) => {
							const next = nextSkillBindingCollection(items, {
								skillVersionId: target.skillVersionId,
								skillName: binding.skillName,
							});
							// 空集合表示解除全部绑定：组装不出新集合时不提交。
							return next
								? write(next, { skillVersionId: target.skillVersionId })
								: Promise.resolve(false);
						}}
						onUnbind={() => {
							// 解除后焦点交给下一张仍保留的卡片；没有时交给页面 h1。
							const following = items
								.slice(index + 1)
								.find((item) => item.state !== "revoked");
							return write(
								skillBindingCollectionWithout(
									items,
									binding.skillVersion.skillVersionId,
								),
								{
									skillVersionId:
										following?.skillVersion.skillVersionId ?? null,
								},
								"已解除绑定",
							);
						}}
					/>
				))
			)}
			{readOnly ? null : (
				<BindVersionForm
					agentName={agent.name}
					bindings={items}
					candidates={published}
					directoryFailed={
						directory.isError || directory.data?.kind === "unavailable"
					}
					writing={writing}
					finalFocus={finalFocus}
					onDialogOpen={openConfirm}
					onBind={(next, skillVersionId) => write(next, { skillVersionId })}
					onDuplicate={() => toast("这个固定版本已经绑定")}
				/>
			)}
		</>
	);
}

function SkillBindingCard({
	agentId,
	binding,
	finalFocus,
	onDialogOpen,
	otherVersions,
	readOnly,
	view,
	writing,
	onChangeVersion,
	onUnbind,
}: {
	agentId: string;
	binding: SkillBindingStatus;
	finalFocus: ConfirmFinalFocus;
	onDialogOpen: () => void;
	otherVersions: readonly SkillHubVersionMetadataV1[];
	readOnly: boolean;
	view: ReturnType<typeof skillBindingView>;
	writing: boolean;
	onChangeVersion: (target: SkillHubVersionMetadataV1) => Promise<boolean>;
	onUnbind: () => Promise<boolean>;
}) {
	const titleId = bindingTitleId(binding.skillVersion.skillVersionId);
	const name = binding.skillName;
	const revoked = binding.state === "revoked";
	return (
		<article
			aria-labelledby={titleId}
			className="skill-binding-card"
			data-state={binding.state}
		>
			<div className="skill-binding-head">
				<div className="min-w-0">
					{/* tabIndex=-1：绑定、更换版本或解除相邻卡片后焦点落在这里（W-30）。 */}
					<h2 id={titleId} tabIndex={-1}>
						{name}{" "}
						<span className="quiet-pill">v{binding.skillVersion.version}</span>
					</h2>
					<p>{skillGrantSummary(binding.grant)}</p>
				</div>
				<Badge tone={view.chip.tone}>{view.chip.label}</Badge>
			</div>
			{view.stages ? (
				<ol
					className="sync-stages"
					aria-label={withObjectName("同步阶段", name)}
				>
					{view.stages.map((stage) => (
						<li
							key={stage.label}
							className="sync-stage"
							data-current={stage.current ? "true" : undefined}
							data-failed={stage.failed ? "true" : undefined}
							aria-current={stage.current ? "step" : undefined}
						>
							<span>{stage.label}</span>
							<span className="sr-only">：</span>
							<strong>{stage.state}</strong>
						</li>
					))}
				</ol>
			) : null}
			{view.error ? <p className="skill-binding-error">{view.error}</p> : null}
			<div className="skill-actions">
				{view.usable ? (
					<Link
						className={buttonVariants({ variant: "outline" })}
						params={{ agentId, conversationId: undefined }}
						search={{ view: undefined }}
						to="/chat/$agentId/{-$conversationId}"
						aria-label={withObjectName("在对话中选择", name)}
					>
						在对话中选择
					</Link>
				) : null}
				{!revoked && !readOnly && otherVersions.length > 0 ? (
					<ChangeVersionDialog
						binding={binding}
						// 写入回读前弹窗随旧卡片卸载时，先暂留在本卡标题（仍在页面时）。
						finalFocus={finalFocus(() => document.getElementById(titleId))}
						otherVersions={otherVersions}
						writing={writing}
						onConfirm={onChangeVersion}
						onOpen={onDialogOpen}
					/>
				) : null}
				<Link
					className={buttonVariants({ variant: "ghost" })}
					params={{ skillVersionId: binding.skillVersion.skillVersionId }}
					to="/skills/$skillVersionId"
					aria-label={withObjectName("版本详情", name)}
				>
					版本详情
				</Link>
				{readOnly ? null : (
					<ConfirmDialog
						variant="skill"
						title="确认解除绑定"
						subject={{ name: `${name} · v${binding.skillVersion.version}` }}
						description="解除后，新的调用不再提供这个 Skill；现有执行保留原版本。"
						confirmLabel="解除绑定"
						disabled={writing}
						onOpenChange={(open) => {
							if (open) onDialogOpen();
						}}
						// 提交期间先落在本卡标题，成功后移到下一张卡片或页面 h1。
						finalFocus={finalFocus(() => document.getElementById(titleId))}
						onConfirm={() => void onUnbind()}
						trigger={
							<Button
								type="button"
								variant="ghost"
								aria-label={withObjectName("解除绑定", name)}
							>
								解除绑定
							</Button>
						}
					/>
				)}
			</div>
		</article>
	);
}

/** 「更换固定版本」：选择同一 Skill 的另一个已发布版本，确认后只替换这一项。 */
function ChangeVersionDialog({
	binding,
	finalFocus,
	otherVersions,
	writing,
	onConfirm,
	onOpen,
}: {
	binding: SkillBindingStatus;
	finalFocus: () => HTMLElement | boolean;
	otherVersions: readonly SkillHubVersionMetadataV1[];
	writing: boolean;
	onConfirm: (target: SkillHubVersionMetadataV1) => Promise<boolean>;
	onOpen: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [targetId, setTargetId] = useState(
		otherVersions[0]?.skillVersionId ?? "",
	);
	const target =
		otherVersions.find((version) => version.skillVersionId === targetId) ??
		otherVersions[0];
	const selectId = useId();
	return (
		<Dialog open={open} onOpenChange={(next) => !writing && setOpen(next)}>
			<Button
				type="button"
				variant="ghost"
				disabled={writing}
				aria-label={withObjectName("更换固定版本", binding.skillName)}
				onClick={() => {
					onOpen();
					setOpen(true);
				}}
			>
				更换固定版本
			</Button>
			{/* 成功后本卡随新版本重建：焦点交给新版本卡片标题（W-30）。 */}
			<DialogContent variant="skill" finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>更换固定版本</DialogTitle>
				</DialogHeader>
				<DialogBody className="space-y-[15px]">
					<p className="font-[650]">
						{binding.skillName} · v{binding.skillVersion.version} → v
						{target?.version}
					</p>
					<Field>
						<Label htmlFor={selectId}>目标版本</Label>
						<NativeSelect
							id={selectId}
							value={target?.skillVersionId ?? ""}
							onChange={(event) => setTargetId(event.target.value)}
						>
							{otherVersions.map((version) => (
								<NativeSelectOption
									key={version.skillVersionId}
									value={version.skillVersionId}
								>
									v{version.version}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<DialogDescription>
						现有执行保留原版本。新的调用要等同步和装配确认完成。
					</DialogDescription>
				</DialogBody>
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />} disabled={writing}>
						取消
					</DialogClose>
					<Button
						type="button"
						disabled={writing || !target}
						focusableWhenDisabled
						onClick={async () => {
							if (!target || writing) return;
							if (await onConfirm(target)) setOpen(false);
						}}
					>
						{writing ? "正在提交…" : "确认版本变更"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** 「绑定固定版本」：候选为当前用户可见的已发布版本（待确认 2），确认后提交完整集合。 */
function BindVersionForm({
	agentName,
	bindings,
	candidates,
	directoryFailed,
	finalFocus,
	writing,
	onBind,
	onDialogOpen,
	onDuplicate,
}: {
	agentName: string;
	bindings: readonly SkillBindingStatus[];
	candidates: readonly SkillHubVersionMetadataV1[];
	directoryFailed: boolean;
	finalFocus: ConfirmFinalFocus;
	writing: boolean;
	onBind: (
		next: SkillHubAgentBindingCommandV1["bindings"],
		skillVersionId: string,
	) => Promise<boolean>;
	onDialogOpen: () => void;
	onDuplicate: () => void;
}) {
	const [selectedId, setSelectedId] = useState("");
	const [open, setOpen] = useState(false);
	const selected =
		candidates.find((version) => version.skillVersionId === selectedId) ??
		candidates[0];
	const candidate: SkillBindingCandidate | undefined = selected
		? { skillVersionId: selected.skillVersionId, skillName: selected.name }
		: undefined;
	const selectId = useId();
	const helpId = useId();
	return (
		<section
			aria-labelledby={`${selectId}-title`}
			className="skill-binding-card skill-bind-form"
			data-od-id="skill-bind-form"
		>
			{/* 标题沿用「绑定固定版本」：候选是 Skill Hub 中可见的已发布版本，不限于「我的库」
			    （W-31 待回写）。tabIndex=-1：确认绑定后、回读完成前焦点暂留在这里。 */}
			<h2 id={`${selectId}-title`} tabIndex={-1}>
				绑定固定版本
			</h2>
			<div className="skill-bind-grid">
				<Field>
					<Label htmlFor={selectId}>固定版本</Label>
					<NativeSelect
						id={selectId}
						disabled={candidates.length === 0}
						value={selected?.skillVersionId ?? ""}
						aria-describedby={helpId}
						onChange={(event) => setSelectedId(event.target.value)}
					>
						{candidates.length === 0 ? (
							<NativeSelectOption value="">
								{directoryFailed
									? "暂时无法读取可绑定的版本"
									: "没有可绑定的版本"}
							</NativeSelectOption>
						) : null}
						{candidates.map((version) => (
							<NativeSelectOption
								key={version.skillVersionId}
								value={version.skillVersionId}
							>
								{versionLabel(version)}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
				<div className="skill-bind-submit">
					<p id={helpId} className="skill-bind-help">
						仅当前 Owner 可修改
					</p>
					<ConfirmDialog
						variant="skill"
						tone="default"
						title="确认绑定固定版本"
						subject={selected ? { name: versionLabel(selected) } : undefined}
						description={
							<dl className="skill-binding-facts">
								<dt>Agent</dt>
								<dd>{agentName}</dd>
								<dt>文件范围</dt>
								<dd>不额外授予文件或网络权限</dd>
								<dt>脚本</dt>
								<dd>禁用</dd>
								<dt>生效条件</dt>
								<dd>同步完成且装配确认</dd>
							</dl>
						}
						confirmLabel="确认绑定"
						disabled={!candidate || writing}
						open={open}
						onOpenChange={(next) => {
							if (!next) {
								setOpen(false);
								return;
							}
							if (!candidate) return;
							// 同一版本已绑定：只提示，不打开确认、不发请求。
							if (nextSkillBindingCollection(bindings, candidate) === null) {
								onDuplicate();
								return;
							}
							onDialogOpen();
							setOpen(true);
						}}
						finalFocus={finalFocus(() =>
							document.getElementById(`${selectId}-title`),
						)}
						onConfirm={() => {
							if (!candidate) return;
							const next = nextSkillBindingCollection(bindings, candidate);
							if (next) void onBind(next, candidate.skillVersionId);
						}}
						trigger={<Button type="button">绑定固定版本</Button>}
					/>
				</div>
			</div>
		</section>
	);
}
