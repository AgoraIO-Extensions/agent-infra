import { FormSection } from "@/components/ui/form-section";
import { WecomAppSetup } from "./wecom-app-setup.js";
import { WecomBotSetup } from "./wecom-bot-setup.js";

export type WecomChannelKind = "wecom_bot" | "wecom_app";

/** 「企微渠道」分区：两张企微卡片并排（≤767px 单列），各自独立绑定与解绑（O-01、O-07）。 */
export function ConfigurationWecomSection({
	agentId,
	onUnbindChannel,
}: {
	agentId: string;
	onUnbindChannel?: (kind: WecomChannelKind) => Promise<void>;
}) {
	return (
		<FormSection title="企微渠道" aria-describedby="wecom-visibility">
			<div className="mt-4 space-y-4">
				<p id="wecom-visibility" className="text-muted-foreground text-sm">
					群消息和 Agent 回复对群成员可见。Agent 可用范围只限制谁能触发
					Agent，不能阻止群成员阅读已有内容；每位发送者的会话上下文仍独立。
				</p>
				<p className="text-muted-foreground text-sm">
					自建应用和智能机器人都可在下方完成绑定，凭证通过受保护的接口提交。
				</p>
			</div>
			<div className="wecom-channel-grid">
				<WecomBotSetup
					key={`${agentId}:wecom_bot`}
					agentId={agentId}
					unbindChannel={
						onUnbindChannel ? () => onUnbindChannel("wecom_bot") : undefined
					}
				/>
				<WecomAppSetup
					key={`${agentId}:wecom_app`}
					agentId={agentId}
					unbindChannel={
						onUnbindChannel ? () => onUnbindChannel("wecom_app") : undefined
					}
				/>
			</div>
		</FormSection>
	);
}
