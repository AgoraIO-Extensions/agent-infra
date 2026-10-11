import {
	AlertTriangle,
	Check,
	Clock3,
	LogIn,
	ShieldCheck,
	UserRound,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export type BrowserHandoffReasonV1 =
	| "login"
	| "mfa"
	| "captcha"
	| "human_judgment";

export type BrowserHandoffBindingV1 = Readonly<{
	subjectId: string;
	agentId: string;
	conversationId: string;
	executionId: string;
	sessionGeneration: number;
	resourceFence: number;
	capabilityVersion: number;
	pageRevision: number;
}>;

export type BrowserHandoffPanelStateV1 = Readonly<{
	handoffId: string;
	status:
		| "requested"
		| "active"
		| "returning"
		| "completed"
		| "revoked"
		| "expired"
		| "crashed"
		| "unknown";
	reason: BrowserHandoffReasonV1;
	expiresAt: string;
	binding: BrowserHandoffBindingV1;
	terminalReasonCode?:
		| "BROWSER_HANDOFF_EXPIRED"
		| "BROWSER_HANDOFF_BROWSER_CRASHED"
		| "BROWSER_HANDOFF_AUTHORIZATION_REVOKED"
		| "BROWSER_HANDOFF_OPERATOR_CHANGED"
		| "BROWSER_HANDOFF_RETURN_UNCONFIRMED";
}>;

export type BrowserSideEffectConfirmationV1 = Readonly<{
	confirmationId: string;
	status: "pending" | "confirmed" | "rejected" | "cancelled" | "unknown";
	operation: string;
	targetOrigin: string;
	/** Already redacted and bounded by the trusted producer. */
	redactedTargetSummary: string;
	binding: BrowserHandoffBindingV1;
}>;

type BrowserHandoffPanelProps = {
	readonly confirmation?: BrowserSideEffectConfirmationV1;
	readonly handoff?: BrowserHandoffPanelStateV1;
	readonly onCancelConfirmation?: (confirmationId: string) => void;
	readonly onConfirmSideEffect?: (confirmationId: string) => void;
	readonly onRejectSideEffect?: (confirmationId: string) => void;
	readonly onReturnToAgent?: (handoffId: string) => void;
	readonly onTakeOver?: (handoffId: string) => void;
};

const reasonLabels: Record<BrowserHandoffReasonV1, string> = {
	login: "登录",
	mfa: "MFA 验证",
	captcha: "CAPTCHA 验证",
	human_judgment: "需要人工判断",
};

const handoffLabels: Record<BrowserHandoffPanelStateV1["status"], string> = {
	requested: "等待接管",
	active: "用户已接管",
	returning: "正在交回 Agent",
	completed: "已交回 Agent",
	revoked: "已撤销",
	expired: "已过期",
	crashed: "浏览器已崩溃",
	unknown: "状态待核实",
};

function validBinding(binding: BrowserHandoffBindingV1): boolean {
	return (
		!!binding &&
		[
			binding.subjectId,
			binding.agentId,
			binding.conversationId,
			binding.executionId,
		].every((value) => typeof value === "string" && value.length > 0) &&
		[
			binding.sessionGeneration,
			binding.resourceFence,
			binding.capabilityVersion,
			binding.pageRevision,
		].every((value) => Number.isSafeInteger(value) && value >= 1)
	);
}

function safeOrigin(value: string): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

function boundedSummary(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.trim()
		.slice(0, 160);
}

function isSafeHandoff(state: BrowserHandoffPanelStateV1): boolean {
	return (
		typeof state.handoffId === "string" &&
		state.handoffId.length > 0 &&
		Object.hasOwn(handoffLabels, state.status) &&
		Object.hasOwn(reasonLabels, state.reason) &&
		Number.isFinite(Date.parse(state.expiresAt)) &&
		validBinding(state.binding)
	);
}

function HandoffPanel({
	handoff,
	onReturnToAgent,
	onTakeOver,
}: Pick<
	BrowserHandoffPanelProps,
	"handoff" | "onReturnToAgent" | "onTakeOver"
>) {
	if (!handoff || !isSafeHandoff(handoff)) return null;
	const terminal = [
		"completed",
		"revoked",
		"expired",
		"crashed",
		"unknown",
	].includes(handoff.status);
	const blocked = handoff.status === "crashed" || handoff.status === "unknown";
	return (
		<Alert
			aria-live="polite"
			aria-atomic="true"
			variant={blocked ? "destructive" : "default"}
			className="mt-3"
		>
			{blocked ? (
				<AlertTriangle aria-hidden="true" />
			) : handoff.status === "requested" ? (
				<LogIn aria-hidden="true" />
			) : handoff.status === "active" ? (
				<UserRound aria-hidden="true" />
			) : (
				<Clock3 aria-hidden="true" />
			)}
			<AlertTitle>浏览器接管 · {handoffLabels[handoff.status]}</AlertTitle>
			<AlertDescription>
				<span className="block">
					原因：{reasonLabels[handoff.reason]}。Agent、Session
					和授权绑定由服务端维护。
				</span>
				{handoff.terminalReasonCode ? (
					<span className="mt-1 block text-muted-foreground">
						已记录受控终止原因：
						{handoff.terminalReasonCode.replaceAll("BROWSER_HANDOFF_", "")}。
					</span>
				) : null}
				{handoff.status === "requested" && onTakeOver ? (
					<Button
						className="mt-3"
						onClick={() => onTakeOver(handoff.handoffId)}
						type="button"
					>
						接管浏览器
					</Button>
				) : null}
				{handoff.status === "active" && onReturnToAgent ? (
					<Button
						className="mt-3"
						variant="outline"
						onClick={() => onReturnToAgent(handoff.handoffId)}
						type="button"
					>
						交回 Agent
					</Button>
				) : null}
				{handoff.status === "returning" ? (
					<span className="mt-2 block text-muted-foreground">
						正在重新校验页面、Session 和授权状态。
					</span>
				) : null}
				{terminal && !blocked ? (
					<span className="mt-2 block text-muted-foreground">
						本次接管已经结束，不能重复使用原请求。
					</span>
				) : null}
			</AlertDescription>
		</Alert>
	);
}

function ConfirmationPanel({
	confirmation,
	onCancelConfirmation,
	onConfirmSideEffect,
	onRejectSideEffect,
}: Pick<
	BrowserHandoffPanelProps,
	| "confirmation"
	| "onCancelConfirmation"
	| "onConfirmSideEffect"
	| "onRejectSideEffect"
>) {
	if (!confirmation || !validBinding(confirmation.binding)) return null;
	const origin = safeOrigin(confirmation.targetOrigin);
	const summary = boundedSummary(confirmation.redactedTargetSummary);
	if (!origin || !summary || !confirmation.confirmationId) return null;
	const terminal = confirmation.status !== "pending";
	const blocked = confirmation.status === "unknown";
	return (
		<Alert
			aria-live="polite"
			aria-atomic="true"
			variant={blocked ? "destructive" : "default"}
			className="mt-3"
		>
			{blocked ? (
				<AlertTriangle aria-hidden="true" />
			) : confirmation.status === "pending" ? (
				<ShieldCheck aria-hidden="true" />
			) : (
				<Check aria-hidden="true" />
			)}
			<AlertTitle>
				外部副作用确认 · {terminal ? "已结束" : "等待当前主体确认"}
			</AlertTitle>
			<AlertDescription>
				<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
					<dt className="text-muted-foreground">操作</dt>
					<dd>{boundedSummary(confirmation.operation)}</dd>
					<dt className="text-muted-foreground">目标 origin</dt>
					<dd>{origin}</dd>
					<dt className="text-muted-foreground">摘要</dt>
					<dd>{summary}</dd>
				</dl>
				<p className="mt-2 text-muted-foreground text-xs">
					密码、MFA、Cookie、页面正文和浏览器 URL 不会显示在此确认框中。
				</p>
				{blocked ? (
					<p className="mt-2">结果无法确认，系统不会自动重放。</p>
				) : null}
				{confirmation.status === "pending" ? (
					<div className="mt-3 flex flex-wrap gap-2">
						{onConfirmSideEffect ? (
							<Button
								onClick={() => onConfirmSideEffect(confirmation.confirmationId)}
								type="button"
							>
								确认执行
							</Button>
						) : null}
						{onRejectSideEffect ? (
							<Button
								variant="outline"
								onClick={() => onRejectSideEffect(confirmation.confirmationId)}
								type="button"
							>
								拒绝
							</Button>
						) : null}
						{onCancelConfirmation ? (
							<Button
								variant="ghost"
								onClick={() =>
									onCancelConfirmation(confirmation.confirmationId)
								}
								type="button"
							>
								取消
							</Button>
						) : null}
					</div>
				) : null}
			</AlertDescription>
		</Alert>
	);
}

export function BrowserHandoffPanel(props: BrowserHandoffPanelProps) {
	return (
		<>
			<HandoffPanel
				handoff={props.handoff}
				onReturnToAgent={props.onReturnToAgent}
				onTakeOver={props.onTakeOver}
			/>
			<ConfirmationPanel
				confirmation={props.confirmation}
				onCancelConfirmation={props.onCancelConfirmation}
				onConfirmSideEffect={props.onConfirmSideEffect}
				onRejectSideEffect={props.onRejectSideEffect}
			/>
		</>
	);
}
