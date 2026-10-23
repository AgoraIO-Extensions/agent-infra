import type { LucideIcon } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useRef,
	useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import type { ChipTone } from "@/lib/status-tone";

export type WecomChannelStatus =
	| "not_configured"
	| "callback"
	| "verifying"
	| "connected"
	| "disconnected"
	| "auth_failed";

// 设计稿 wecomStatusLabels。
export const wecomStatusLabels = {
	not_configured: "未配置",
	callback: "回调已配置",
	verifying: "验证中",
	connected: "已连接",
	disconnected: "已断开",
	auth_failed: "认证失败",
} satisfies Record<WecomChannelStatus, string>;

// 设计稿 wecomTone：connected 绿、verifying / callback 琥珀、auth_failed 红，其余灰。
function wecomStatusTone(status?: WecomChannelStatus): ChipTone {
	if (status === "connected") return "green";
	if (status === "verifying" || status === "callback") return "amber";
	if (status === "auth_failed") return "red";
	return "gray";
}

/**
 * 企微卡片外壳（O-07）：图标、标题、副标题与状态 chip；状态决定卡片边框色。
 * 卡片留在整页表单的 fieldset 内以继承整体禁用；卡内输入框按 Enter 不提交整页（O-09）。
 */
export function WecomChannelCard({
	children,
	icon: Icon,
	status,
	subtitle,
	title,
	titleId,
	titleRef,
}: {
	children: ReactNode;
	icon: LucideIcon;
	status?: WecomChannelStatus;
	subtitle: string;
	title: string;
	titleId: string;
	titleRef: RefObject<HTMLHeadingElement | null>;
}) {
	const preventImplicitSubmit = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "Enter" && event.target instanceof HTMLInputElement)
			event.preventDefault();
	};
	return (
		<section
			aria-labelledby={titleId}
			className="wecom-channel-card"
			data-status={status ?? "unknown"}
			onKeyDown={preventImplicitSubmit}
		>
			<div className="wecom-channel-head">
				<div className="wecom-channel-title">
					<span aria-hidden="true" className="wecom-channel-icon">
						<Icon className="size-[17px]" />
					</span>
					<div className="min-w-0">
						<h3 id={titleId} ref={titleRef} tabIndex={-1}>
							{title}
						</h3>
						<p>{subtitle}</p>
					</div>
				</div>
				{/* flex：包裹层不再形成行盒，chip 与卡头顶对齐，不按基线下移（B2-04）。 */}
				<span aria-live="polite" className="flex">
					<Badge tone={wecomStatusTone(status)}>
						{status ? wecomStatusLabels[status] : "连接状态暂不可用"}
					</Badge>
				</span>
			</div>
			{children}
		</section>
	);
}

/**
 * 卡片内的校验与验证错误（设计 p.wecom-channel-error[role=alert]，#3268 N8-2-10）：单行 12px 红字，
 * 无边框、无图标，距上方内容 10px。借公共 FieldError 的 role="alert" 段落，颜色、行高与上距按
 * 设计由 index.css `.wecom-channel-error` 覆盖（不分层的样式优先于 Tailwind 工具类）。
 */
export function WecomChannelError({ children }: { children: ReactNode }) {
	return <FieldError className="wecom-channel-error">{children}</FieldError>;
}

/**
 * 解除绑定（O-01）：先弹确认，确认后走独立的配置请求（只含该渠道 disabled），
 * 不经过整页保存；成功后由卡片刷新状态并给出 Toast，失败只在卡内提示。
 */
export function useWecomUnbind({
	onUnbound,
	title,
	unbindChannel,
}: {
	onUnbound: () => void;
	title: string;
	unbindChannel?: () => Promise<void>;
}) {
	const toast = useToast();
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);
	const current = useRef(0);
	return {
		available: unbindChannel !== undefined,
		failed,
		pending,
		run: async () => {
			if (!unbindChannel || pending) return;
			const attempt = ++current.current;
			setPending(true);
			setFailed(false);
			try {
				await unbindChannel();
				if (attempt !== current.current) return;
				setPending(false);
				onUnbound();
				toast(`${title}已解除绑定`);
			} catch {
				if (attempt !== current.current) return;
				setPending(false);
				setFailed(true);
			}
		},
	};
}

export function WecomUnbindAction({
	disabled,
	kind,
	title,
	titleRef,
	unbind,
}: {
	disabled: boolean;
	kind: "bot" | "app";
	title: string;
	titleRef: RefObject<HTMLHeadingElement | null>;
	unbind: ReturnType<typeof useWecomUnbind>;
}) {
	const confirmed = useRef(false);
	const label = unbind.pending ? "正在解除…" : "解除绑定";
	return (
		<ConfirmDialog
			disabled={disabled || unbind.pending}
			trigger={
				<Button variant="ghost" aria-label={withObjectName(label, title)}>
					{label}
				</Button>
			}
			title={kind === "bot" ? "解除企微机器人绑定？" : "解除企微应用绑定？"}
			description="解除后平台停止向该入口投递新消息；已有会话和历史保留。"
			confirmLabel="确认解除"
			tone="danger"
			onOpenChange={(open) => {
				if (open) confirmed.current = false;
			}}
			// 确认后触发按钮会随状态消失，焦点交给卡片标题；取消时回到触发按钮。
			finalFocus={() => (confirmed.current ? titleRef.current : true)}
			onConfirm={() => {
				confirmed.current = true;
				void unbind.run();
			}}
		/>
	);
}

export function WecomUnbindFailure({
	unbind,
}: {
	unbind: ReturnType<typeof useWecomUnbind>;
}) {
	return unbind.failed ? (
		<WecomChannelError>解除绑定未完成，请重试。</WecomChannelError>
	) : null;
}
