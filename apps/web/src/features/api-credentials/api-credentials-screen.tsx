import { AlertCircle, Check, Copy, KeyRound, RefreshCw, Shield } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
	IssuePersonalApiCredentialV2Responses,
	PersonalApiCredentialIssueRequestV1,
	PersonalApiCredentialMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	personalApiCredentialScopeLabels,
	personalApiCredentialScopes,
	type ApiCredentialsState,
	type PersonalApiCredentialScope,
} from "./api-credentials.js";

export type ApiCredentialsViewState = ApiCredentialsState | { kind: "loading" | "denied" };
export type PersonalApiCredentialIssueResponse =
	IssuePersonalApiCredentialV2Responses[keyof IssuePersonalApiCredentialV2Responses];

type ApiCredentialsScreenProps = {
	state: ApiCredentialsViewState;
	onRetry?: () => void;
	onIssue?: (
		body: PersonalApiCredentialIssueRequestV1,
	) => Promise<PersonalApiCredentialIssueResponse>;
	onRevoke?: (credentialId: string) => Promise<unknown>;
	isIssuing?: boolean;
	revokingCredentialId?: string;
	issueError?: unknown;
	revokeError?: unknown;
};

const defaultScopes: PersonalApiCredentialScope[] = ["agent:read"];

function formatDate(value: string | null) {
	return value ? new Date(value).toLocaleString("zh-CN") : "永不过期";
}

function stateMessage(state: Extract<ApiCredentialsViewState, { kind: "unavailable" }>) {
	if (state.reason === "authentication-required") return "登录状态已失效，请重新登录后再试。";
	if (state.reason === "denied") return "当前账号无权管理个人 API 凭证。";
	if (state.reason === "invalid-response") return "服务返回的数据无法识别，请联系管理员。";
	return state.retryable ? "暂时无法读取 API 凭证，请稍后重试。" : "当前无法读取 API 凭证。";
}

function errorMessage(error: unknown, fallback: string) {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function ApiCredentialsScreen({
	state,
	onRetry,
	onIssue,
	onRevoke,
	isIssuing = false,
	revokingCredentialId,
	issueError,
	revokeError,
}: ApiCredentialsScreenProps) {
	const headingId = useId();
	const scopesId = `${headingId}-scopes`;
	const expiryId = `${headingId}-expiry`;
	const [scopes, setScopes] = useState<PersonalApiCredentialScope[]>(defaultScopes);
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
				setIssueNotice("这次请求是幂等重放；出于安全原因，凭证材料不会再次显示。请使用第一次签发时保存的凭证。 ");
			} else {
				setIssuedCredential(result.credential);
				setIssueNotice("凭证只在这次签发响应中显示一次，请立即复制并妥善保存。关闭提示后不会再次显示。 ");
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
		<section aria-labelledby={headingId} className="space-y-8">
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">安全设置</p>
					<h1 id={headingId}>个人 API 凭证</h1>
					<p>凭证只代表当前登录用户。服务端会根据当前会话解析身份，不接受页面提交的 userId。</p>
				</div>
				<Shield aria-hidden="true" className="size-6 text-muted-foreground" />
			</header>

			{issuedCredential ? (
				<Alert>
					<KeyRound aria-hidden="true" />
					<AlertTitle>已签发个人 API 凭证</AlertTitle>
					<AlertDescription className="space-y-3">
						<p>{issueNotice}</p>
						<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
							<code className="min-w-0 flex-1 overflow-auto rounded border bg-muted px-3 py-2 text-xs [overflow-wrap:anywhere]">
								{issuedCredential}
							</code>
							<Button type="button" variant="outline" onClick={copyIssuedCredential}>
								{copyState ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
								{copyState ? "已复制" : "复制凭证"}
							</Button>
						</div>
						<Button type="button" variant="ghost" onClick={() => setIssuedCredential(null)}>
							关闭一次性凭证提示
						</Button>
					</AlertDescription>
				</Alert>
			) : issueNotice ? (
				<Alert>
					<AlertCircle aria-hidden="true" />
					<AlertDescription>{issueNotice}</AlertDescription>
				</Alert>
			) : null}
			{issueError ? (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(issueError, "签发个人 API 凭证失败，请稍后重试。")}</AlertDescription>
				</Alert>
			) : null}
			{revokeError ? (
				<Alert variant="destructive">
					<AlertDescription>{errorMessage(revokeError, "撤销个人 API 凭证失败，请稍后重试。")}</AlertDescription>
				</Alert>
			) : null}

			<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
				<form className="space-y-5 rounded border bg-card p-5" onSubmit={submitIssue}>
					<div>
						<h2 className="text-base font-semibold">签发新凭证</h2>
						<p className="mt-1 text-sm text-muted-foreground">只在需要时创建凭证，并选择最小权限范围。</p>
					</div>
					<fieldset className="space-y-3" aria-describedby={`${scopesId}-hint`}>
						<legend className="text-sm font-medium">权限范围</legend>
						<p id={`${scopesId}-hint`} className="text-xs text-muted-foreground">至少选择一项；不需要的权限不要授予。</p>
						<div className="grid gap-2 sm:grid-cols-2">
							{personalApiCredentialScopes.map((scope) => (
								<div key={scope} className="flex min-h-11 items-center gap-2 rounded border px-3 py-2 text-sm hover:bg-muted">
									<Checkbox
										id={`${scopesId}-${scope.replace(":", "-")}`}
										checked={scopes.includes(scope)}
										onCheckedChange={() => toggleScope(scope)}
									/>
									<Label htmlFor={`${scopesId}-${scope.replace(":", "-")}`} className="font-normal">
										{personalApiCredentialScopeLabels[scope]}
									</Label>
									<code className="ml-auto text-[11px] text-muted-foreground">{scope}</code>
								</div>
							))}
						</div>
						{scopes.length === 0 ? <p className="text-sm text-destructive" role="alert">至少选择一项权限范围。</p> : null}
					</fieldset>
					<div className="space-y-2">
						<Label htmlFor={expiryId}>过期时间（可选）</Label>
						<Input id={expiryId} type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
						<p className="text-xs text-muted-foreground">留空表示不过期；签发后只能进一步收窄权限或提前过期。</p>
					</div>
					<Button type="submit" disabled={!onIssue || scopes.length === 0 || isIssuing}>
						{isIssuing ? "正在签发…" : "签发个人凭证"}
					</Button>
				</form>

				<div className="space-y-3">
					<h2 className="text-base font-semibold">已有凭证</h2>
					{state.kind === "loading" ? <p role="status" className="py-8 text-sm text-muted-foreground">正在读取个人凭证…</p> : null}
					{state.kind === "denied" ? <Alert variant="destructive"><AlertDescription>当前账号无权查看个人 API 凭证。</AlertDescription></Alert> : null}
					{state.kind === "unavailable" ? (
						<Alert variant="destructive">
							<AlertDescription>{stateMessage(state)}</AlertDescription>
							{state.retryable && onRetry ? <Button className="mt-3" variant="outline" type="button" onClick={onRetry}><RefreshCw aria-hidden="true" data-icon="inline-start" />重新加载</Button> : null}
						</Alert>
					) : null}
					{state.kind === "ready" && state.credentials.length === 0 ? <Empty><EmptyTitle>暂无个人 API 凭证</EmptyTitle><EmptyDescription>签发后，凭证元数据会显示在这里。</EmptyDescription></Empty> : null}
					{state.kind === "ready" && state.credentials.length > 0 ? (
						<ul className="grid gap-3" aria-label="个人 API 凭证列表">
							{state.credentials.map((credential) => <CredentialRow key={credential.credentialId} credential={credential} onRevoke={onRevoke} pending={credential.credentialId === revokingCredentialId} />)}
						</ul>
					) : null}
				</div>
			</div>
		</section>
	);
}

function CredentialRow({ credential, onRevoke, pending }: { credential: PersonalApiCredentialMetadataV1; onRevoke?: (credentialId: string) => Promise<unknown>; pending: boolean }) {
		const revoked = Boolean(credential.revokedAt);
		return (
			<li className="rounded border bg-card p-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2"><code className="text-sm [overflow-wrap:anywhere]">{credential.credentialId}</code><Badge variant="outline" data-status={revoked ? "disabled" : "available"}>{revoked ? "已撤销" : "有效"}</Badge></div>
						<dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
							<div><dt className="text-muted-foreground">权限</dt><dd>{credential.scopes.join("、")}</dd></div>
							<div><dt className="text-muted-foreground">过期时间</dt><dd>{formatDate(credential.expiresAt)}</dd></div>
							<div><dt className="text-muted-foreground">创建时间</dt><dd>{formatDate(credential.createdAt)}</dd></div>
							<div><dt className="text-muted-foreground">最近使用</dt><dd>{formatDate(credential.lastUsedAt)}</dd></div>
						</dl>
					</div>
					{!revoked && onRevoke ? <Button type="button" variant="destructive" onClick={() => void onRevoke(credential.credentialId)} disabled={pending}>{pending ? "正在撤销…" : "撤销"}</Button> : null}
				</div>
			</li>
		);
	}
}
