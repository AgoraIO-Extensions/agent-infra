import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

	useEffect(() => {
		formRef.current?.querySelector<HTMLElement>('[role="checkbox"]')?.focus();
	}, []);

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
			<fieldset disabled={busy} aria-describedby={`${id}-scope-hint`}>
				<legend className="mb-2 font-medium text-sm">保留的权限</legend>
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
							<Checkbox
								id={`${id}-${scope}`}
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
							<Label htmlFor={`${id}-${scope}`} className="font-normal">
								{personalApiCredentialScopeLabels[scope]}
							</Label>
						</div>
					))}
				</div>
				{scopeError ? (
					<Alert
						id={`${id}-scope-error`}
						variant="destructive"
						className="mt-2"
					>
						<AlertDescription>{scopeError}</AlertDescription>
					</Alert>
				) : null}
			</fieldset>
			<div className="space-y-2">
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
					<Alert id={`${id}-expiry-error`} variant="destructive">
						<AlertDescription>{expiryError}</AlertDescription>
					</Alert>
				) : null}
			</div>
			{requestError ? (
				<Alert variant="destructive">
					<AlertDescription>{requestError}</AlertDescription>
					{onRefresh ? (
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={onRefresh}
							className="mt-2"
						>
							重新加载凭证
						</Button>
					) : null}
				</Alert>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={busy}>
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
