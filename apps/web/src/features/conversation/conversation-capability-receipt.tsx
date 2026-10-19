import { Button } from "@/components/ui/button";
import { withObjectName } from "@/lib/accessible-name";
import {
	type CapabilityInvocation,
	type CapabilityReceiptPhase,
	capabilityFailedNotice,
	capabilityKindLabel,
	capabilityReceiptLabels,
	capabilityVersionLabel,
} from "./conversation-capability-lifecycle.js";

/**
 * 设计 .cap-receipt：消息流中的命令 / Skill 调用回执，role=status 随该 Execution 的状态
 * 依次为「已受理，尚未开始」→「正在执行」→「已完成」/「调用失败」/「结果待核实」/「已停止」。
 */
export function CapabilityReceipt({
	invocation,
	phase,
	objectName,
	onDetails,
	onVerify,
}: {
	invocation: CapabilityInvocation;
	phase: CapabilityReceiptPhase;
	/** 同页多张回执时区分按钮的对象名（N-12）；默认取命令 / Skill 名称。 */
	objectName?: string;
	onDetails: () => void;
	/** 待核实时只回读原 Execution，不再次调用。 */
	onVerify: () => void;
}) {
	const version = capabilityVersionLabel(invocation.kind, invocation.version);
	return (
		<div className="capability-receipt" data-phase={phase}>
			<strong>
				{[capabilityKindLabel(invocation.kind), invocation.name, version]
					.filter(Boolean)
					.join(" · ")}
			</strong>
			<p className="capability-receipt-text" role="status">
				{capabilityReceiptLabels[phase]}
			</p>
			{phase === "failed" && (
				<p className="capability-receipt-text capability-receipt-error">
					{capabilityFailedNotice}
				</p>
			)}
			{phase === "unknown" && (
				<p className="capability-receipt-text">
					沿原操作核实结果；核实前不会再次执行。
				</p>
			)}
			<div className="capability-receipt-actions">
				<Button
					type="button"
					variant="ghost"
					aria-label={withObjectName("调用详情", objectName ?? invocation.name)}
					onClick={onDetails}
				>
					调用详情
				</Button>
				{phase === "unknown" && (
					<Button
						type="button"
						variant="outline"
						aria-label={withObjectName(
							"核实原操作",
							objectName ?? invocation.name,
						)}
						onClick={onVerify}
					>
						核实原操作
					</Button>
				)}
			</div>
		</div>
	);
}
