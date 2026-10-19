import { ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { connectionNeedsAuthDescription } from "../connection-copy.js";

/**
 * 设计 .connection-notice：Agent 支持 Connection 时的授权提示卡，三态。
 * - needs-auth：有受控入口地址，给 outline「打开 Connection」（新标签页）。
 * - handoff：只在用户本次点击后进入（页面内状态，刷新后回到 needs-auth），提示等待授权返回；
 *   Platform 不读取、不展示 Connection 的授权结果。
 * - unavailable：没有可用入口（capability 不可用、读取失败、会话未就绪或地址未通过校验），
 *   与侧栏「我的 Connection · 不可用」一致，不给链接。
 */
export function ConnectionNotice({ href }: { href: string | undefined }) {
	const [handoff, setHandoff] = useState(false);
	if (!href)
		return (
			<div className="connection-notice" data-state="unavailable">
				<div className="connection-notice-main">
					<span className="connection-notice-icon" aria-hidden="true">
						<KeyRound />
					</span>
					<div className="connection-notice-copy">
						<strong>Connection 暂不可用</strong>
						<p>当前无法打开 Connection 入口，请稍后再试。</p>
					</div>
				</div>
			</div>
		);
	return (
		<div
			className="connection-notice"
			data-state={handoff ? "handoff" : "needs-auth"}
		>
			<div className="connection-notice-main">
				<span className="connection-notice-icon" aria-hidden="true">
					<KeyRound />
				</span>
				{/* 点击后切换为 handoff，标题与说明的变化用 polite 播报。 */}
				<div className="connection-notice-copy" aria-live="polite">
					<strong>
						{handoff ? "等待 Connection 授权返回" : "需要 Connection 授权"}
					</strong>
					<p>
						{handoff
							? "已转到独立 Connection。请在那里选择具体 Action/版本并完成授权，完成后回到此会话继续原请求。"
							: connectionNeedsAuthDescription}
					</p>
					<div className="connection-notice-scope">
						<span>Action 范围</span>
						<strong>在 Connection 中确认</strong>
						<small>按当前主体 / Consumer / Actor 生效</small>
					</div>
				</div>
			</div>
			<div className="connection-notice-action">
				<a
					className={buttonVariants({ variant: "outline" })}
					href={href}
					target="_blank"
					rel="noopener noreferrer"
					onClick={() => setHandoff(true)}
				>
					{handoff ? (
						<RefreshCw aria-hidden="true" />
					) : (
						<ExternalLink aria-hidden="true" />
					)}
					{handoff ? "返回查看授权状态" : "打开 Connection"}
				</a>
			</div>
		</div>
	);
}
