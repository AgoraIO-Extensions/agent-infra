import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";

export function WecomUnbindDialog({
	disabled,
	label,
	title = "解除企微机器人绑定？",
	onConfirm,
}: {
	disabled?: boolean;
	label: string;
	title?: string;
	onConfirm: () => void;
}) {
	return (
		<ConfirmDialog
			disabled={disabled}
			label={label}
			title={title}
			description="解除后不会删除已有会话和历史记录；新的群消息将停止进入此 Agent。"
			confirmLabel="确认解除"
			triggerVariant="outline"
			variant="destructive"
			onConfirm={onConfirm}
		/>
	);
}
