import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "../../components/ui/button.js";
import type { ConversationCommandResult } from "./conversation-commands.js";
import { commandFailure } from "./conversation-screen-state.js";

export function CommandNotice({
	result,
	pending,
	retry,
}: {
	result?: ConversationCommandResult;
	pending: boolean;
	retry?: () => void;
}) {
	if (pending) return <p role="status">正在提交，请勿重复操作…</p>;
	if (result?.kind === "unknown")
		return (
			<Alert className="space-y-2 bg-muted">
				<AlertDescription>
					提交结果尚未确认。原请求可能已受理，请核实原请求，避免重复创建回复。
				</AlertDescription>
				{retry && (
					<Button variant="outline" onClick={retry}>
						核实原请求
					</Button>
				)}
			</Alert>
		);
	if (result?.kind === "rejected")
		return (
			<Alert variant="destructive" className="space-y-2">
				<AlertDescription>{commandFailure(result.code)}</AlertDescription>
				{retry && (
					<Button variant="outline" onClick={retry}>
						重试原请求
					</Button>
				)}
			</Alert>
		);
	return null;
}
