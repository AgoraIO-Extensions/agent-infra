import { Shield, ShieldOff } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import type {
	SkillHubPublicationVersionV1,
	SkillHubReviewRequestV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	skillHubProviderLabels,
	skillHubVisibilityLabels,
} from "./skill-hub-labels.js";
import type { reviewSkillHubVersion } from "./skill-hub-management.js";
import { FieldErrorText } from "./skill-hub-management-screen.js";
import { SkillHubStateChip } from "./skill-hub-scope-pill.js";
import { SkillHubEmpty } from "./skill-hub-screen.js";

/** 与契约 SkillHubReviewRequestV1.reason 上限一致。 */
export const skillReviewReasonMaxLength = 1024;
const selfReviewText = "不能审核自己发布的版本";

/** 待审核版本；ownerId 用于在界面上先拦住自审，服务端仍会拒绝。 */
export type SkillReviewItem = Pick<
	SkillHubPublicationVersionV1,
	"skillVersionId" | "version" | "provider" | "visibility" | "state"
> & {
	name: string;
	ownerId: string;
	submitterName: string;
};

export type SkillReviewQueueState =
	| { kind: "unavailable" }
	| { kind: "ready"; items: SkillReviewItem[] };

type ReviewAction = (
	skillVersionId: string,
	body: SkillHubReviewRequestV1,
	idempotencyKey: string,
) => ReturnType<typeof reviewSkillHubVersion>;

type RequestFailure = { status?: number; code?: string; retryable?: boolean };

function reviewFailureMessage(error: unknown) {
	const { status, code, retryable } =
		error && typeof error === "object" ? (error as RequestFailure) : {};
	if (code === "owner_cannot_review") return selfReviewText;
	if (status === 403) return "当前账号不能审核这个版本。";
	if (status === 409) return "版本状态已变化，请刷新队列后再审核。";
	if (status === 503 || retryable) return "审核暂时无法提交，请稍后重试。";
	return "审核未完成，请稍后重试。";
}

export function SkillReviewsScreen({
	isAdministrator,
	currentUserId,
	queue,
	review,
}: {
	isAdministrator: boolean;
	currentUserId: string;
	queue: SkillReviewQueueState;
	review: ReviewAction;
}) {
	const id = useId();
	return (
		<section className="skill-page" aria-labelledby={`${id}-heading`}>
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">系统管理 / Skill 审核</p>
					<h1 id={`${id}-heading`}>Skill 发布审核</h1>
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
			) : queue.kind === "unavailable" ? (
				// 服务端还没有可读的待审队列；不提供手填版本 ID 的替代入口。
				<SkillHubEmpty
					role="status"
					icon={<Shield aria-hidden="true" />}
					title="审核队列暂不可用"
					description="待审核版本列表尚未接入，暂时不能在这里审阅。已提交的版本保持待审核。"
				/>
			) : queue.items.length === 0 ? (
				<SkillHubEmpty
					icon={<Shield aria-hidden="true" />}
					title="当前没有待审核版本"
					description="审核结果会显示在版本详情里。"
				/>
			) : (
				<div className="skill-surface">
					{queue.items.map((item) => (
						<SkillReviewRow
							key={item.skillVersionId}
							item={item}
							self={item.ownerId === currentUserId}
							review={review}
						/>
					))}
				</div>
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
	self,
	review,
}: {
	item: SkillReviewItem;
	self: boolean;
	review: ReviewAction;
}) {
	const hintId = useId();
	const [state, setState] = useState(item.state);
	const pending = state === "pending_review";
	return (
		<article className="skill-row">
			<span className="skill-mark" aria-hidden="true">
				<Shield />
			</span>
			<div className="skill-row-copy">
				<h2>{item.name}</h2>
				<p>
					{item.submitterName}申请 · {skillHubVisibilityLabels[item.visibility]}{" "}
					· {skillHubProviderLabels[item.provider]}
				</p>
				{self ? (
					<p id={hintId} className="skill-form-hint">
						{selfReviewText}
					</p>
				) : null}
			</div>
			<div className="skill-row-meta">
				<strong>v{item.version}</strong>
				<SkillHubStateChip state={state} />
			</div>
			<div className="skill-actions">
				<SkillReviewDialog
					item={item}
					self={self}
					disabled={!pending}
					describedBy={self ? hintId : undefined}
					review={review}
					onReviewed={setState}
				/>
			</div>
		</article>
	);
}

export function SkillReviewDialog({
	item,
	self,
	disabled = false,
	describedBy,
	review,
	onReviewed,
}: {
	item: SkillReviewItem;
	self: boolean;
	disabled?: boolean;
	describedBy?: string;
	review: ReviewAction;
	onReviewed?: (state: SkillReviewItem["state"]) => void;
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
	const blocked = self || busy;

	function keyFor(body: SkillHubReviewRequestV1) {
		const fingerprint = JSON.stringify(body);
		const previous = keys.current.get(item.skillVersionId);
		if (previous?.fingerprint === fingerprint) return previous.key;
		const key = crypto.randomUUID();
		keys.current.set(item.skillVersionId, { fingerprint, key });
		return key;
	}

	async function submit(decision: SkillHubReviewRequestV1["decision"]) {
		if (blocked) return;
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
				disabled={disabled || self}
				render={
					<Button
						variant="outline"
						type="button"
						aria-label={withObjectName(
							"审阅",
							`${item.name} · v${item.version}`,
						)}
						aria-describedby={describedBy}
					/>
				}
			>
				审阅
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>审阅发布申请</DialogTitle>
				</DialogHeader>
				<DialogBody className="space-y-4">
					<dl className="skill-facts skill-dialog-facts">
						<dt>Skill</dt>
						<dd>
							{item.name} · v{item.version}
						</dd>
						<dt>申请人</dt>
						<dd>{item.submitterName}</dd>
						<dt>共享范围</dt>
						<dd>{skillHubVisibilityLabels[item.visibility]}</dd>
						<dt>来源</dt>
						<dd>{skillHubProviderLabels[item.provider]}</dd>
						<dt>权限声明</dt>
						<dd>仅使用 Agent 已有权限 · 脚本禁用</dd>
					</dl>
					<Field>
						<Label htmlFor={`${id}-reason`}>审核说明 · 驳回时必填</Label>
						<Textarea
							ref={reasonInput}
							id={`${id}-reason`}
							value={reason}
							maxLength={skillReviewReasonMaxLength}
							placeholder="说明未通过的原因或需要修改的内容"
							disabled={blocked}
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
					{self ? <p className="skill-form-hint">{selfReviewText}</p> : null}
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
						disabled={blocked}
						onClick={() => void submit("reject")}
					>
						驳回
					</Button>
					<Button
						type="button"
						disabled={blocked}
						onClick={() => void submit("approve")}
					>
						批准发布
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
