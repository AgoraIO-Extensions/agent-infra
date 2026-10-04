import { WecomApplicationCredentialsV1Schema } from "@agent-infra/contracts/pilot";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	beginWecomAppSetup,
	cancelWecomAppSetup,
	getWecomAppConnection,
	getWecomAppSetup,
	submitWecomAppCredentials,
} from "../../pilot/generated/sdk.gen.js";
import type { AgentConfigurationUpdateRequestV2Writable } from "../../pilot/generated-v2/types.gen.js";

const labels = {
	not_configured: "未配置",
	callback: "已配置回调模式",
	verifying: "验证中",
	connected: "已连接",
	disconnected: "已断开",
	auth_failed: "认证失败",
} as const;

type SetupStatus = keyof typeof labels;

export function WecomAppSetup({
	agentId,
	onUnbind,
}: {
	agentId: string;
	onUnbind: (body: AgentConfigurationUpdateRequestV2Writable) => void;
}) {
	const [corporationId, setCorporationId] = useState("");
	const [applicationId, setApplicationId] = useState("");
	const [secret, setSecret] = useState("");
	const [token, setToken] = useState("");
	const [encodingAesKey, setEncodingAesKey] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<SetupStatus>();
	const [callbackUrl, setCallbackUrl] = useState("");
	const [error, setError] = useState("");
	const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
	const session = useRef<{ id: string } | undefined>(undefined);
	const generation = useRef(0);
	const refreshSequence = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const connectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: poll reads refs and stable props
	const refresh = useCallback(async () => {
		clearTimeout(connectionTimer.current);
		const attempt = generation.current;
		const sequence = ++refreshSequence.current;
		try {
			const result = await getWecomAppConnection({
				path: { agentId },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (
				attempt !== generation.current ||
				sequence !== refreshSequence.current
			)
				return;
			setStatus(result.data?.status);
			setCallbackUrl(result.data?.callbackUrl ?? "");
			if (result.data?.status === "verifying" && result.data.sessionId) {
				session.current = { id: result.data.sessionId };
				setBusy(true);
				void poll(attempt);
			}
			if (
				result.data?.status === "disconnected" ||
				(result.data?.status === "verifying" && !result.data.sessionId)
			)
				connectionTimer.current = setTimeout(() => void refresh(), 2000);
		} catch {
			if (
				attempt === generation.current &&
				sequence === refreshSequence.current
			)
				setStatus(undefined);
		}
	}, [agentId]);

	useEffect(() => {
		generation.current++;
		session.current = undefined;
		setCorporationId("");
		setApplicationId("");
		setSecret("");
		setToken("");
		setEncodingAesKey("");
		setConfirmed(false);
		setBusy(false);
		setStatus(undefined);
		setCallbackUrl("");
		setError("");
		void refresh();
		return () => {
			generation.current++;
			clearTimeout(timer.current);
			clearTimeout(connectionTimer.current);
		};
	}, [refresh]);

	async function poll(attempt: number) {
		const currentSession = session.current;
		if (attempt !== generation.current || !currentSession) return;
		try {
			const result = await getWecomAppSetup({
				path: { agentId, sessionId: currentSession.id },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (attempt !== generation.current || session.current !== currentSession)
				return;
			if (!result.data) throw new Error();
			const next = result.data.status;
			if (next === "awaiting_input" || next === "verifying") {
				setStatus("verifying");
				setError(
					next === "awaiting_input"
						? "提交结果尚未确认，可取消本次配置后重试。"
						: "",
				);
			} else {
				session.current = undefined;
				setBusy(false);
				setStatus(
					next === "active"
						? "connected"
						: next === "auth_failed"
							? "auth_failed"
							: undefined,
				);
				setError(next === "active" ? "" : "绑定未完成，请检查应用凭证后重试。");
				await refresh();
				return;
			}
		} catch {
			if (attempt === generation.current)
				setError("配置结果暂未确认，正在重新查询。请勿重复提交。");
		}
		if (attempt === generation.current && session.current === currentSession)
			timer.current = setTimeout(() => void poll(attempt), 2000);
	}

	async function submit() {
		if (busy) return;
		const validation = WecomApplicationCredentialsV1Schema.safeParse({
			corporationId: corporationId.trim(),
			applicationId: applicationId.trim(),
			secret,
			token,
			encodingAesKey,
			state: "pending",
			takeoverConfirmed: confirmed,
		});
		const invalid: Record<string, string> = {};
		if (!validation.success)
			for (const issue of validation.error.issues)
				invalid[String(issue.path[0])] = "请填写符合格式的值。";
		if (!confirmed) invalid.takeoverConfirmed = "请确认连接影响。";
		setFieldErrors(invalid);
		if (Object.keys(invalid).length) {
			setError("请检查标出的字段并确认连接影响。");
			return;
		}

		const credentials = {
			corporationId: corporationId.trim(),
			applicationId: applicationId.trim(),
			secret,
			token,
			encodingAesKey,
		};
		setSecret("");
		setToken("");
		setEncodingAesKey("");
		setError("");
		setFieldErrors({});
		setBusy(true);
		refreshSequence.current++;
		clearTimeout(connectionTimer.current);
		setStatus("verifying");
		const attempt = generation.current;
		try {
			const started = await beginWecomAppSetup({
				path: { agentId },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (attempt !== generation.current || !started.data) throw new Error();
			session.current = {
				id: started.data.sessionId,
			};
			setCallbackUrl(started.data.callbackUrl);
			const submitted = await submitWecomAppCredentials({
				path: { agentId, sessionId: started.data.sessionId },
				body: {
					...credentials,
					state: started.data.state,
					takeoverConfirmed: true,
				},
				responseStyle: "fields",
				throwOnError: false,
			});
			if (attempt !== generation.current) return;
			const code = submitted.response?.status;
			if (
				!submitted.data &&
				code !== undefined &&
				code >= 400 &&
				code < 500 &&
				code !== 408 &&
				code !== 429
			) {
				setError("凭证提交被拒绝，正在查询配置状态；可取消本次配置后重试。");
				await poll(attempt);
				return;
			}
		} catch {
			if (attempt === generation.current && !session.current) {
				setBusy(false);
				setError("暂时无法开始配置，请重试。");
				await refresh();
			}
		}
		credentials.secret = "";
		credentials.token = "";
		credentials.encodingAesKey = "";
		if (attempt === generation.current && session.current) await poll(attempt);
	}

	async function cancel() {
		const currentSession = session.current;
		const attempt = generation.current;
		if (!currentSession) return;
		try {
			const result = await cancelWecomAppSetup({
				path: { agentId, sessionId: currentSession.id },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (attempt !== generation.current || session.current !== currentSession)
				return;
			if (result.data?.status !== "cancelled") throw new Error();
			generation.current++;
			clearTimeout(timer.current);
			session.current = undefined;
			setBusy(false);
			setError("");
			await refresh();
		} catch {
			if (attempt === generation.current && session.current === currentSession)
				setError("取消结果未确认，正在继续查询配置状态。");
		}
	}

	return (
		<section
			aria-label="自建应用配置"
			className="space-y-4 rounded-lg border border-border p-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 className="font-semibold">自建应用</h3>
				<p aria-live="polite" className="text-sm">
					{status ? labels[status] : "连接状态暂不可用"}
				</p>
			</div>
			{callbackUrl ? (
				<p className="break-all text-muted-foreground text-sm">
					请在企微后台配置回调 URL：{callbackUrl}
				</p>
			) : null}
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="wecom-app-corporation-id">企业 ID</Label>
					<Input
						id="wecom-app-corporation-id"
						aria-invalid={!!fieldErrors.corporationId}
						aria-describedby={
							fieldErrors.corporationId
								? "wecom-app-corporation-id-error"
								: undefined
						}
						value={corporationId}
						disabled={busy}
						onChange={(e) => setCorporationId(e.target.value)}
						autoComplete="off"
					/>
					{fieldErrors.corporationId ? (
						<p
							id="wecom-app-corporation-id-error"
							className="text-destructive text-sm"
						>
							{fieldErrors.corporationId}
						</p>
					) : null}
				</div>
				<div className="space-y-2">
					<Label htmlFor="wecom-app-application-id">应用 ID</Label>
					<Input
						id="wecom-app-application-id"
						aria-invalid={!!fieldErrors.applicationId}
						aria-describedby={
							fieldErrors.applicationId
								? "wecom-app-application-id-error"
								: undefined
						}
						value={applicationId}
						disabled={busy}
						onChange={(e) => setApplicationId(e.target.value)}
						inputMode="numeric"
						autoComplete="off"
					/>
					{fieldErrors.applicationId ? (
						<p
							id="wecom-app-application-id-error"
							className="text-destructive text-sm"
						>
							{fieldErrors.applicationId}
						</p>
					) : null}
				</div>
				<div className="space-y-2">
					<Label htmlFor="wecom-app-secret">应用 Secret</Label>
					<Input
						id="wecom-app-secret"
						aria-invalid={!!fieldErrors.secret}
						aria-describedby={
							fieldErrors.secret ? "wecom-app-secret-error" : undefined
						}
						type="password"
						value={secret}
						disabled={busy}
						onChange={(e) => setSecret(e.target.value)}
						autoComplete="new-password"
					/>
					{fieldErrors.secret ? (
						<p id="wecom-app-secret-error" className="text-destructive text-sm">
							{fieldErrors.secret}
						</p>
					) : null}
				</div>
				<div className="space-y-2">
					<Label htmlFor="wecom-app-token">回调 Token</Label>
					<Input
						id="wecom-app-token"
						aria-invalid={!!fieldErrors.token}
						aria-describedby={
							fieldErrors.token ? "wecom-app-token-error" : undefined
						}
						type="password"
						value={token}
						disabled={busy}
						onChange={(e) => setToken(e.target.value)}
						autoComplete="new-password"
					/>
					{fieldErrors.token ? (
						<p id="wecom-app-token-error" className="text-destructive text-sm">
							{fieldErrors.token}
						</p>
					) : null}
				</div>
				<div className="space-y-2 sm:col-span-2">
					<Label htmlFor="wecom-app-encoding-aes-key">EncodingAESKey</Label>
					<Input
						id="wecom-app-encoding-aes-key"
						aria-invalid={!!fieldErrors.encodingAesKey}
						aria-describedby={
							fieldErrors.encodingAesKey
								? "wecom-app-encoding-aes-key-error"
								: undefined
						}
						type="password"
						value={encodingAesKey}
						disabled={busy}
						onChange={(e) => setEncodingAesKey(e.target.value)}
						autoComplete="new-password"
					/>
					{fieldErrors.encodingAesKey ? (
						<p
							id="wecom-app-encoding-aes-key-error"
							className="text-destructive text-sm"
						>
							{fieldErrors.encodingAesKey}
						</p>
					) : null}
				</div>
			</div>
			<Label className="min-h-11 flex-nowrap items-start gap-3 text-sm leading-6">
				<Checkbox
					id="wecom-app-takeover"
					className="mt-1"
					checked={confirmed}
					disabled={busy}
					aria-invalid={!!fieldErrors.takeoverConfirmed}
					aria-describedby={
						fieldErrors.takeoverConfirmed
							? "wecom-app-takeover-error"
							: undefined
					}
					onCheckedChange={(value) => setConfirmed(value === true)}
				/>
				<span>我已知悉：连接此应用可能影响其在其他服务中的现有配置。</span>
			</Label>
			{fieldErrors.takeoverConfirmed ? (
				<p id="wecom-app-takeover-error" className="text-destructive text-sm">
					{fieldErrors.takeoverConfirmed}
				</p>
			) : null}
			<p className="text-muted-foreground text-sm">
				输入框中的 Secret、Token 和 EncodingAESKey
				提交后清空；平台加密保存用于渠道收发。
			</p>
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex flex-wrap gap-3">
				<Button type="button" disabled={busy} onClick={() => void submit()}>
					{busy ? "验证中…" : "验证并绑定"}
				</Button>
				{busy ? (
					<Button type="button" variant="outline" onClick={() => void cancel()}>
						取消配置
					</Button>
				) : null}
				<Button
					type="button"
					variant="outline"
					disabled={busy}
					onClick={() => void refresh()}
				>
					刷新状态
				</Button>
				{status && status !== "not_configured" ? (
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() => {
							setStatus("not_configured");
							setCallbackUrl("");
							onUnbind({
								schemaVersion: 2,
								channels: [{ kind: "wecom_app", enabled: false }],
							});
						}}
					>
						解除应用绑定
					</Button>
				) : null}
			</div>
		</section>
	);
}
