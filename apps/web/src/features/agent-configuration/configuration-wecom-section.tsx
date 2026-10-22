import { FormSection } from "@/components/ui/form-section";
import { WecomAppSetup } from "./wecom-app-setup.js";
import { WecomBotSetup } from "./wecom-bot-setup.js";

export type WecomChannelKind = "wecom_bot" | "wecom_app";

/**
 * 「渠道」分区（设计 #owner-config，W-17）：标题与说明按导出稿，两张企微卡片并排
 * （≤767px 单列），各自独立绑定与解绑（O-01、O-07）。Web 对话对标准模板始终可用，
 * 不提供勾选（PRD §10.2）。
 */
export function ConfigurationWecomSection({
	agentId,
	disabled = false,
	onUnbindChannel,
}: {
	agentId: string;
	/** 整页表单禁用（提交中或 Agent 已停用），传给卡片内不受 fieldset 影响的复选框。 */
	disabled?: boolean;
	onUnbindChannel?: (kind: WecomChannelKind) => Promise<void>;
}) {
	return (
		<FormSection
			title="渠道"
			description="Web 对话默认可用；企微入口需要分别绑定，状态会在这里更新。"
			aria-describedby="wecom-visibility"
		>
			{/* PRD §10.3：Owner 绑定群聊时必须看到群内可见性提示（W-17，已回写导出稿）。 */}
			<p id="wecom-visibility" className="wecom-visibility-note">
				群消息和 Agent 回复对群成员可见。Agent 可用范围只限制谁能触发
				Agent，不能阻止群成员阅读已有内容；每位发送者的会话上下文仍独立。
			</p>
			<div className="wecom-channel-grid">
				<WecomBotSetup
					key={`${agentId}:wecom_bot`}
					agentId={agentId}
					disabled={disabled}
					unbindChannel={
						onUnbindChannel ? () => onUnbindChannel("wecom_bot") : undefined
					}
				/>
				<WecomAppSetup
					key={`${agentId}:wecom_app`}
					agentId={agentId}
					disabled={disabled}
					unbindChannel={
						onUnbindChannel ? () => onUnbindChannel("wecom_app") : undefined
					}
				/>
			</div>
		</FormSection>
	);
}
