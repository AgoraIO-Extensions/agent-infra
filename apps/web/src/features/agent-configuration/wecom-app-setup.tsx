import { WecomApplicationCredentialsV1Schema } from "@agent-infra/contracts/pilot";
import { Layers } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import {
	beginWecomAppSetup,
	cancelWecomAppSetup,
	getWecomAppConnection,
	getWecomAppSetup,
	submitWecomAppCredentials,
} from "../../pilot/generated/sdk.gen.js";
import {
	useWecomUnbind,
	WecomChannelCard,
	type WecomChannelStatus,
	WecomUnbindAction,
	WecomUnbindFailure,
} from "./wecom-channel-card.js";

// 卡片标题即页面上的对象名，用于区分两张企微卡片里的同名按钮（N-12、NI-107）。
const setupTitle = "企微应用";

type SetupStatus = WecomChannelStatus;

export function WecomAppSetup({
	agentId,
	unbindChannel,
}: {
	agentId: string;
	/** 独立的解绑请求（只含 wecom_app disabled）；未提供时不显示解绑入口。 */
	unbindChannel?: () => Promise<void>;
}) {
	const toast = useToast();
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
	const titleRef = useRef<HTMLHeadingElement>(null);

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
	const unbind = useWecomUnbind({
		title: setupTitle,
		unbindChannel,
		onUnbound: () => {
			// 服务端已确认解除：先显示未配置，再回读连接状态（请求前不预置未配置）。
			refreshSequence.current++;
			setStatus("not_configured");
			setCallbackUrl("");
			void refresh();
		},
	});

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
				// 设计：绑定成功后给 Toast「企微应用已连接」（W-26）。
				if (next === "active") toast(`${setupTitle}已连接`);
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

	const locked = busy || unbind.pending;
	const submitLabel = busy ? "验证中…" : "验证并绑定";
	return (
		<WecomChannelCard
			icon={Layers}
			status={status}
			subtitle="应用入口 · 支持回调验证"
			title={setupTitle}
			titleId="wecom-app-title"
			titleRef={titleRef}
		>
			{/* 设计 renderWecomApp 文案（W-21）。 */}
			<p className="wecom-channel-copy">
				配置企业 ID、应用 ID 和回调材料。验证期间保留原绑定，Secret
				类字段只保存密文状态。
			</p>
			<div className="wecom-channel-fields">
				<Field>
					<Label htmlFor="wecom-app-corporation-id">企业 ID</Label>
					<Input
						id="wecom-app-corporation-id"
						placeholder="输入企业 ID"
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
				</Field>
				<Field>
					<Label htmlFor="wecom-app-application-id">应用 ID</Label>
					{/* Owner 配置同页还有授权目标的「应用 ID」，名称带卡片标题以便区分（N-12）。 */}
					<Input
						id="wecom-app-application-id"
						placeholder="输入应用 ID"
						aria-label={withObjectName("应用 ID", setupTitle)}
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
				</Field>
				<Field>
					<Label htmlFor="wecom-app-secret">应用 Secret</Label>
					<Input
						id="wecom-app-secret"
						placeholder="仅本次提交使用"
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
				</Field>
				<Field>
					<Label htmlFor="wecom-app-token">回调 Token</Label>
					<Input
						id="wecom-app-token"
						placeholder="输入回调 Token"
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
				</Field>
				<Field>
					<Label htmlFor="wecom-app-encoding-aes-key">EncodingAESKey</Label>
					<Input
						id="wecom-app-encoding-aes-key"
						placeholder="输入 43 位密钥"
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
				</Field>
			</div>
			{/* 设计 .check：44px 行内垂直居中，紧接字段（W-20、W-21）。 */}
			<Label variant="option">
				<Checkbox
					id="wecom-app-takeover"
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
				<span className="min-w-0">我已知悉可能影响现有回调</span>
			</Label>
			{fieldErrors.takeoverConfirmed ? (
				<p id="wecom-app-takeover-error" className="text-destructive text-sm">
					{fieldErrors.takeoverConfirmed}
				</p>
			) : null}
			{callbackUrl ? (
				<p className="wecom-channel-callback">
					<strong>请在企微后台配置回调 URL</strong>
					{callbackUrl}
				</p>
			) : null}
			{error ? (
				<Alert tone="danger" role="alert">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<WecomUnbindFailure unbind={unbind} />
			<div className="wecom-channel-actions">
				<Button
					type="button"
					disabled={locked}
					aria-label={withObjectName(submitLabel, setupTitle)}
					onClick={() => void submit()}
				>
					{submitLabel}
				</Button>
				{busy ? (
					<Button
						type="button"
						variant="outline"
						aria-label={withObjectName("取消配置", setupTitle)}
						onClick={() => void cancel()}
					>
						取消配置
					</Button>
				) : null}
				<Button
					type="button"
					variant="ghost"
					disabled={locked}
					aria-label={withObjectName("刷新状态", setupTitle)}
					onClick={() => void refresh()}
				>
					刷新状态
				</Button>
				{unbind.available && status && status !== "not_configured" && !busy ? (
					<WecomUnbindAction
						disabled={locked}
						kind="app"
						title={setupTitle}
						titleRef={titleRef}
						unbind={unbind}
					/>
				) : null}
			</div>
		</WecomChannelCard>
	);
}
