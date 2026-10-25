import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * 最近对话按 Agent 降级（#3379）：服务端无法确认渠道资格的 Agent 的对话不列出，
 * 只说明受影响的 Agent 数量；其余对话照常显示，不当作整个列表读取失败。
 */
export function RecentUnavailableAgentsNotice({
	agentIds,
	className,
}: {
	agentIds: readonly string[] | undefined;
	className?: string;
}) {
	if (!agentIds || agentIds.length === 0) return null;
	return (
		<Alert tone="warn" role="status" className={className}>
			<AlertDescription>
				{agentIds.length} 个 Agent 的对话暂时无法显示，其他对话不受影响。
			</AlertDescription>
		</Alert>
	);
}
