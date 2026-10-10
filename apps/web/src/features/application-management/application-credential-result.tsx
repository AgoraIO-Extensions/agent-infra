import { useId } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { personalApiCredentialScopeLabels } from "../api-credentials/api-credentials.js";
import type { ApplicationCredentialResponse } from "./application-management.js";

const deliveryLabels: Record<
	ApplicationCredentialResponse["delivery"]["status"],
	string
> = {
	delivery_pending: "等待投递",
	delivery_in_flight: "投递中",
	accepted: "投递通道已接收",
	failed: "投递失败",
	unknown: "投递结果未知",
};

function dateLabel(value: string | null, empty: string) {
	return value ? new Date(value).toLocaleString("zh-CN") : empty;
}

export function ApplicationCredentialResult({
	result,
	onPrepareRotation,
}: {
	result: ApplicationCredentialResponse;
	onPrepareRotation?: () => void;
}) {
	const headingId = useId();
	const { metadata, delivery } = result;
	return (
		<section
			aria-labelledby={headingId}
			className="space-y-4 rounded border bg-card p-5"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 id={headingId} className="font-semibold text-base">
					应用凭证结果
				</h2>
				<Badge
					variant="outline"
					data-status={
						delivery.status === "accepted"
							? "available"
							: delivery.status === "failed"
								? "disabled"
								: "pending"
					}
				>
					{deliveryLabels[delivery.status]}
				</Badge>
			</div>
			<p role="status" className="text-muted-foreground text-sm">
				{result.replayed
					? "当前展示原请求的回执，未再次签发。"
					: "凭证元数据已保存。"}{" "}
				凭证材料通过受控通道投递，管理页面不会显示凭证值。
			</p>
			{delivery.status === "unknown" || delivery.status === "failed" ? (
				<Alert
					variant={delivery.status === "failed" ? "destructive" : "default"}
				>
					<AlertDescription>
						{delivery.status === "unknown"
							? "无法确认材料是否已投递，请联系管理员核实原投递结果。"
							: "材料投递失败，请联系管理员核实接收者授权和投递通道。"}{" "}
						页面不会自动重发；轮换须由你明确提交。
					</AlertDescription>
				</Alert>
			) : null}
			<dl className="grid gap-4 text-sm sm:grid-cols-2 [&_dd]:mt-1 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-muted-foreground">
				<div>
					<dt>凭证 ID</dt>
					<dd>
						<code>{metadata.credentialId}</code>
					</dd>
				</div>
				<div>
					<dt>所属应用 ID</dt>
					<dd>
						<code>{metadata.applicationId}</code>
					</dd>
				</div>
				<div>
					<dt>权限范围</dt>
					<dd>
						{metadata.scopes
							.map((scope) => personalApiCredentialScopeLabels[scope])
							.join("、")}
					</dd>
				</div>
				<div>
					<dt>过期时间</dt>
					<dd>{dateLabel(metadata.expiresAt, "无到期时间")}</dd>
				</div>
				<div>
					<dt>签发时间</dt>
					<dd>{dateLabel(metadata.createdAt, "未提供")}</dd>
				</div>
				<div>
					<dt>最近使用</dt>
					<dd>{dateLabel(metadata.lastUsedAt, "尚未使用")}</dd>
				</div>
				<div>
					<dt>撤销时间</dt>
					<dd>{dateLabel(metadata.revokedAt, "未撤销")}</dd>
				</div>
				<div>
					<dt>接收者</dt>
					<dd>
						{delivery.recipient.principalType === "user" ? "用户" : "应用"} ·{" "}
						<code>{delivery.recipient.principalId}</code>
					</dd>
				</div>
				<div>
					<dt>投递记录 ID</dt>
					<dd>
						<code>{delivery.attemptId}</code>
					</dd>
				</div>
				<div>
					<dt>材料授权版本</dt>
					<dd>
						<code>{delivery.grantRevision}</code>
					</dd>
				</div>
			</dl>
			{onPrepareRotation && !metadata.revokedAt ? (
				<Button type="button" variant="outline" onClick={onPrepareRotation}>
					使用此凭证 ID 轮换
				</Button>
			) : null}
		</section>
	);
}
