import {
	AlertTriangle,
	Check,
	Clock3,
	LogIn,
	ShieldCheck,
	UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
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
	capabilityRevision: number;
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
	status:
		| "pending"
		| "confirmed"
		| "rejected"
		| "cancelled"
		| "expired"
		| "unknown";
	expiresAt: string;
	operation: string;
	targetOrigin: string;
	/** Already redacted and bounded by the trusted producer. */
	redactedTargetSummary: string;
	binding: BrowserHandoffBindingV1;
}>;

export type BrowserHandoffActionInputV1 = Readonly<{
	id: string;
	binding: BrowserHandoffBindingV1;
}>;

type BrowserHandoffPanelProps = {
	readonly browserAvailable?: boolean;
	readonly confirmation?: BrowserSideEffectConfirmationV1;
	/** Current server-authenticated binding used to validate every action. */
	readonly currentBinding?: BrowserHandoffBindingV1;
	readonly handoff?: BrowserHandoffPanelStateV1;
	readonly now?: () => number;
	readonly onCancelConfirmation?: (input: BrowserHandoffActionInputV1) => void;
	readonly onConfirmSideEffect?: (input: BrowserHandoffActionInputV1) => void;
	readonly onPauseAgent?: (input: BrowserHandoffActionInputV1) => void;
	readonly onRejectSideEffect?: (input: BrowserHandoffActionInputV1) => void;
	readonly onReturnToAgent?: (input: BrowserHandoffActionInputV1) => void;
	readonly onTakeOver?: (input: BrowserHandoffActionInputV1) => void;
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
			binding.capabilityRevision,
			binding.pageRevision,
		].every((value) => Number.isSafeInteger(value) && value >= 1)
	);
}

function sameBinding(
	left: BrowserHandoffBindingV1,
	right: BrowserHandoffBindingV1,
): boolean {
	return (
		left.subjectId === right.subjectId &&
		left.agentId === right.agentId &&
		left.conversationId === right.conversationId &&
		left.executionId === right.executionId &&
		left.sessionGeneration === right.sessionGeneration &&
		left.resourceFence === right.resourceFence &&
		left.capabilityVersion === right.capabilityVersion &&
		left.capabilityRevision === right.capabilityRevision &&
		left.pageRevision === right.pageRevision
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
	return [...value]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code >= 0x20 && code !== 0x7f;
		})
		.join("")
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

function actionInput(
	id: string,
	binding: BrowserHandoffBindingV1,
): BrowserHandoffActionInputV1 {
	return { id, binding };
}

function useExpiryClock(
	expiresAt: string | undefined,
	active: boolean,
	readNow: () => number,
) {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!active || !expiresAt) return;
		const delay = Date.parse(expiresAt) - readNow();
		if (delay <= 0) {
			setTick((value) => value + 1);
			return;
		}
		const timer = setTimeout(() => setTick((value) => value + 1), delay);
		return () => clearTimeout(timer);
	}, [active, expiresAt, readNow]);
	return tick;
}

function BlockedPanel({ message }: { readonly message: string }) {
	return (
		<Alert
			aria-live="polite"
			aria-atomic="true"
			variant="destructive"
			className="mt-3"
		>
			<AlertTriangle aria-hidden="true" />
			<AlertTitle>Browser 操作已阻断</AlertTitle>
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}

function HandoffPanel({
	browserAvailable = false,
	currentBinding,
	handoff,
	now,
	onPauseAgent,
	onReturnToAgent,
	onTakeOver,
}: Pick<
	BrowserHandoffPanelProps,
	| "browserAvailable"
	| "currentBinding"
	| "handoff"
	| "now"
	| "onPauseAgent"
	| "onReturnToAgent"
	| "onTakeOver"
>) {
	const readNow = now ?? Date.now;
	useExpiryClock(
		handoff?.expiresAt,
		handoff?.status === "requested" || handoff?.status === "active",
		readNow,
	);
	if (!handoff) return null;
	if (!browserAvailable)
		return (
			<BlockedPanel message="Browser Capability 当前不可用，接管操作已阻断。" />
		);
	if (
		!currentBinding ||
		!validBinding(currentBinding) ||
		!isSafeHandoff(handoff) ||
		!sameBinding(handoff.binding, currentBinding)
	)
		return (
			<BlockedPanel message="接管绑定已过期或无法核验，当前不会打开接管操作。" />
		);
	const isExpired =
		(handoff.status === "requested" || handoff.status === "active") &&
		readNow() >= Date.parse(handoff.expiresAt);
	const status = isExpired ? "expired" : handoff.status;
	const terminal = [
		"completed",
		"revoked",
		"expired",
		"crashed",
		"unknown",
	].includes(status);
	const blocked = status === "crashed" || status === "unknown";
	const input = actionInput(handoff.handoffId, currentBinding);
	const invokeIfCurrent = (
		callback: (input: BrowserHandoffActionInputV1) => void,
	) => {
		if (readNow() >= Date.parse(handoff.expiresAt)) return;
		callback(input);
	};
	return (
		<Alert
			aria-live="polite"
			aria-atomic="true"
			variant={blocked ? "destructive" : "default"}
			className="mt-3"
		>
			{blocked ? (
				<AlertTriangle aria-hidden="true" />
			) : status === "requested" ? (
				<LogIn aria-hidden="true" />
			) : status === "active" ? (
				<UserRound aria-hidden="true" />
			) : (
				<Clock3 aria-hidden="true" />
			)}
			<AlertTitle>浏览器接管 · {handoffLabels[status]}</AlertTitle>
			<AlertDescription>
				<span className="block">
					原因：{reasonLabels[handoff.reason]}。Agent、Session
					和授权绑定由服务端维护。
				</span>
				<span className="mt-1 block text-muted-foreground">
					页面版本：{currentBinding.pageRevision}
				</span>
				{handoff.terminalReasonCode ? (
					<span className="mt-1 block text-muted-foreground">
						已记录受控终止原因：
						{handoff.terminalReasonCode.replaceAll("BROWSER_HANDOFF_", "")}。
					</span>
				) : null}
				{status === "requested" ? (
					<div className="mt-3 flex flex-col gap-2 sm:flex-row">
						{onPauseAgent ? (
							<Button
								onClick={() => invokeIfCurrent(onPauseAgent)}
								type="button"
							>
								暂停 Agent
							</Button>
						) : null}
						{onTakeOver ? (
							<Button
								variant="outline"
								onClick={() => invokeIfCurrent(onTakeOver)}
								type="button"
							>
								接管浏览器
							</Button>
						) : null}
					</div>
				) : null}
				{status === "active" && onReturnToAgent ? (
					<Button
						className="mt-3"
						variant="outline"
						onClick={() => invokeIfCurrent(onReturnToAgent)}
						type="button"
					>
						交回 Agent
					</Button>
				) : null}
				{status === "returning" ? (
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
	browserAvailable = false,
	confirmation,
	currentBinding,
	handoff,
	now,
	onCancelConfirmation,
	onConfirmSideEffect,
	onRejectSideEffect,
}: Pick<
	BrowserHandoffPanelProps,
	| "browserAvailable"
	| "confirmation"
	| "currentBinding"
	| "handoff"
	| "now"
	| "onCancelConfirmation"
	| "onConfirmSideEffect"
	| "onRejectSideEffect"
>) {
	if (!confirmation) return null;
	if (
		!currentBinding ||
		!validBinding(currentBinding) ||
		!validBinding(confirmation.binding) ||
		!sameBinding(confirmation.binding, currentBinding)
	)
		return (
			<BlockedPanel message="确认绑定已过期或无法核验，当前不会执行外部副作用。" />
		);
	const readNow = now ?? Date.now;
	useExpiryClock(
		confirmation.expiresAt,
		confirmation.status === "pending",
		readNow,
	);
	const handoffInvalid = handoff !== undefined && !isSafeHandoff(handoff);
	const handoffBlocked =
		handoffInvalid ||
		(handoff !== undefined &&
			[
				"requested",
				"active",
				"returning",
				"revoked",
				"expired",
				"crashed",
				"unknown",
			].includes(handoff.status));
	const handoffExpired =
		handoff !== undefined &&
		(handoff.status === "requested" || handoff.status === "active") &&
		readNow() >= Date.parse(handoff.expiresAt);
	const origin = safeOrigin(confirmation.targetOrigin);
	const summary = boundedSummary(confirmation.redactedTargetSummary);
	if (!origin)
		return (
			<BlockedPanel message="确认目标 origin 无法核验，当前不会执行外部副作用。" />
		);
	if (!summary)
		return <BlockedPanel message="确认摘要为空，当前不会执行外部副作用。" />;
	if (!confirmation.confirmationId)
		return (
			<BlockedPanel message="确认请求缺少有效 ID，当前不会执行外部副作用。" />
		);
	const confirmationExpired = readNow() >= Date.parse(confirmation.expiresAt);
	const blockedByBinding =
		!browserAvailable ||
		handoffBlocked ||
		handoffExpired ||
		confirmationExpired;
	const terminal = confirmation.status !== "pending";
	const blocked = confirmation.status === "unknown" || blockedByBinding;
	const input = actionInput(confirmation.confirmationId, currentBinding);
	const invokeIfCurrent = (
		callback: (input: BrowserHandoffActionInputV1) => void,
	) => {
		if (readNow() >= Date.parse(confirmation.expiresAt)) return;
		callback(input);
	};
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
					<dt className="text-muted-foreground">页面版本</dt>
					<dd>{currentBinding.pageRevision}</dd>
					<dt className="text-muted-foreground">摘要</dt>
					<dd>{summary}</dd>
				</dl>
				<p className="mt-2 text-muted-foreground text-xs">
					密码、MFA、Cookie、页面正文和浏览器 URL 不会显示在此确认框中。
				</p>
				{blocked ? (
					<p className="mt-2">
						{blockedByBinding
							? "当前 Browser 或接管授权不可用，系统不会执行此副作用。"
							: "结果无法确认，系统不会自动重放。"}
					</p>
				) : null}
				{confirmation.status === "pending" && !blockedByBinding ? (
					<div className="mt-3 flex flex-col gap-2 sm:flex-row">
						{onConfirmSideEffect ? (
							<Button
								onClick={() => invokeIfCurrent(onConfirmSideEffect)}
								type="button"
							>
								确认执行
							</Button>
						) : null}
						{onRejectSideEffect ? (
							<Button
								variant="outline"
								onClick={() => invokeIfCurrent(onRejectSideEffect)}
								type="button"
							>
								拒绝
							</Button>
						) : null}
						{onCancelConfirmation ? (
							<Button
								variant="ghost"
								onClick={() => invokeIfCurrent(onCancelConfirmation)}
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
				browserAvailable={props.browserAvailable}
				currentBinding={props.currentBinding}
				handoff={props.handoff}
				now={props.now}
				onPauseAgent={props.onPauseAgent}
				onReturnToAgent={props.onReturnToAgent}
				onTakeOver={props.onTakeOver}
			/>
			<ConfirmationPanel
				browserAvailable={props.browserAvailable}
				confirmation={props.confirmation}
				currentBinding={props.currentBinding}
				handoff={props.handoff}
				now={props.now}
				onCancelConfirmation={props.onCancelConfirmation}
				onConfirmSideEffect={props.onConfirmSideEffect}
				onRejectSideEffect={props.onRejectSideEffect}
			/>
		</>
	);
}
