import { AlertCircle, Building2, RefreshCw, ShieldOff } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApplicationMetadataV1 } from "../../pilot/generated-v2/types.gen.js";
import {
	type PersonalApiCredentialScope,
	personalApiCredentialScopeLabels,
	personalApiCredentialScopes,
} from "../api-credentials/api-credentials.js";
import type {
	ApplicationCredentialRequest,
	ApplicationCredentialResponse,
	ApplicationManagementState,
} from "./application-management.js";

export type ApplicationManagementViewState =
	| ApplicationManagementState
	| { kind: "loading" | "denied" };

type ApplicationManagementScreenProps = {
	state: ApplicationManagementViewState;
	onRetry?: () => void;
	onRegister?: (name: string) => Promise<ApplicationMetadataV1>;
	onDisable?: (applicationId: string) => Promise<ApplicationMetadataV1>;
	onIssueCredential?: (input: {
		applicationId: string;
		body: ApplicationCredentialRequest;
	}) => Promise<ApplicationCredentialResponse>;
	isRegistering?: boolean;
	isDisabling?: boolean;
	isIssuingCredential?: boolean;
	actionError?: unknown;
};

const defaultScopes: PersonalApiCredentialScope[] = ["agent:read"];

function formatDate(value: string) {
	return new Date(value).toLocaleString("zh-CN");
}

function errorMessage(error: unknown, fallback: string) {
	return error instanceof Error && error.message ? error.message : fallback;
}

function unavailableMessage(
	state: Extract<ApplicationManagementViewState, { kind: "unavailable" }>,
) {
	if (state.reason === "authentication-required")
		return "登录状态已失效，请重新登录后再试。";
	if (state.reason === "denied") return "当前账号无权管理应用。";
	if (state.reason === "not-found")
		return "找不到这个应用，或当前账号不是负责人。";
	if (state.reason === "invalid-response")
		return "服务返回的应用数据无法识别，请联系管理员。";
	return state.retryable
		? "暂时无法读取应用，请稍后重试。"
		: "当前无法读取应用。";
}

export function ApplicationManagementScreen({
	state,
	onRetry,
	onRegister,
	onDisable,
	onIssueCredential,
	isRegistering = false,
	isDisabling = false,
	isIssuingCredential = false,
	actionError,
}: ApplicationManagementScreenProps) {
	const headingId = useId();
	const [name, setName] = useState("");
	const [recipientType, setRecipientType] = useState<"user" | "application">(
		"user",
	);
	const [recipientId, setRecipientId] = useState("");
	const [credentialId, setCredentialId] = useState("");
	const [scopes, setScopes] =
		useState<PersonalApiCredentialScope[]>(defaultScopes);
	const [expiresAt, setExpiresAt] = useState("");
	const [operation, setOperation] = useState<"issue" | "rotate">("issue");
	const [credentialNotice, setCredentialNotice] = useState<string | null>(null);

	async function submitRegistration(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!onRegister || !name.trim()) return;
		try {
			await onRegister(name.trim());
			setName("");
		} catch {
			// The owner renders mutation errors through actionError.
		}
	}

	async function submitCredential(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (
			state.kind !== "ready" ||
			!onIssueCredential ||
			scopes.length === 0 ||
			!recipientId.trim()
		)
			return;
		if (operation === "rotate" && !credentialId.trim()) return;
		setCredentialNotice(null);
		const body: ApplicationCredentialRequest =
			operation === "issue"
				? {
						operation,
						recipient: {
							principalType: recipientType,
							principalId: recipientId.trim(),
						},
						scopes,
						expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
					}
				: {
						operation,
						credentialId: credentialId.trim(),
						recipient: {
							principalType: recipientType,
							principalId: recipientId.trim(),
						},
						scopes,
						expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
					};
		try {
			const result = await onIssueCredential({
				applicationId: state.application.applicationId,
				body,
			});
			setCredentialNotice(
				`已提交${operation === "issue" ? "签发" : "轮换"}请求。凭证材料不会由管理接口返回；当前投递状态：${result.delivery.status}。`,
			);
		} catch {
			// The owner renders mutation errors through actionError.
		}
	}

	function toggleScope(scope: PersonalApiCredentialScope) {
		setScopes((current) =>
			current.includes(scope)
				? current.filter((value) => value !== scope)
				: [...current, scope],
		);
	}

	return (
		<section aria-labelledby={headingId} className="space-y-8">
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">安全设置</p>
					<h1 id={headingId}>应用管理</h1>
					<p>
						应用责任人可以维护自己的应用和凭证元数据。应用凭证材料始终通过受控投递，不会从管理响应中返回。
					</p>
				</div>
				<Building2
					aria-hidden="true"
					className="size-6 text-muted-foreground"
				/>
			</header>

			{actionError ? (
				<Alert variant="destructive">
					<AlertCircle aria-hidden="true" />
					<AlertDescription>
						{errorMessage(actionError, "应用操作失败，请稍后重试。")}
					</AlertDescription>
				</Alert>
			) : null}
			{credentialNotice ? (
				<Alert>
					<AlertTitle>应用凭证状态</AlertTitle>
					<AlertDescription>{credentialNotice}</AlertDescription>
				</Alert>
			) : null}

			{state.kind === "loading" ? (
				<p role="status" className="py-8 text-muted-foreground text-sm">
					正在读取应用…
				</p>
			) : null}
			{state.kind === "denied" ? (
				<Alert variant="destructive">
					<AlertDescription>当前账号无权管理应用。</AlertDescription>
				</Alert>
			) : null}
			{state.kind === "unavailable" ? (
				<Alert variant="destructive">
					<AlertDescription>{unavailableMessage(state)}</AlertDescription>
					{state.retryable && onRetry ? (
						<Button
							className="mt-3"
							variant="outline"
							type="button"
							onClick={onRetry}
						>
							<RefreshCw aria-hidden="true" data-icon="inline-start" />
							重新加载
						</Button>
					) : null}
				</Alert>
			) : null}
			{state.kind === "empty" ? (
				<form
					className="max-w-xl space-y-5 rounded border bg-card p-5"
					onSubmit={submitRegistration}
				>
					<div>
						<h2 className="font-semibold text-base">注册一个应用</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							应用负责人由当前登录会话决定，不需要填写 userId。
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${headingId}-name`}>应用名称</Label>
						<Input
							id={`${headingId}-name`}
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={128}
							required
							aria-describedby={`${headingId}-name-hint`}
						/>
						<p
							id={`${headingId}-name-hint`}
							className="text-muted-foreground text-xs"
						>
							使用团队成员能识别的名称。
						</p>
					</div>
					<Button
						type="submit"
						disabled={!onRegister || !name.trim() || isRegistering}
					>
						{isRegistering ? "正在注册…" : "注册应用"}
					</Button>
				</form>
			) : null}
			{state.kind === "ready" ? (
				<ApplicationDetails
					application={state.application}
					onDisable={onDisable}
					isDisabling={isDisabling}
					onIssueCredential={onIssueCredential}
					isIssuingCredential={isIssuingCredential}
					operation={operation}
					setOperation={setOperation}
					recipientType={recipientType}
					setRecipientType={setRecipientType}
					recipientId={recipientId}
					setRecipientId={setRecipientId}
					credentialId={credentialId}
					setCredentialId={setCredentialId}
					scopes={scopes}
					toggleScope={toggleScope}
					expiresAt={expiresAt}
					setExpiresAt={setExpiresAt}
					submitCredential={submitCredential}
				/>
			) : null}
		</section>
	);
}

type ApplicationDetailsProps = {
	application: ApplicationMetadataV1;
	onDisable?: (applicationId: string) => Promise<ApplicationMetadataV1>;
	isDisabling: boolean;
	onIssueCredential?: ApplicationManagementScreenProps["onIssueCredential"];
	isIssuingCredential: boolean;
	operation: "issue" | "rotate";
	setOperation: (value: "issue" | "rotate") => void;
	recipientType: "user" | "application";
	setRecipientType: (value: "user" | "application") => void;
	recipientId: string;
	setRecipientId: (value: string) => void;
	credentialId: string;
	setCredentialId: (value: string) => void;
	scopes: PersonalApiCredentialScope[];
	toggleScope: (scope: PersonalApiCredentialScope) => void;
	expiresAt: string;
	setExpiresAt: (value: string) => void;
	submitCredential: (event: FormEvent<HTMLFormElement>) => Promise<void>;
};

function ApplicationDetails(props: ApplicationDetailsProps) {
	const { application } = props;
	const id = useId();
	const disabled = application.status === "disabled";
	return (
		<div className="space-y-6">
			<div className="rounded border bg-card p-5">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<div className="flex flex-wrap items-center gap-2">
							<h2 className="font-semibold text-lg">{application.name}</h2>
							<Badge
								variant="outline"
								data-status={disabled ? "disabled" : "available"}
							>
								{disabled ? "已停用" : "运行中"}
							</Badge>
						</div>
						<p className="mt-2 text-muted-foreground text-sm">
							应用 ID：
							<code className="[overflow-wrap:anywhere]">
								{application.applicationId}
							</code>
						</p>
					</div>
					{!disabled && props.onDisable ? (
						<Button
							variant="destructive"
							type="button"
							disabled={props.isDisabling}
							onClick={() => void props.onDisable?.(application.applicationId)}
						>
							<ShieldOff aria-hidden="true" />
							{props.isDisabling ? "正在停用…" : "停用应用"}
						</Button>
					) : null}
				</div>
				<dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
					<div>
						<dt className="text-muted-foreground">负责人</dt>
						<dd>{application.responsibleUserId}</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">创建时间</dt>
						<dd>{formatDate(application.createdAt)}</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">更新时间</dt>
						<dd>{formatDate(application.updatedAt)}</dd>
					</div>
				</dl>
			</div>
			{disabled ? (
				<Empty>
					<EmptyTitle>应用已停用</EmptyTitle>
					<EmptyDescription>停用后不能再签发或轮换应用凭证。</EmptyDescription>
				</Empty>
			) : (
				<form
					className="max-w-3xl space-y-5 rounded border bg-card p-5"
					onSubmit={props.submitCredential}
				>
					<div>
						<h2 className="font-semibold text-base">应用凭证元数据</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							当前接口只返回元数据和投递状态。请先由管理员授予 recipient
							获取材料的权限。
						</p>
					</div>
					<fieldset className="space-y-3">
						<legend className="font-medium text-sm">操作</legend>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								size="sm"
								variant={props.operation === "issue" ? "secondary" : "outline"}
								onClick={() => props.setOperation("issue")}
							>
								签发
							</Button>
							<Button
								type="button"
								size="sm"
								variant={props.operation === "rotate" ? "secondary" : "outline"}
								onClick={() => props.setOperation("rotate")}
							>
								轮换
							</Button>
						</div>
					</fieldset>
					{props.operation === "rotate" ? (
						<div className="space-y-2">
							<Label htmlFor={`${id}-credential`}>要轮换的凭证 ID</Label>
							<Input
								id={`${id}-credential`}
								value={props.credentialId}
								onChange={(event) => props.setCredentialId(event.target.value)}
								required
							/>
						</div>
					) : null}
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor={`${id}-recipient-type`}>接收主体类型</Label>
							<div className="flex gap-2">
								<Button
									type="button"
									size="sm"
									variant={
										props.recipientType === "user" ? "secondary" : "outline"
									}
									onClick={() => props.setRecipientType("user")}
								>
									用户
								</Button>
								<Button
									type="button"
									size="sm"
									variant={
										props.recipientType === "application"
											? "secondary"
											: "outline"
									}
									onClick={() => props.setRecipientType("application")}
								>
									应用
								</Button>
							</div>
						</div>
						<div className="space-y-2">
							<Label htmlFor={`${id}-recipient`}>接收主体 ID</Label>
							<Input
								id={`${id}-recipient`}
								value={props.recipientId}
								onChange={(event) => props.setRecipientId(event.target.value)}
								required
							/>
						</div>
					</div>
					<fieldset className="space-y-3">
						<legend className="font-medium text-sm">权限范围</legend>
						<div className="grid gap-2 sm:grid-cols-2">
							{personalApiCredentialScopes.map((scope) => {
								const checkboxId = `${id}-${scope.replace(":", "-")}`;
								return (
									<div
										key={scope}
										className="flex min-h-11 items-center gap-2 rounded border px-3 py-2 text-sm"
									>
										<Checkbox
											id={checkboxId}
											checked={props.scopes.includes(scope)}
											onCheckedChange={() => props.toggleScope(scope)}
										/>
										<Label htmlFor={checkboxId} className="font-normal">
											{personalApiCredentialScopeLabels[scope]}
										</Label>
										<code className="ml-auto text-[11px] text-muted-foreground">
											{scope}
										</code>
									</div>
								);
							})}
						</div>
						{props.scopes.length === 0 ? (
							<p className="text-destructive text-sm" role="alert">
								至少选择一项权限范围。
							</p>
						) : null}
					</fieldset>
					<div className="space-y-2">
						<Label htmlFor={`${id}-expiry`}>过期时间（可选）</Label>
						<Input
							id={`${id}-expiry`}
							type="datetime-local"
							value={props.expiresAt}
							onChange={(event) => props.setExpiresAt(event.target.value)}
						/>
					</div>
					<Button
						type="submit"
						disabled={
							!props.onIssueCredential ||
							props.scopes.length === 0 ||
							!props.recipientId.trim() ||
							(props.operation === "rotate" && !props.credentialId.trim()) ||
							props.isIssuingCredential
						}
					>
						{props.isIssuingCredential
							? "正在提交…"
							: props.operation === "issue"
								? "签发应用凭证"
								: "轮换应用凭证"}
					</Button>
				</form>
			)}
		</div>
	);
}
