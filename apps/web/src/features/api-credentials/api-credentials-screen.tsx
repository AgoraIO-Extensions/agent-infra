import {
	AlertCircle,
	Check,
	Copy,
	KeyRound,
	Plus,
	RefreshCw,
	Shield,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLegend } from "@/components/ui/field";
import { shortIdentifier } from "@/components/ui/identifier-text";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingLine } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Timestamp } from "@/components/ui/timestamp";
import { withObjectName } from "@/lib/accessible-name";
import type {
	IssuePersonalApiCredentialV2Responses,
	PersonalApiCredentialIssueRequestV1,
	PersonalApiCredentialMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type ApiCredentialsState,
	type PersonalApiCredentialScope,
	personalApiCredentialScopeLabels,
	personalApiCredentialScopes,
} from "./api-credentials.js";
import {
	type NarrowCredential,
	NarrowCredentialForm,
} from "./narrow-credential-form.js";

export type ApiCredentialsViewState =
	| ApiCredentialsState
	| { kind: "loading" | "denied" };
export type PersonalApiCredentialIssueResponse =
	IssuePersonalApiCredentialV2Responses[keyof IssuePersonalApiCredentialV2Responses];

type ApiCredentialsScreenProps = {
	state: ApiCredentialsViewState;
	onRetry?: () => void;
	onIssue?: (
		body: PersonalApiCredentialIssueRequestV1,
	) => Promise<PersonalApiCredentialIssueResponse>;
	onRevoke?: (credentialId: string) => Promise<unknown>;
	onNarrow?: NarrowCredential;
	narrowingCredentialId?: string;
	isIssuing?: boolean;
	revokingCredentialId?: string;
	issueError?: unknown;
	revokeError?: unknown;
	/** 主体列：个人凭证只代表当前登录用户，显示其姓名。 */
	subjectName?: string;
	/** 页头「创建应用凭证」：跳到应用分区，不发起写请求。 */
	onCreateApplicationCredential?: () => void;
};

const defaultScopes: PersonalApiCredentialScope[] = ["agent:read"];

function stateMessage(
	state: Extract<ApiCredentialsViewState, { kind: "unavailable" }>,
) {
	if (state.reason === "authentication-required")
		return "登录状态已失效，请重新登录后再试。";
	if (state.reason === "denied") return "当前账号无权管理个人 API 凭证。";
	if (state.reason === "invalid-response")
		return "服务返回的数据无法识别，请联系管理员。";
	return state.retryable
		? "暂时无法读取 API 凭证，请稍后重试。"
		: "当前无法读取 API 凭证。";
}

function errorMessage(error: unknown, fallback: string) {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function ApiCredentialsScreen({
	state,
	onRetry,
	onIssue,
	onRevoke,
	onNarrow,
	narrowingCredentialId,
	isIssuing = false,
	revokingCredentialId,
	issueError,
	revokeError,
	subjectName,
	onCreateApplicationCredential,
}: ApiCredentialsScreenProps) {
	const headingId = useId();
	const scopesId = `${headingId}-scopes`;
	const expiryId = `${headingId}-expiry`;
	const [scopes, setScopes] =
		useState<PersonalApiCredentialScope[]>(defaultScopes);
	const [expiresAt, setExpiresAt] = useState("");
	const [issuedCredential, setIssuedCredential] = useState<string | null>(null);
	const [issueNotice, setIssueNotice] = useState<string | null>(null);
	const [copyState, setCopyState] = useState(false);

	async function submitIssue(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!onIssue || scopes.length === 0) return;
		setIssuedCredential(null);
		setIssueNotice(null);
		try {
			const result = await onIssue({
				scopes,
				expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
			});
			if (result.replayed) {
				setIssueNotice(
					"这次请求是幂等重放；出于安全原因，凭证材料不会再次显示。请使用第一次签发时保存的凭证。 ",
				);
			} else {
				setIssuedCredential(result.credential);
				setIssueNotice(
					"凭证只在这次签发响应中显示一次，请立即复制并妥善保存。关闭提示后不会再次显示。 ",
				);
			}
		} catch {
			// The mutation owner can expose a detailed error through issueError.
		}
	}

	async function copyIssuedCredential() {
		if (!issuedCredential || !navigator.clipboard) return;
		await navigator.clipboard.writeText(issuedCredential);
		setCopyState(true);
		window.setTimeout(() => setCopyState(false), 1600);
	}

	function toggleScope(scope: PersonalApiCredentialScope) {
		setScopes((current) =>
			current.includes(scope)
				? current.filter((value) => value !== scope)
				: [...current, scope],
		);
	}

	return (
		<section aria-labelledby={headingId}>
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">我的管理 / API 凭证</p>
					<h1 id={headingId}>API 凭证</h1>
					<p>管理个人和应用凭证的范围、有效期与撤销状态。</p>
				</div>
				{onCreateApplicationCredential ? (
					<Button type="button" onClick={onCreateApplicationCredential}>
						<Plus aria-hidden="true" />
						创建应用凭证
					</Button>
				) : null}
			</header>

			{/* 静态说明，不设 role。 */}
			<Alert tone="info" icon={<Shield aria-hidden="true" />}>
				<AlertTitle>凭证值不会回显</AlertTitle>
				<AlertDescription>
					本页只展示元数据；发放、轮换和接收者授权由服务端校验。
				</AlertDescription>
			</Alert>

			{issuedCredential ? (
				// 只让提示段落承担 status，避免读屏整段播报凭证明文。
				<Alert
					tone="info"
					icon={<KeyRound aria-hidden="true" />}
					className="settings-surface"
				>
					<AlertTitle>已签发个人 API 凭证</AlertTitle>
					<AlertDescription className="space-y-3">
						<p role="status">{issueNotice}</p>
						<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
							<code className="min-w-0 flex-1 overflow-auto rounded-[10px] border bg-muted px-3 py-2 text-xs [overflow-wrap:anywhere]">
								{issuedCredential}
							</code>
							<Button
								type="button"
								variant="outline"
								onClick={copyIssuedCredential}
							>
								{copyState ? (
									<Check aria-hidden="true" />
								) : (
									<Copy aria-hidden="true" />
								)}
								{copyState ? "已复制" : "复制凭证"}
							</Button>
						</div>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setIssuedCredential(null)}
						>
							关闭一次性凭证提示
						</Button>
					</AlertDescription>
				</Alert>
			) : issueNotice ? (
				<Alert
					tone="info"
					role="status"
					icon={<AlertCircle aria-hidden="true" />}
					className="settings-surface"
				>
					<AlertDescription>{issueNotice}</AlertDescription>
				</Alert>
			) : null}
			{issueError ? (
				<Alert tone="danger" role="alert" className="settings-surface">
					<AlertDescription>
						{errorMessage(issueError, "签发个人 API 凭证失败，请稍后重试。")}
					</AlertDescription>
				</Alert>
			) : null}
			{revokeError ? (
				<Alert tone="danger" role="alert" className="settings-surface">
					<AlertDescription>
						{errorMessage(revokeError, "撤销个人 API 凭证失败，请稍后重试。")}
					</AlertDescription>
				</Alert>
			) : null}

			<section className="settings-surface">
				{state.kind === "loading" ? (
					<LoadingLine className="py-8">正在读取个人凭证…</LoadingLine>
				) : null}
				{state.kind === "denied" ? (
					<Alert tone="warn">
						<AlertDescription>当前账号无权查看个人 API 凭证。</AlertDescription>
					</Alert>
				) : null}
				{state.kind === "unavailable" ? (
					<Alert tone="danger" role="alert">
						<AlertDescription>{stateMessage(state)}</AlertDescription>
						{state.retryable && onRetry ? (
							<AlertAction>
								<Button variant="outline" type="button" onClick={onRetry}>
									<RefreshCw aria-hidden="true" data-icon="inline-start" />
									重新加载
								</Button>
							</AlertAction>
						) : null}
					</Alert>
				) : null}
				{state.kind === "ready" && state.credentials.length === 0 ? (
					<Empty>
						<EmptyTitle>暂无个人 API 凭证</EmptyTitle>
						<EmptyDescription>
							签发后，凭证元数据会显示在这里。
						</EmptyDescription>
					</Empty>
				) : null}
				{state.kind === "ready" && state.credentials.length > 0 ? (
					<Table className="credential-table" aria-label="个人 API 凭证">
						<TableHeader>
							<TableRow>
								<TableHead>名称</TableHead>
								<TableHead>主体</TableHead>
								<TableHead>范围</TableHead>
								<TableHead>状态</TableHead>
								<TableHead>有效期</TableHead>
								<TableHead>
									<span className="sr-only">操作</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{state.credentials.map((credential) => (
								<CredentialRow
									key={credential.credentialId}
									credential={credential}
									subjectName={subjectName}
									onRevoke={onRevoke}
									onNarrow={onNarrow}
									onRefresh={onRetry}
									narrowingCredentialId={narrowingCredentialId}
									pending={credential.credentialId === revokingCredentialId}
								/>
							))}
						</TableBody>
					</Table>
				) : null}
			</section>

			<section
				className="settings-surface"
				aria-labelledby={`${headingId}-issue`}
			>
				<div className="section-heading">
					<div>
						<h2 id={`${headingId}-issue`}>签发个人凭证</h2>
						<p>只在需要时创建凭证，并选择最小权限范围。</p>
					</div>
				</div>
				<form className="space-y-5" onSubmit={submitIssue}>
					{/* 页面上还有应用凭证的同名分组与字段，名称带上对象以便区分（N-12）。 */}
					<fieldset
						className="space-y-3"
						aria-label={withObjectName("权限范围", "个人凭证")}
						aria-describedby={`${scopesId}-hint`}
					>
						<FieldLegend>权限范围</FieldLegend>
						<p
							id={`${scopesId}-hint`}
							className="text-muted-foreground text-xs"
						>
							至少选择一项；不需要的权限不要授予。
						</p>
						<div className="grid gap-2 sm:grid-cols-2">
							{personalApiCredentialScopes.map((scope) => (
								<div
									key={scope}
									className="flex min-h-11 items-center gap-2 rounded-[10px] border px-3 py-2 text-sm hover:bg-muted"
								>
									<Checkbox
										id={`${scopesId}-${scope.replace(":", "-")}`}
										checked={scopes.includes(scope)}
										onCheckedChange={() => toggleScope(scope)}
									/>
									<Label
										htmlFor={`${scopesId}-${scope.replace(":", "-")}`}
										variant="option"
									>
										{personalApiCredentialScopeLabels[scope]}
									</Label>
									<code className="ml-auto text-[11px] text-muted-foreground">
										{scope}
									</code>
								</div>
							))}
						</div>
						{scopes.length === 0 ? (
							<Alert tone="danger" role="alert">
								<AlertDescription>至少选择一项权限范围。</AlertDescription>
							</Alert>
						) : null}
					</fieldset>
					<Field>
						<Label htmlFor={expiryId}>过期时间（可选）</Label>
						<Input
							id={expiryId}
							type="datetime-local"
							aria-label={withObjectName("过期时间（可选）", "个人凭证")}
							value={expiresAt}
							onChange={(event) => setExpiresAt(event.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							留空表示不过期；签发后只能进一步收窄权限或提前过期。
						</p>
					</Field>
					<Button
						type="submit"
						disabled={!onIssue || scopes.length === 0 || isIssuing}
					>
						{isIssuing ? "正在签发…" : "签发个人凭证"}
					</Button>
				</form>
			</section>
		</section>
	);
}

function CredentialRow({
	credential,
	subjectName,
	onRevoke,
	onNarrow,
	onRefresh,
	narrowingCredentialId,
	pending,
}: {
	credential: PersonalApiCredentialMetadataV1;
	subjectName?: string;
	onRevoke?: (credentialId: string) => Promise<unknown>;
	onNarrow?: NarrowCredential;
	onRefresh?: () => void;
	narrowingCredentialId?: string;
	pending: boolean;
}) {
	const revoked = Boolean(credential.revokedAt);
	const [now, setNow] = useState(Date.now);
	const [editing, setEditing] = useState(false);
	const [notice, setNotice] = useState(false);
	const narrowButton = useRef<HTMLButtonElement>(null);
	// 撤销确认关闭时触发器已禁用、成功后会消失，焦点落到该行的凭证标识上。
	const credentialLabel = useRef<HTMLElement>(null);
	const restoreFocus = useRef(false);
	const expiry = credential.expiresAt
		? new Date(credential.expiresAt).getTime()
		: null;
	const expired = expiry !== null && expiry <= now;
	useEffect(() => {
		if (revoked || expiry === null || expiry <= now) return;
		const timer = window.setTimeout(
			() => setNow(Date.now()),
			Math.min(Math.max(0, expiry - Date.now()), 2_147_483_647),
		);
		return () => window.clearTimeout(timer);
	}, [expiry, now, revoked]);
	const active = !revoked && !expired;
	const busy = pending || Boolean(narrowingCredentialId);
	const revokeLabel = pending ? "正在撤销…" : "撤销";
	useEffect(() => {
		if (restoreFocus.current && !editing && !busy) {
			narrowButton.current?.focus();
			restoreFocus.current = false;
		}
	}, [editing, busy]);
	function closeForm() {
		restoreFocus.current = true;
		setEditing(false);
	}
	return (
		<>
			<TableRow data-credential-id={credential.credentialId}>
				<TableCell data-label="名称">
					{/* 契约没有凭证名称字段，统一显示「个人凭证」，内部 ID 只显示缩写。
					    包一层 div：窄屏行卡片里名称与副文同在右侧值列。 */}
					<div className="min-w-0">
						<strong>个人凭证</strong>
						<small>
							<code
								ref={credentialLabel}
								tabIndex={-1}
								title={credential.credentialId}
								className="font-mono"
							>
								{shortIdentifier(credential.credentialId)}
							</code>
							{" · 创建于 "}
							<Timestamp value={credential.createdAt} />
							{" · 最近使用 "}
							{credential.lastUsedAt ? (
								<Timestamp value={credential.lastUsedAt} />
							) : (
								<span>尚未使用</span>
							)}
						</small>
					</div>
				</TableCell>
				<TableCell data-label="主体">{subjectName ?? "当前用户"}</TableCell>
				<TableCell data-label="范围">{credential.scopes.join(" · ")}</TableCell>
				<TableCell data-label="状态">
					<Badge tone={revoked ? "red" : expired ? "amber" : "green"}>
						{revoked ? "已撤销" : expired ? "已过期" : "有效"}
					</Badge>
				</TableCell>
				<TableCell data-label="有效期">
					{revoked && credential.revokedAt ? (
						// 已撤销的个人凭证只显示撤销时间，不提供详情或轮换（#2862，PRD §7.3）。
						<span>
							已撤销于{" "}
							<Timestamp value={credential.revokedAt} style="absolute" />
						</span>
					) : credential.expiresAt ? (
						<Timestamp value={credential.expiresAt} style="absolute" />
					) : (
						"永不过期"
					)}
				</TableCell>
				<TableCell data-label="操作">
					<div className="flex flex-wrap gap-2">
						{active && onNarrow ? (
							<Button
								type="button"
								variant="ghost"
								ref={narrowButton}
								aria-expanded={editing}
								aria-label={withObjectName(
									"收窄权限与有效期",
									credential.credentialId,
								)}
								disabled={busy}
								onClick={() => {
									setNotice(false);
									setEditing((current) => !current);
								}}
							>
								收窄权限与有效期
							</Button>
						) : null}
						{!revoked && onRevoke ? (
							<ConfirmDialog
								disabled={busy}
								trigger={
									<Button
										type="button"
										variant="outline"
										aria-label={withObjectName(
											revokeLabel,
											credential.credentialId,
										)}
									>
										{revokeLabel}
									</Button>
								}
								title="撤销这张 API 凭证？"
								subject={{
									// 设计 strong.mono 短形式（V-20）：完整 ID 在 title 中，权限行为 11px field-help。
									name: (
										<strong
											className="font-bold font-mono"
											title={credential.credentialId}
										>
											{shortIdentifier(credential.credentialId)}
										</strong>
									),
									detail: (
										<p className="credential-revoke-scopes">
											权限：{credential.scopes.join("、")}
										</p>
									),
								}}
								description="撤销后，使用这张凭证的 API 访问和结果流会立即终止，已受理的任务继续执行。撤销后不能恢复，需要时请签发新凭证。"
								confirmLabel="撤销凭证"
								finalFocus={credentialLabel}
								onConfirm={() => {
									setEditing(false);
									void onRevoke(credential.credentialId).catch(() => undefined);
								}}
							/>
						) : null}
					</div>
					{notice ? (
						<p role="status" className="mt-2 text-[12px]">
							凭证已收窄，已读取最新元数据。
						</p>
					) : null}
				</TableCell>
			</TableRow>
			{active && editing && onNarrow ? (
				// 收窄表单在该行下方整行展开，宽度等于表格宽度。
				<TableRow className="credential-edit-row">
					<TableCell colSpan={6}>
						<NarrowCredentialForm
							credential={credential}
							onNarrow={onNarrow}
							onRefresh={onRefresh}
							onCancel={closeForm}
							onComplete={() => {
								setNotice(true);
								closeForm();
							}}
							disabled={busy}
						/>
					</TableCell>
				</TableRow>
			) : null}
		</>
	);
}
