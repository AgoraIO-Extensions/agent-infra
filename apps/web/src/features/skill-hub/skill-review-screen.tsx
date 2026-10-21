import { Shield, ShieldOff } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { IdentifierText } from "@/components/ui/identifier-text";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Timestamp } from "@/components/ui/timestamp";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import { cjkSpaced } from "@/lib/cjk-spacing";
import type {
	SkillHubReviewQueueItemV1,
	SkillHubReviewRequestV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type DirectoryNames,
	DirectoryReadAlert,
	useDirectoryNames,
} from "../directory-names.js";
import {
	type SkillHubVersionState,
	skillHubProviderLabels,
	skillHubVisibilityLabels,
} from "./skill-hub-labels.js";
import type { reviewSkillHubVersion } from "./skill-hub-management.js";
import { FieldErrorText } from "./skill-hub-management-screen.js";
import { SkillHubStateChip } from "./skill-hub-scope-pill.js";
import {
	SkillHubEmpty,
	SkillHubLoading,
	SkillHubReadFailure,
} from "./skill-hub-screen.js";
import { SkillBody } from "./skill-hub-version-screen.js";
import {
	type SkillReviewQueueReadState,
	useSkillReviewContent,
} from "./skill-review-queue.js";

/** 与契约 SkillHubReviewRequestV1.reason 上限一致。 */
export const skillReviewReasonMaxLength = 1024;
const selfReviewText = "不能审核自己发布的版本";
/**
 * 平台对 Skill 的固定权限规则（PRD §11.5：不扩大既有权限、脚本默认不执行）。
 * 审核队列投影不含逐版本授权，行内与弹窗都只陈述这条规则。
 */
const permissionStatement = "脚本禁用 · 仅使用 Agent 已有权限";

/** 服务端待审队列的一项；ownerId 用于隐藏自审入口，服务端仍会拒绝自审。 */
export type SkillReviewItem = SkillHubReviewQueueItemV1;

export type SkillReviewQueueState =
	| { kind: "loading" }
	| SkillReviewQueueReadState;

type ReviewAction = (
	skillVersionId: string,
	body: SkillHubReviewRequestV1,
	idempotencyKey: string,
) => ReturnType<typeof reviewSkillHubVersion>;

/** 行与弹窗共用的显示文字：发布者与组织名称由页面级目录读取解析。 */
type ReviewNames = {
	submitter: string;
	submitterUnresolved: boolean;
	scope: string;
};

type RequestFailure = { status?: number; code?: string; retryable?: boolean };

function reviewFailureMessage(error: unknown) {
	const { status, code, retryable } =
		error && typeof error === "object" ? (error as RequestFailure) : {};
	if (code === "owner_cannot_review") return selfReviewText;
	if (status === 403) return "当前账号不能审核这个版本。";
	if (status === 404 || status === 409)
		return "版本状态已变化，队列已重新读取。";
	if (status === 503 || retryable) return "审核暂时无法提交，请稍后重试。";
	return "审核未完成，请稍后重试。";
}

function reviewNames(
	item: SkillReviewItem,
	users: DirectoryNames,
	organizations: DirectoryNames,
): ReviewNames {
	const submitter = users.resolve(item.ownerId);
	const pending = !submitter.resolved && users.status === "loading";
	const organization =
		item.organizationId === null
			? null
			: organizations.resolve(item.organizationId);
	return {
		submitter: pending ? "读取中…" : submitter.name,
		submitterUnresolved: !pending && !submitter.resolved,
		scope:
			organization === null
				? skillHubVisibilityLabels[item.visibility]
				: `${skillHubVisibilityLabels[item.visibility]}：${
						!organization.resolved && organizations.status === "loading"
							? "读取中…"
							: organization.name
					}`,
	};
}

export function SkillReviewsScreen({
	isAdministrator,
	currentUserId,
	queue,
	review,
	onRetry,
	retrying = false,
	onReviewed,
}: {
	isAdministrator: boolean;
	currentUserId: string;
	queue: SkillReviewQueueState;
	review: ReviewAction;
	onRetry?: () => void;
	retrying?: boolean;
	/** 审核成功或版本状态已变化后回读队列。 */
	onReviewed?: () => void;
}) {
	const id = useId();
	const items = queue.kind === "ready" ? queue.items : [];
	const users = useDirectoryNames(
		"user",
		items.map((item) => item.ownerId),
	);
	const organizations = useDirectoryNames(
		"organization",
		items.flatMap((item) =>
			item.organizationId === null ? [] : [item.organizationId],
		),
	);
	return (
		<section className="skill-page" aria-labelledby={`${id}-heading`}>
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">系统管理 / Skill 审核</p>
					<h1 id={`${id}-heading`} tabIndex={-1}>
						Skill 发布审核
					</h1>
					<p>核对来源、固定版本、共享范围和权限声明。</p>
				</div>
			</header>
			{!isAdministrator ? (
				<SkillHubEmpty
					role="status"
					icon={<ShieldOff aria-hidden="true" />}
					title="没有访问权限"
					description="Skill 审核只对系统管理员开放。"
				/>
			) : queue.kind === "loading" ? (
				<SkillHubLoading>正在读取待审核版本…</SkillHubLoading>
			) : queue.kind === "unavailable" ? (
				<SkillHubReadFailure
					retryable={queue.retryable}
					reason={queue.reason}
					retryTitle="暂时无法读取审核队列"
					retryDescription="已提交的版本保持待审核，可以稍后重新读取。"
					deniedText="当前账号没有读取审核队列的权限。"
					unavailableText="审核队列暂时无法访问，请联系管理员。"
					onRetry={onRetry}
					retrying={retrying}
				/>
			) : items.length === 0 ? (
				<SkillHubEmpty
					icon={<Shield aria-hidden="true" />}
					title="当前没有待审核版本"
					description="审核结果会显示在版本详情里。"
				/>
			) : (
				<>
					<DirectoryReadAlert names={[users, organizations]} />
					<div className="skill-surface">
						{items.map((item) => (
							<SkillReviewRow
								key={item.skillVersionId}
								item={item}
								names={reviewNames(item, users, organizations)}
								self={item.ownerId === currentUserId}
								identityKey={currentUserId}
								review={review}
								onReviewed={onReviewed}
							/>
						))}
					</div>
				</>
			)}
			{isAdministrator ? (
				<p className="skill-form-hint">
					发布者不能审核自己的版本；驳回时要填写原因。
				</p>
			) : null}
		</section>
	);
}

function SkillReviewRow({
	item,
	names,
	self,
	identityKey,
	review,
	onReviewed,
}: {
	item: SkillReviewItem;
	names: ReviewNames;
	self: boolean;
	identityKey: string;
	review: ReviewAction;
	onReviewed?: () => void;
}) {
	// 审核结果先在本行显示，队列回读后该行离开队列。
	const [state, setState] = useState<SkillHubVersionState>(item.state);
	return (
		<article className="skill-row">
			<span className="skill-mark" aria-hidden="true">
				<Shield />
			</span>
			<div className="skill-row-copy">
				<h2>{item.name}</h2>
				<p>
					{cjkSpaced`${names.submitter}申请`}
					{names.submitterUnresolved ? (
						<>
							{" "}
							<IdentifierText value={item.ownerId} label="发布者 ID" />
						</>
					) : null}
					{" · "}
					{names.scope} · {skillHubProviderLabels[item.provider]} ·{" "}
					<Timestamp value={item.submittedAt} />
				</p>
				{/* 设计行内 quiet-pill（V-06）：与审阅弹窗「权限声明」同一条平台规则，不按版本推测授权。 */}
				<span className="quiet-pill">{permissionStatement}</span>
				{self ? <p className="skill-form-hint">{selfReviewText}</p> : null}
			</div>
			<div className="skill-row-meta">
				<strong>v{item.version}</strong>
				<SkillHubStateChip state={state} />
			</div>
			{/* 创建者看不到自己版本的审核入口（PRD §11.5）。 */}
			{self ? null : (
				<div className="skill-actions">
					<SkillReviewDialog
						item={item}
						names={names}
						identityKey={identityKey}
						disabled={state !== "pending_review"}
						review={review}
						onReviewed={(next) => {
							if (next) setState(next);
							onReviewed?.();
						}}
					/>
				</div>
			)}
		</article>
	);
}

export function SkillReviewDialog({
	item,
	names,
	identityKey,
	disabled = false,
	review,
	onReviewed,
}: {
	item: SkillReviewItem;
	names: ReviewNames;
	/** 读取待审正文的查询身份（当前用户 ID）。 */
	identityKey: string;
	disabled?: boolean;
	review: ReviewAction;
	/** 成功时带回新状态；版本已不在待审状态时不带状态，只回读队列。 */
	onReviewed?: (state?: SkillHubVersionState) => void;
}) {
	const id = useId();
	const toast = useToast();
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState("");
	const [reasonError, setReasonError] = useState("");
	const [failure, setFailure] = useState("");
	const [busy, setBusy] = useState(false);
	const reasonInput = useRef<HTMLTextAreaElement>(null);
	const keys = useRef(new Map<string, { fingerprint: string; key: string }>());

	function keyFor(body: SkillHubReviewRequestV1) {
		const fingerprint = JSON.stringify(body);
		const previous = keys.current.get(item.skillVersionId);
		if (previous?.fingerprint === fingerprint) return previous.key;
		const key = crypto.randomUUID();
		keys.current.set(item.skillVersionId, { fingerprint, key });
		return key;
	}

	async function submit(decision: SkillHubReviewRequestV1["decision"]) {
		if (busy) return;
		const trimmed = reason.trim();
		if (decision === "reject" && !trimmed) {
			setReasonError("请填写驳回原因。");
			reasonInput.current?.focus();
			return;
		}
		if (trimmed.length > skillReviewReasonMaxLength) {
			setReasonError(`原因最多 ${skillReviewReasonMaxLength} 个字符。`);
			reasonInput.current?.focus();
			return;
		}
		setReasonError("");
		setFailure("");
		setBusy(true);
		const body: SkillHubReviewRequestV1 = trimmed
			? { decision, reason: trimmed }
			: { decision };
		try {
			const result = await review(item.skillVersionId, body, keyFor(body));
			keys.current.delete(item.skillVersionId);
			onReviewed?.(result.version.state);
			setOpen(false);
			toast(
				decision === "approve"
					? "版本已批准发布，现有绑定继续使用原版本"
					: "已驳回，发布者可修改后重提",
			);
		} catch (error) {
			setFailure(reviewFailureMessage(error));
			const { status } =
				error && typeof error === "object" ? (error as RequestFailure) : {};
			// 版本已被他人处理或不存在：回读队列，不在本行假定新状态。
			if (status === 404 || status === 409) onReviewed?.();
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setReasonError("");
					setFailure("");
				}
			}}
		>
			<DialogTrigger
				disabled={disabled}
				render={
					<Button
						variant="outline"
						type="button"
						aria-label={withObjectName(
							"审阅",
							`${item.name} · v${item.version}`,
						)}
					/>
				}
			>
				审阅
			</DialogTrigger>
			<DialogContent variant="skill">
				<DialogHeader>
					<DialogTitle>审阅发布申请</DialogTitle>
				</DialogHeader>
				<DialogBody className="space-y-4">
					{/* 设计：事实列表下方紧跟 pre.skill-code，纯文本显示待审的 SKILL.md（#3046）；两者作为一组与审核说明分隔。 */}
					<div>
						<dl className="skill-facts skill-dialog-facts">
							<dt>Skill</dt>
							<dd>
								{item.name} · v{item.version}
							</dd>
							<dt>申请人</dt>
							<dd>
								{names.submitter}
								{names.submitterUnresolved ? (
									<>
										{" "}
										<IdentifierText value={item.ownerId} label="发布者 ID" />
									</>
								) : null}
							</dd>
							<dt>提交时间</dt>
							<dd>
								<Timestamp value={item.submittedAt} />
							</dd>
							<dt>共享范围</dt>
							<dd>{names.scope}</dd>
							<dt>来源</dt>
							<dd>{skillHubProviderLabels[item.provider]}</dd>
							<dt>权限声明</dt>
							<dd>仅使用 Agent 已有权限 · 脚本禁用</dd>
						</dl>
						<SkillReviewContent
							skillVersionId={item.skillVersionId}
							identityKey={identityKey}
						/>
					</div>
					<Field className="skill-review-reason">
						<Label htmlFor={`${id}-reason`}>审核说明 · 驳回时必填</Label>
						<Textarea
							ref={reasonInput}
							id={`${id}-reason`}
							value={reason}
							maxLength={skillReviewReasonMaxLength}
							placeholder="说明未通过的原因或需要修改的内容"
							disabled={busy}
							aria-invalid={reasonError ? "true" : undefined}
							aria-describedby={reasonError ? `${id}-reason-error` : undefined}
							onChange={(event) => {
								setReason(event.target.value);
								setReasonError("");
							}}
						/>
						{reasonError ? (
							<FieldErrorText id={`${id}-reason-error`}>
								{reasonError}
							</FieldErrorText>
						) : null}
					</Field>
					{failure ? (
						<Alert tone="danger" role="alert">
							<AlertDescription>{failure}</AlertDescription>
						</Alert>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						type="button"
						disabled={busy}
						onClick={() => void submit("reject")}
					>
						驳回
					</Button>
					<Button
						type="button"
						disabled={busy}
						onClick={() => void submit("approve")}
					>
						批准发布
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** 不可读的待审正文按原因说明；不显示状态码或服务端内部原因。 */
function unreadableContentText(reason?: string) {
	if (reason === "denied") return "当前账号没有读取待审正文的权限。";
	if (reason === "not-found") return "这个版本已不在待审核状态，正文不再提供。";
	return "待审正文暂时无法访问，请联系管理员。";
}

/**
 * 审阅弹窗里的待审 SKILL.md（#3046）：读取中、可重试的读取失败、无权或已不在队列、内容不可用
 * 与截断分别反馈。正文只按纯文本显示，不解析 Markdown 或 HTML，也不执行其中的脚本。
 * 只在弹窗打开时挂载，关闭后查询随之释放，正文不留在缓存里。
 */
function SkillReviewContent({
	skillVersionId,
	identityKey,
}: {
	skillVersionId: string;
	identityKey: string;
}) {
	const query = useSkillReviewContent({ identityKey, skillVersionId });
	const container = useRef<HTMLDivElement>(null);
	const state = query.data;
	let content: ReactNode;
	if (query.isError)
		content = (
			<Alert tone="danger" role="alert">
				<AlertDescription>
					暂时无法读取 SKILL.md 正文，可以稍后重新读取。
				</AlertDescription>
				<AlertAction>
					<Button
						variant="outline"
						type="button"
						onClick={() => {
							// 重新读取时失败提示连同按钮一起换成读取中：先把焦点交给正文区域，不落到 body。
							container.current?.focus();
							void query.refetch();
						}}
					>
						重新读取正文
					</Button>
				</AlertAction>
			</Alert>
		);
	else if (!state)
		content = (
			<p className="skill-form-hint" role="status">
				正在读取 SKILL.md 正文…
			</p>
		);
	else if (state.kind === "unavailable")
		content = (
			<Alert tone="warn" role="alert">
				<AlertDescription>
					{unreadableContentText(state.reason)}
				</AlertDescription>
			</Alert>
		);
	else if (state.content.state === "unavailable")
		content = (
			<Alert tone="warn" role="status">
				<AlertDescription>
					这个版本的正文暂时无法读取，其余审核信息不受影响。
				</AlertDescription>
			</Alert>
		);
	else
		content = (
			<>
				{state.content.body ? (
					<SkillBody body={state.content.body} />
				) : (
					<p className="skill-form-hint">SKILL.md 没有正文。</p>
				)}
				{state.content.bodyTruncated ? (
					<p className="skill-form-hint">
						正文较长，这里只显示开头部分（64 KiB）。
					</p>
				) : null}
			</>
		);
	return (
		<div ref={container} tabIndex={-1} className="skill-review-content">
			{content}
		</div>
	);
}
