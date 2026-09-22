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
			<div role="alert" className="space-y-2 border border-border bg-muted p-3">
				<p>
					提交结果尚未确认。原请求可能已受理，请核实原请求，避免重复创建回复。
				</p>
				{retry && (
					<Button variant="outline" onClick={retry}>
						核实原请求
					</Button>
				)}
			</div>
		);
	if (result?.kind === "rejected")
		return (
			<div role="alert" className="space-y-2">
				<p>{commandFailure(result.code)}</p>
				{retry && (
					<Button variant="outline" onClick={retry}>
						重试原请求
					</Button>
				)}
			</div>
		);
	return null;
}
