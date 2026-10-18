import { AlertCircle, Building2, RefreshCw, ShieldOff } from "lucide-react";
import {
	type FormEvent,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingLine } from "@/components/ui/spinner";
import { Timestamp } from "@/components/ui/timestamp";
import { withObjectName } from "@/lib/accessible-name";
import type { ApplicationMetadataV1 } from "../../pilot/generated-v2/types.gen.js";
import {
	type PersonalApiCredentialScope,
	personalApiCredentialScopeLabels,
	personalApiCredentialScopes,
} from "../api-credentials/api-credentials.js";
import {
	DirectoryNameText,
	DirectoryReadAlert,
	useDirectoryNames,
} from "../directory-names.js";
import { ApplicationCredentialResult } from "./application-credential-result.js";
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
	onOpenApplication?: (applicationId: string) => void;
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
	onOpenApplication,
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
	const [applicationId, setApplicationId] = useState("");
	const focusTitleAfterDisable = useRef(false);

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
				<Alert
					tone="danger"
					role="alert"
					icon={<AlertCircle aria-hidden="true" />}
				>
					<AlertDescription>
						{errorMessage(actionError, "应用操作失败，请稍后重试。")}
					</AlertDescription>
				</Alert>
			) : null}
			{onOpenApplication && state.kind !== "denied" ? (
				<form
					className="max-w-xl space-y-4 rounded border bg-card p-5"
					onSubmit={(event) => {
						event.preventDefault();
						if (applicationId.trim()) onOpenApplication(applicationId.trim());
					}}
				>
					<h2 className="font-semibold text-base">打开既有应用</h2>
					<Field>
						<Label htmlFor={`${headingId}-application`}>既有应用 ID</Label>
						<Input
							id={`${headingId}-application`}
							value={applicationId}
							onChange={(event) => setApplicationId(event.target.value)}
							required
							aria-describedby={`${headingId}-application-hint`}
						/>
						<p
							id={`${headingId}-application-hint`}
							className="text-muted-foreground text-sm"
						>
							输入你负责的应用 ID，读取详情后再管理凭证。
						</p>
					</Field>
					<Button type="submit" disabled={!applicationId.trim()}>
						打开应用
					</Button>
				</form>
			) : null}

			{state.kind === "loading" ? (
				<LoadingLine className="py-8">正在读取应用…</LoadingLine>
			) : null}
			{state.kind === "denied" ? (
				<Alert tone="warn">
					<AlertDescription>当前账号无权管理应用。</AlertDescription>
				</Alert>
			) : null}
			{state.kind === "unavailable" ? (
				<Alert tone="danger" role="alert">
					<AlertDescription>{unavailableMessage(state)}</AlertDescription>
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
					<Field>
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
					</Field>
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
					key={JSON.stringify([
						state.application.applicationId,
						state.application.authorizationRevision,
						state.application.status,
					])}
					application={state.application}
					onDisable={
						onDisable
							? (applicationId) => {
									focusTitleAfterDisable.current = true;
									return onDisable(applicationId).catch((error: unknown) => {
										// 停用失败时不保留焦点标记，避免之后的状态变化抢焦点。
										focusTitleAfterDisable.current = false;
										throw error;
									});
								}
							: undefined
					}
					consumeTitleFocus={() => {
						const pendingFocus = focusTitleAfterDisable.current;
						focusTitleAfterDisable.current = false;
						return pendingFocus;
					}}
					isDisabling={isDisabling}
					onIssueCredential={onIssueCredential}
					isIssuingCredential={isIssuingCredential}
				/>
			) : null}
		</section>
	);
}

type ApplicationDetailsProps = {
	application: ApplicationMetadataV1;
	onDisable?: (applicationId: string) => Promise<ApplicationMetadataV1>;
	// 停用成功后详情会按新状态重新挂载，由它把焦点放回应用名标题。
	consumeTitleFocus?: () => boolean;
	isDisabling: boolean;
	onIssueCredential?: ApplicationManagementScreenProps["onIssueCredential"];
	isIssuingCredential: boolean;
};

function ApplicationDetails(props: ApplicationDetailsProps) {
	const { application } = props;
	const id = useId();
	const disabled = application.status === "disabled";
	const title = useRef<HTMLHeadingElement>(null);
	const { consumeTitleFocus } = props;
	useEffect(() => {
		if (disabled && consumeTitleFocus?.()) title.current?.focus();
	}, [consumeTitleFocus, disabled]);
	const active = useRef(false);
	const pending = useRef(false);
	const [recipientType, setRecipientType] = useState<"user" | "application">(
		"user",
	);
	const [recipientId, setRecipientId] = useState("");
	const [credentialId, setCredentialId] = useState("");
	const [scopes, setScopes] =
		useState<PersonalApiCredentialScope[]>(defaultScopes);
	const [expiresAt, setExpiresAt] = useState("");
	const [operation, setOperation] = useState<"issue" | "rotate">("issue");
	const [credentialResult, setCredentialResult] =
		useState<ApplicationCredentialResponse | null>(null);
	const [submitting, setSubmitting] = useState(false);
	// 负责人与凭证接收用户合并读取一次目录，页面不显示用户 ID。
	const recipient = credentialResult?.delivery.recipient;
	const userNames = useDirectoryNames("user", [
		application.responsibleUserId,
		...(recipient?.principalType === "user" ? [recipient.principalId] : []),
	]);
	useLayoutEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);

	async function submitCredential(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (
			disabled ||
			pending.current ||
			props.isIssuingCredential ||
			!props.onIssueCredential ||
			scopes.length === 0 ||
			!recipientId.trim()
		)
			return;
		if (operation === "rotate" && !credentialId.trim()) return;
		const request = {
			recipient: {
				principalType: recipientType,
				principalId: recipientId.trim(),
			},
			scopes,
			expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
		};
		const body: ApplicationCredentialRequest =
			operation === "issue"
				? { ...request, operation }
				: { ...request, operation, credentialId: credentialId.trim() };
		pending.current = true;
		setSubmitting(true);
		setCredentialResult(null);
		try {
			const result = await props.onIssueCredential({
				applicationId: application.applicationId,
				body,
			});
			if (
				active.current &&
				result.metadata.applicationId === application.applicationId
			) {
				setCredentialResult(result);
			}
		} catch {
			// The owner renders mutation errors through actionError.
		} finally {
			pending.current = false;
			if (active.current) setSubmitting(false);
		}
	}

	function toggleScope(scope: PersonalApiCredentialScope) {
		setScopes((current) =>
			current.includes(scope)
				? current.filter((value) => value !== scope)
				: [...current, scope],
		);
	}

	function prepareRotation() {
		if (!credentialResult) return;
		setOperation("rotate");
		setCredentialId(credentialResult.metadata.credentialId);
		setRecipientType(credentialResult.delivery.recipient.principalType);
		setRecipientId(credentialResult.delivery.recipient.principalId);
		setScopes(credentialResult.metadata.scopes);
		const expiry = credentialResult.metadata.expiresAt;
		setExpiresAt(
			expiry
				? new Date(
						new Date(expiry).getTime() -
							new Date(expiry).getTimezoneOffset() * 60_000,
					)
						.toISOString()
						.slice(0, -1)
				: "",
		);
	}
	return (
		<div className="space-y-6">
			<div className="rounded border bg-card p-5">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<div className="flex flex-wrap items-center gap-2">
							<h2 ref={title} tabIndex={-1} className="font-semibold text-lg">
								{application.name}
							</h2>
							<Badge tone={disabled ? "red" : "green"}>
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
						<ConfirmDialog
							disabled={props.isDisabling}
							trigger={
								<Button
									variant="outline"
									type="button"
									aria-label={withObjectName(
										props.isDisabling ? "正在停用…" : "停用应用",
										application.name,
									)}
								>
									<ShieldOff aria-hidden="true" />
									{props.isDisabling ? "正在停用…" : "停用应用"}
								</Button>
							}
							title="停用这个应用？"
							subject={{ name: application.name }}
							description="停用后平台拒绝该应用的新任务，并向进行中的任务发出取消请求；已发生的外部效果不会撤回。"
							confirmLabel="停用应用"
							finalFocus={title}
							onConfirm={() =>
								// 失败由 actionError 就地呈现。
								void props
									.onDisable?.(application.applicationId)
									.catch(() => undefined)
							}
						/>
					) : null}
				</div>
				<dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
					<div>
						<dt className="text-muted-foreground">负责人</dt>
						<dd>
							<DirectoryNameText
								name={userNames.resolve(application.responsibleUserId)}
								status={userNames.status}
							/>
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">创建时间</dt>
						<dd>
							<Timestamp value={application.createdAt} />
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">更新时间</dt>
						<dd>
							<Timestamp value={application.updatedAt} />
						</dd>
					</div>
				</dl>
			</div>
			<DirectoryReadAlert names={[userNames]} />
			{credentialResult ? (
				<ApplicationCredentialResult
					names={userNames}
					result={credentialResult}
					onPrepareRotation={
						props.onIssueCredential ? prepareRotation : undefined
					}
				/>
			) : null}
			{disabled ? (
				<Empty>
					<EmptyTitle>应用已停用</EmptyTitle>
					<EmptyDescription>停用后不能再签发或轮换应用凭证。</EmptyDescription>
				</Empty>
			) : (
				<form
					className="max-w-3xl space-y-5 rounded border bg-card p-5"
					onSubmit={submitCredential}
				>
					<div>
						<h2 className="font-semibold text-base">应用凭证元数据</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							当前接口只返回元数据和投递状态。请先由管理员授予 recipient
							获取材料的权限。
						</p>
					</div>
					<fieldset className="space-y-3">
						<FieldLegend>操作</FieldLegend>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								aria-pressed={operation === "issue"}
								variant={operation === "issue" ? "secondary" : "outline"}
								onClick={() => setOperation("issue")}
							>
								签发
							</Button>
							<Button
								type="button"
								aria-pressed={operation === "rotate"}
								variant={operation === "rotate" ? "secondary" : "outline"}
								onClick={() => setOperation("rotate")}
							>
								轮换
							</Button>
						</div>
					</fieldset>
					{operation === "rotate" ? (
						<Field>
							<Label htmlFor={`${id}-credential`}>要轮换的凭证 ID</Label>
							<Input
								id={`${id}-credential`}
								value={credentialId}
								onChange={(event) => setCredentialId(event.target.value)}
								required
							/>
						</Field>
					) : null}
					<div className="grid gap-4 sm:grid-cols-2">
						<fieldset className="space-y-2">
							<FieldLegend>接收主体类型</FieldLegend>
							<div className="flex gap-2">
								<Button
									type="button"
									aria-pressed={recipientType === "user"}
									variant={recipientType === "user" ? "secondary" : "outline"}
									onClick={() => setRecipientType("user")}
								>
									用户
								</Button>
								<Button
									type="button"
									aria-pressed={recipientType === "application"}
									variant={
										recipientType === "application" ? "secondary" : "outline"
									}
									onClick={() => setRecipientType("application")}
								>
									应用
								</Button>
							</div>
						</fieldset>
						<Field>
							<Label htmlFor={`${id}-recipient`}>接收主体 ID</Label>
							<Input
								id={`${id}-recipient`}
								value={recipientId}
								onChange={(event) => setRecipientId(event.target.value)}
								required
							/>
						</Field>
					</div>
					<fieldset className="space-y-3">
						<FieldLegend>权限范围</FieldLegend>
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
											checked={scopes.includes(scope)}
											onCheckedChange={() => toggleScope(scope)}
										/>
										<Label htmlFor={checkboxId} variant="option">
											{personalApiCredentialScopeLabels[scope]}
										</Label>
										<code className="ml-auto text-[11px] text-muted-foreground">
											{scope}
										</code>
									</div>
								);
							})}
						</div>
						{scopes.length === 0 ? (
							<Alert tone="danger" role="alert">
								<AlertDescription>至少选择一项权限范围。</AlertDescription>
							</Alert>
						) : null}
					</fieldset>
					<Field>
						<Label htmlFor={`${id}-expiry`}>过期时间（可选）</Label>
						<Input
							id={`${id}-expiry`}
							type="datetime-local"
							step="0.001"
							value={expiresAt}
							onChange={(event) => setExpiresAt(event.target.value)}
						/>
					</Field>
					<Button
						type="submit"
						disabled={
							!props.onIssueCredential ||
							scopes.length === 0 ||
							!recipientId.trim() ||
							(operation === "rotate" && !credentialId.trim()) ||
							props.isIssuingCredential ||
							submitting
						}
					>
						{props.isIssuingCredential || submitting
							? "正在提交…"
							: operation === "issue"
								? "签发应用凭证"
								: "轮换应用凭证"}
					</Button>
				</form>
			)}
		</div>
	);
}
