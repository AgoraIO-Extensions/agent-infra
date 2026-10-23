import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLegend } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { withObjectName } from "@/lib/accessible-name";
import {
	AgentAuthorizationRequestError,
	grantApplicationManager,
	grantApplicationUse,
	grantUserApiManage,
	grantUserApiUse,
	revokeApplicationManager,
	revokeApplicationUse,
	revokeUserApiManage,
	revokeUserApiUse,
} from "./agent-authorization.js";

type TargetKind = "application" | "user";
type Permission = "manage" | "use" | "api-use" | "api-manage";
type Metadata = {
	authorizationRevision: string | null;
	granted: boolean;
	replayed: boolean;
};

function errorMessage(error: unknown, userTarget: boolean) {
	if (error instanceof AgentAuthorizationRequestError && error.status === 403)
		return "服务端拒绝了此次授权操作，请确认当前 Owner 或管理员权限。";
	if (error instanceof AgentAuthorizationRequestError && error.status === 409)
		return "授权版本已变化，请刷新页面后重试。";
	// 用户 API 授权按 Agent 管理修订号校验，过期时服务端返回 404；页面已重新读取详情（#3070）。
	if (
		userTarget &&
		error instanceof AgentAuthorizationRequestError &&
		error.status === 404
	)
		return "Agent 管理状态已变化或目标不可用，页面已重新读取，请确认后重试。";
	return "操作未确认，请刷新页面后重试。未显示上游错误详情。";
}

export function AgentAuthorizationControls({
	agentId,
	enabled,
	managementRevision,
	onChanged,
}: {
	agentId: string;
	enabled: boolean;
	/** Owner 读到的 Agent 当前管理修订号；用户 API 授权以它作为 expectedRevision（#3070）。 */
	managementRevision?: number;
	/** 用户 API 授权完成或被拒绝后，重新读取 Agent 详情以取得最新修订号。 */
	onChanged?: () => void;
}) {
	const [targetKind, setTargetKind] = useState<TargetKind>("application");
	const [targetId, setTargetId] = useState("");
	const [busy, setBusy] = useState(false);
	const [metadata, setMetadata] = useState<Metadata>();
	const [message, setMessage] = useState("");
	const [failed, setFailed] = useState(false);

	if (!enabled) return null;

	const target = targetId.trim();
	const revision = managementRevision;
	const validRevision =
		revision !== undefined && Number.isSafeInteger(revision) && revision >= 0;

	async function run(permission: Permission, revoke: boolean) {
		if (busy || !target) return;
		const userTarget = targetKind === "user";
		if (
			userTarget &&
			((permission !== "api-use" && permission !== "api-manage") ||
				revision === undefined ||
				!validRevision)
		)
			return;
		setBusy(true);
		setMessage("");
		setFailed(false);
		try {
			const result =
				userTarget && revision !== undefined
					? permission === "api-manage"
						? revoke
							? await revokeUserApiManage(agentId, target, revision)
							: await grantUserApiManage(agentId, target, revision)
						: revoke
							? await revokeUserApiUse(agentId, target, revision)
							: await grantUserApiUse(agentId, target, revision)
					: permission === "manage"
						? revoke
							? await revokeApplicationManager(agentId, target)
							: await grantApplicationManager(agentId, target)
						: revoke
							? await revokeApplicationUse(agentId, target)
							: await grantApplicationUse(agentId, target);
			setMetadata({
				authorizationRevision: result.authorizationRevision,
				granted: result.granted,
				replayed: result.replayed,
			});
			setMessage(
				result.replayed
					? "操作已幂等重放，服务端返回了原授权结果。"
					: revoke
						? "撤销结果已由服务端确认。"
						: "授权结果已由服务端确认。",
			);
		} catch (error) {
			setMetadata(undefined);
			setFailed(true);
			setMessage(errorMessage(error, userTarget));
		} finally {
			setBusy(false);
			// 修订号可能已随管理操作前进：无论成功与否都重新读取详情，下一次提交用最新值。
			if (userTarget) onChanged?.();
		}
	}

	return (
		// 位于配置卡片顶部、共同 Owner 分区之前；与后面分区之间只有后者的一条上边线（O-03）。
		<FormSection
			title="Agent 授权控制"
			description="填写需要授权的用户或应用标识；提交时平台会重新检查当前权限。页面不显示凭证。"
		>
			<div className="mt-4 space-y-4">
				<div className="grid gap-3 sm:grid-cols-2">
					<fieldset className="space-y-2">
						<FieldLegend>目标类型</FieldLegend>
						<div className="flex flex-wrap gap-2">
							{(
								[
									["application", "应用"],
									["user", "用户"],
								] as const
							).map(([kind, label]) => (
								<Button
									aria-pressed={targetKind === kind}
									key={kind}
									type="button"
									variant={targetKind === kind ? "default" : "outline"}
									disabled={busy}
									onClick={() => {
										setTargetKind(kind);
										setMetadata(undefined);
										setMessage("");
									}}
								>
									{label}
								</Button>
							))}
						</div>
					</fieldset>
					<Field>
						<Label htmlFor="agent-authorization-target-id">
							{targetKind === "application" ? "应用 ID" : "用户 ID"}
						</Label>
						{/* 与企微自建应用的「应用 ID」同页，名称带分区标题以便区分（N-12）。 */}
						<Input
							id="agent-authorization-target-id"
							aria-label={withObjectName(
								targetKind === "application" ? "应用 ID" : "用户 ID",
								"Agent 授权控制",
							)}
							disabled={busy}
							value={targetId}
							onChange={(event) => {
								setTargetId(event.target.value);
								setMetadata(undefined);
								setMessage("");
							}}
						/>
					</Field>
				</div>
				{targetKind === "user" ? (
					<p
						className="text-muted-foreground text-xs"
						role={validRevision ? undefined : "status"}
					>
						{validRevision
							? "API 使用权与 API 管理权分别授予和撤销，可以授权自己；提交时平台会核对 Agent 当前的管理修订号。"
							: "未能读取 Agent 管理修订号，暂不能授予或撤销用户 API 授权。请刷新页面后重试。"}
					</p>
				) : null}
				{/* 授权与撤销都用 outline：页面唯一的主按钮是页脚保存，未填写目标时不出现浅蓝实心禁用按钮（O-12）。
				    提交进行中是可聚焦的禁用（aria-disabled），焦点留在触发的按钮上（#3242 K7-02）。 */}
				{targetKind === "application" ? (
					<div className="flex flex-wrap gap-3">
						<Button
							variant="outline"
							disabled={busy || !target}
							focusableWhenDisabled={busy}
							onClick={() => void run("manage", false)}
						>
							授权管理
						</Button>
						<Button
							variant="outline"
							disabled={busy || !target}
							focusableWhenDisabled={busy}
							onClick={() => void run("manage", true)}
						>
							撤销管理
						</Button>
						<Button
							variant="outline"
							disabled={busy || !target}
							focusableWhenDisabled={busy}
							onClick={() => void run("use", false)}
						>
							授权使用
						</Button>
						<Button
							variant="outline"
							disabled={busy || !target}
							focusableWhenDisabled={busy}
							onClick={() => void run("use", true)}
						>
							撤销使用
						</Button>
					</div>
				) : (
					<div className="flex flex-wrap gap-3">
						<Button
							variant="outline"
							disabled={busy || !target || !validRevision}
							focusableWhenDisabled={busy}
							onClick={() => void run("api-use", false)}
						>
							授权用户 API 使用
						</Button>
						<Button
							variant="outline"
							disabled={busy || !target || !validRevision}
							focusableWhenDisabled={busy}
							onClick={() => void run("api-use", true)}
						>
							撤销用户 API 使用
						</Button>
						<Button
							variant="outline"
							disabled={busy || !target || !validRevision}
							focusableWhenDisabled={busy}
							onClick={() => void run("api-manage", false)}
						>
							授权用户 API 管理
						</Button>
						<Button
							variant="outline"
							disabled={busy || !target || !validRevision}
							focusableWhenDisabled={busy}
							onClick={() => void run("api-manage", true)}
						>
							撤销用户 API 管理
						</Button>
					</div>
				)}
				{metadata ? (
					<dl className="grid gap-2 text-muted-foreground text-xs sm:grid-cols-3">
						<div>
							<dt>服务端状态</dt>
							<dd className="font-medium text-foreground">
								{metadata.granted ? "已授权" : "已撤销"}
							</dd>
						</div>
						<div>
							<dt>授权版本</dt>
							<dd className="font-medium text-foreground">
								{metadata.authorizationRevision ?? "无"}
							</dd>
						</div>
						<div>
							<dt>幂等重放</dt>
							<dd className="font-medium text-foreground">
								{metadata.replayed ? "是" : "否"}
							</dd>
						</div>
					</dl>
				) : null}
				{message ? (
					<Alert
						tone={failed ? "danger" : "info"}
						role={failed ? "alert" : "status"}
					>
						<AlertDescription>{message}</AlertDescription>
					</Alert>
				) : null}
			</div>
		</FormSection>
	);
}
