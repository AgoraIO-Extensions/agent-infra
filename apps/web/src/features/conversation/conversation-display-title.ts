/** 会话标题的唯一回落规则：服务端尚未生成标题（null、空串或全空白）时统一显示「未命名对话」。 */
export const untitledConversation = "未命名对话";

export function conversationDisplayTitle(title: string | null | undefined) {
	const trimmed = title?.trim();
	return trimmed ? trimmed : untitledConversation;
}
