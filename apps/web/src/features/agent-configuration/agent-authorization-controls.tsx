import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import {
	AgentAuthorizationRequestError,
	grantApplicationManager,
	grantApplicationUse,
	revokeApplicationManager,
	revokeApplicationUse,
	revokeUserApiUse,
} from "./agent-authorization.js";

type TargetKind = "application" | "user";
type Permission = "manage" | "use" | "api-use";
type Metadata = {
	authorizationRevision: string | null;
	granted: boolean;
	replayed: boolean;
};

function errorMessage(error: unknown) {
	if (error instanceof AgentAuthorizationRequestError && error.status === 403)
		return "服务端拒绝了此次授权操作，请确认当前 Owner 或管理员权限。";
	if (error instanceof AgentAuthorizationRequestError && error.status === 409)
		return "授权版本已变化，请重新填写目标和版本后重试。";
	return "操作未确认，请刷新页面后重试。未显示上游错误详情。";
}

export function AgentAuthorizationControls({
	agentId,
	enabled,
}: {
	agentId: string;
	enabled: boolean;
}) {
	const [targetKind, setTargetKind] = useState<TargetKind>("application");
	const [targetId, setTargetId] = useState("");
	const [expectedRevision, setExpectedRevision] = useState("");
	const [busy, setBusy] = useState(false);
	const [metadata, setMetadata] = useState<Metadata>();
	const [message, setMessage] = useState("");

	if (!enabled) return null;

	const target = targetId.trim();
	const revision = Number(expectedRevision.trim());
	const validRevision =
		expectedRevision.trim() !== "" &&
		Number.isInteger(revision) &&
		revision >= 0;

	async function run(permission: Permission, revoke: boolean) {
		if (busy || !target) return;
		if (targetKind === "user" && (permission !== "api-use" || !validRevision))
			return;
		setBusy(true);
		setMessage("");
		try {
			const result =
				targetKind === "user"
					? await revokeUserApiUse(agentId, target, revision)
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
			setMessage(errorMessage(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section
			aria-labelledby="agent-authorization-controls-heading"
			className="detail-section space-y-4 border-border border-t pt-5"
		>
			<div>
				<h2
					id="agent-authorization-controls-heading"
					className="font-semibold text-foreground text-sm"
				>
					Agent 授权控制
				</h2>
				<p className="mt-1 text-muted-foreground text-sm">
					填写明确的用户或应用 ID，执行由服务端最终授权的
					grant/revoke。页面不推断完整授权列表，也不显示凭证。
				</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="agent-authorization-target-kind">目标类型</Label>
					<NativeSelect
						id="agent-authorization-target-kind"
						value={targetKind}
						disabled={busy}
						onChange={(event) => {
							setTargetKind(event.target.value as TargetKind);
							setMetadata(undefined);
							setMessage("");
						}}
					>
						<NativeSelectOption value="application">应用</NativeSelectOption>
						<NativeSelectOption value="user">用户</NativeSelectOption>
					</NativeSelect>
				</div>
				<div className="space-y-2">
					<Label htmlFor="agent-authorization-target-id">
						{targetKind === "application" ? "应用 ID" : "用户 ID"}
					</Label>
					<Input
						id="agent-authorization-target-id"
						disabled={busy}
						value={targetId}
						onChange={(event) => {
							setTargetId(event.target.value);
							setMetadata(undefined);
							setMessage("");
						}}
					/>
				</div>
			</div>
			{targetKind === "user" ? (
				<div className="space-y-2">
					<Label htmlFor="agent-authorization-expected-revision">
						撤销所需授权版本
					</Label>
					<Input
						id="agent-authorization-expected-revision"
						inputMode="numeric"
						disabled={busy}
						value={expectedRevision}
						onChange={(event) => setExpectedRevision(event.target.value)}
					/>
					<p className="text-muted-foreground text-xs">
						当前 SDK 仅提供用户 API-use revoke；服务端会校验此授权版本。
					</p>
				</div>
			) : null}
			{targetKind === "application" ? (
				<div className="flex flex-wrap gap-3">
					<Button
						disabled={busy || !target}
						onClick={() => void run("manage", false)}
					>
						授权管理
					</Button>
					<Button
						variant="outline"
						disabled={busy || !target}
						onClick={() => void run("manage", true)}
					>
						撤销管理
					</Button>
					<Button
						disabled={busy || !target}
						onClick={() => void run("use", false)}
					>
						授权使用
					</Button>
					<Button
						variant="outline"
						disabled={busy || !target}
						onClick={() => void run("use", true)}
					>
						撤销使用
					</Button>
				</div>
			) : (
				<Button
					variant="outline"
					disabled={busy || !target || !validRevision}
					onClick={() => void run("api-use", true)}
				>
					撤销用户 API 使用
				</Button>
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
				<Alert role="status">
					<AlertDescription>{message}</AlertDescription>
				</Alert>
			) : null}
		</section>
	);
}
