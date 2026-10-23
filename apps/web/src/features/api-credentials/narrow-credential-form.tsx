import {
	type FormEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSubmitFocus } from "@/hooks/use-submit-focus";
import { withObjectName } from "@/lib/accessible-name";
import type {
	PersonalApiCredentialMetadataV1,
	PersonalApiCredentialNarrowRequestV1,
} from "../../pilot/generated-v2/types.gen.js";
import { personalApiCredentialScopeLabels } from "./api-credentials.js";

export type NarrowCredential = (
	credentialId: string,
	body: PersonalApiCredentialNarrowRequestV1,
) => Promise<unknown>;

function failureMessage(error: unknown) {
	const code = error instanceof Error && "code" in error ? error.code : null;
	if (
		code === "CONFLICT" ||
		code === "INVALID_REQUEST" ||
		code === "ACTION_UNAVAILABLE"
	)
		return "凭证状态已变化，请重新加载后再收窄。";
	if (code === "AUTHENTICATION_REQUIRED")
		return "登录状态已失效，请重新登录后再试。";
	if (code === "AUTHORIZATION_REVOKED")
		return "当前账号无权修改这枚凭证，请重新加载确认权限。";
	if (code === "RESOURCE_UNAVAILABLE") return "凭证已不可用，请重新加载确认。";
	return error instanceof Error && !code
		? error.message
		: "收窄凭证失败，请重试或重新加载确认状态。";
}

export function NarrowCredentialForm({
	credential,
	onNarrow,
	onCancel,
	onComplete,
	onRefresh,
	disabled = false,
}: {
	credential: PersonalApiCredentialMetadataV1;
	onNarrow: NarrowCredential;
	onCancel: () => void;
	onComplete: () => void;
	onRefresh?: () => void;
	disabled?: boolean;
}) {
	const id = useId();
	const formRef = useRef<HTMLFormElement>(null);
	const submitting = useRef(false);
	const [pending, setPending] = useState(false);
	const [scopes, setScopes] = useState(credential.scopes);
	const [expiresAt, setExpiresAt] = useState("");
	const [scopeError, setScopeError] = useState<string | null>(null);
	const [expiryError, setExpiryError] = useState<string | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);
	const busy = pending || disabled;
	const submitRef = useRef<HTMLButtonElement>(null);
	// 保存进行中「保存收窄」是可聚焦的禁用；在过期时间里按 Enter 提交时先把焦点交给它（字段随
	// fieldset 禁用）。成功后表单收起，焦点回到「收窄权限与有效期」（#3242 K7-02）。
	useSubmitFocus(pending, formRef, submitRef);
	const scopesKey = JSON.stringify(credential.scopes);
	const credentialSnapshot = useMemo(
		() => ({
			credentialId: credential.credentialId,
			scopes: JSON.parse(scopesKey) as typeof credential.scopes,
			expiresAt: credential.expiresAt,
		}),
		[credential.credentialId, scopesKey, credential.expiresAt],
	);

	useEffect(() => {
		formRef.current?.querySelector<HTMLElement>('[role="checkbox"]')?.focus();
	}, []);

	useEffect(() => {
		// A readback can update the row while this form is still mounted. Drop
		// drafts from the previous metadata snapshot so a retry cannot submit
		// stale scopes or an expiry that is no longer valid. An empty expiry
		// means "keep the current expiry", so it follows the refreshed metadata.
		setScopes(credentialSnapshot.scopes);
		setExpiresAt("");
		setScopeError(null);
		setExpiryError(null);
	}, [credentialSnapshot]);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting.current || disabled) return;
		const emptyScopes = scopes.length === 0;
		const expiryTime = expiresAt ? new Date(expiresAt).getTime() : null;
		const invalidExpiry =
			expiryTime !== null &&
			(!Number.isFinite(expiryTime) ||
				expiryTime <= Date.now() ||
				(credential.expiresAt !== null &&
					expiryTime >= new Date(credential.expiresAt).getTime()));
		setScopeError(emptyScopes ? "至少保留一项当前权限。" : null);
		setExpiryError(
			invalidExpiry ? "请选择未来的有效时间，且早于当前过期时间。" : null,
		);
		setRequestError(null);
		if (emptyScopes || invalidExpiry) {
			formRef.current
				?.querySelector<HTMLElement>(
					emptyScopes ? '[role="checkbox"]' : '[type="datetime-local"]',
				)
				?.focus();
			return;
		}
		const body: PersonalApiCredentialNarrowRequestV1 = {};
		if (scopes.length !== credential.scopes.length) body.scopes = scopes;
		if (expiryTime !== null)
			body.expiresAt = new Date(expiryTime).toISOString();
		if (!body.scopes && !body.expiresAt) {
			setRequestError("请减少权限或设置更早的过期时间。留空保留当前过期时间。");
			return;
		}
		submitting.current = true;
		setPending(true);
		try {
			await onNarrow(credential.credentialId, body);
			onComplete();
		} catch (error) {
			setRequestError(failureMessage(error));
		} finally {
			submitting.current = false;
			setPending(false);
		}
	}

	return (
		<form
			ref={formRef}
			onSubmit={submit}
			noValidate
			aria-label={`收窄凭证 ${credential.credentialId}`}
			aria-busy={busy}
			className="mt-4 space-y-4 border-t pt-4"
		>
			<p className="text-muted-foreground text-sm">
				只可减少当前权限或提前到期。留空保留当前过期时间；服务端会校验最新权限和时间。
			</p>
			{/* 多张凭证可同时展开收窄表单，分组名带凭证标识以便区分（N-12）。 */}
			<fieldset
				disabled={busy}
				aria-label={withObjectName("保留的权限", credential.credentialId)}
				aria-describedby={`${id}-scope-hint`}
			>
				<FieldLegend className="mb-2">保留的权限</FieldLegend>
				<p
					id={`${id}-scope-hint`}
					className="mb-3 text-muted-foreground text-xs"
				>
					至少保留一项，未勾选的权限将被移除。
				</p>
				<div className="grid gap-2 sm:grid-cols-2">
					{credential.scopes.map((scope) => (
						<div
							key={scope}
							className="flex min-h-11 items-center gap-2 rounded border px-3 py-2"
						>
							{/* 签发区与其他已展开的收窄表单也有同名权限复选框：名称为「{权限}：{凭证标识}」
							    （C2-19、N-12），取自下方隐藏文本，以可见标签文字开头；可见文字与点击标签切换不变。 */}
							<Checkbox
								id={`${id}-${scope}`}
								aria-labelledby={`${id}-${scope}-name`}
								checked={scopes.includes(scope)}
								disabled={busy}
								aria-invalid={Boolean(scopeError)}
								aria-describedby={
									scopeError ? `${id}-scope-error` : `${id}-scope-hint`
								}
								onCheckedChange={(checked) => {
									setScopes((current) =>
										checked
											? [...current, scope]
											: current.filter((value) => value !== scope),
									);
									setScopeError(null);
								}}
							/>
							<Label htmlFor={`${id}-${scope}`} variant="option">
								{personalApiCredentialScopeLabels[scope]}
							</Label>
							<span id={`${id}-${scope}-name`} hidden>
								{withObjectName(
									personalApiCredentialScopeLabels[scope],
									credential.credentialId,
								)}
							</span>
						</div>
					))}
				</div>
				{scopeError ? (
					<Alert
						id={`${id}-scope-error`}
						tone="danger"
						role="alert"
						className="mt-2"
					>
						<AlertDescription>{scopeError}</AlertDescription>
					</Alert>
				) : null}
			</fieldset>
			<Field>
				<Label htmlFor={`${id}-expiry`}>提前到期时间（可选）</Label>
				<Input
					id={`${id}-expiry`}
					type="datetime-local"
					value={expiresAt}
					disabled={busy}
					aria-invalid={Boolean(expiryError)}
					aria-describedby={
						expiryError ? `${id}-expiry-error` : `${id}-expiry-hint`
					}
					onChange={(event) => {
						setExpiresAt(event.target.value);
						setExpiryError(null);
					}}
				/>
				<p id={`${id}-expiry-hint`} className="text-muted-foreground text-xs">
					使用本地时间；留空不会取消或延长当前有效期。
				</p>
				{expiryError ? (
					<Alert id={`${id}-expiry-error`} tone="danger" role="alert">
						<AlertDescription>{expiryError}</AlertDescription>
					</Alert>
				) : null}
			</Field>
			{requestError ? (
				<Alert tone="danger" role="alert">
					<AlertDescription>{requestError}</AlertDescription>
					{onRefresh ? (
						<AlertAction>
							<Button
								type="button"
								variant="outline"
								disabled={busy}
								onClick={onRefresh}
							>
								重新加载凭证
							</Button>
						</AlertAction>
					) : null}
				</Alert>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					ref={submitRef}
					type="submit"
					disabled={busy}
					focusableWhenDisabled={pending}
				>
					{busy ? "正在保存…" : "保存收窄"}
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={busy}
					onClick={onCancel}
				>
					取消
				</Button>
			</div>
		</form>
	);
}
