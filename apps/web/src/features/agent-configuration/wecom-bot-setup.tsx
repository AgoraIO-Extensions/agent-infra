import { Info, MessageCircle, Scan, Settings } from "lucide-react";
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
	beginWecomSetup,
	cancelWecomSetup,
	getWecomBotConnectionV2,
	getWecomSetup,
	submitWecomCredentials,
} from "../../pilot/generated/sdk.gen.js";
import type {
	BeginWecomSetupResponse,
	GetWecomBotConnectionV2Response,
} from "../../pilot/generated/types.gen.js";
import {
	useWecomUnbind,
	WecomChannelCard,
	type WecomChannelStatus,
	WecomUnbindAction,
	WecomUnbindFailure,
} from "./wecom-channel-card.js";
import {
	openWecomQrAuthorizationV1,
	type WecomQrAuthorizationResultV1,
} from "./wecom-qr-authorization.js";

// 卡片标题即页面上的对象名，用于区分两张企微卡片里的同名按钮（N-12、NI-107）。
const setupTitle = "企微机器人";

type QrUnavailableSession = Extract<
	BeginWecomSetupResponse,
	{ qrAvailable: false }
>;
type QrAvailableSession = Extract<
	BeginWecomSetupResponse,
	{ qrAvailable: true }
>;

// 扫码面板：能力由服务端状态 V2 判定（O-08、#2911），不可用时不建立 setup session、
// 不打开窗口、不伪造绑定成功。
// 扫码完成后先在面板内确认连接影响（confirming），确认前不提交凭证（CK-09、PRD §10.2）。
type QrPanel =
	| { readonly phase: "closed" }
	| { readonly phase: "checking" }
	| {
			readonly phase: "unavailable";
			readonly reason: QrUnavailableSession["qrUnavailableReason"] | null;
	  }
	| { readonly phase: "available"; readonly started: QrAvailableSession }
	| { readonly phase: "authorizing" }
	| { readonly phase: "confirming"; readonly started: QrAvailableSession };

// 扫码能力只取服务端的明确结论；读不到或形状不符时视为未知，不据此建立 setup session。
type QrCapability =
	| { readonly available: true }
	| {
			readonly available: false;
			readonly reason: QrUnavailableSession["qrUnavailableReason"] | null;
	  };

function qrCapabilityOf(
	data: GetWecomBotConnectionV2Response | undefined,
): QrCapability | undefined {
	if (data?.qrAvailable === true) return { available: true };
	if (data?.qrAvailable === false)
		return {
			available: false,
			reason:
				data.qrUnavailableReason === "authorization_correlation_unverified"
					? data.qrUnavailableReason
					: null,
		};
	return undefined;
}

// 原因只显示中文说明，不外露服务端枚举值。
function qrUnavailableCopy(
	reason: QrUnavailableSession["qrUnavailableReason"] | null,
) {
	return reason === "authorization_correlation_unverified"
		? "当前平台尚未完成授权关联校验。"
		: "当前部署未启用扫码授权。";
}

export function WecomBotSetup({
	agentId,
	unbindChannel,
}: {
	agentId: string;
	/** 独立的解绑请求（只含 wecom_bot disabled）；未提供时不显示解绑入口。 */
	unbindChannel?: () => Promise<void>;
}) {
	const toast = useToast();
	const [botId, setBotId] = useState("");
	const [secret, setSecret] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<WecomChannelStatus>();
	const [error, setError] = useState("");
	const [qr, setQr] = useState<QrPanel>({ phase: "closed" });
	// 首次点击前由连接状态 V2 给出扫码能力；已知不可用时打开面板不创建 setup session。
	const [qrCapability, setQrCapability] = useState<QrCapability>();
	const session = useRef<string | undefined>(undefined);
	const generation = useRef(0);
	const refreshSequence = useRef(0);
	const qrAbort = useRef<AbortController | undefined>(undefined);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const connectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const qrTriggerRef = useRef<HTMLButtonElement>(null);
	const qrConfirmRef = useRef<HTMLButtonElement>(null);
	// 扫码结果只放在内存里等待 Owner 确认，不进入 React 状态；提交、取消或卸载时清空 Secret。
	const qrResult = useRef<WecomQrAuthorizationResultV1 | undefined>(undefined);
	const discardQrResult = useCallback(() => {
		if (qrResult.current) qrResult.current.secret = "";
		qrResult.current = undefined;
	}, []);
	const refresh = useCallback(
		async function refreshConnection() {
			clearTimeout(connectionTimer.current);
			const attempt = generation.current;
			const sequence = ++refreshSequence.current;
			try {
				const result = await getWecomBotConnectionV2({
					path: { agentId },
					responseStyle: "fields",
					throwOnError: false,
				});
				if (
					attempt === generation.current &&
					sequence === refreshSequence.current
				) {
					const next = result.data?.status;
					setStatus(next);
					// 读取失败时保留已知的扫码能力；建立 setup session 的响应仍会再判定一次。
					const capability = qrCapabilityOf(result.data);
					if (capability) setQrCapability(capability);
					if (next === "verifying" || next === "disconnected")
						connectionTimer.current = setTimeout(() => {
							void refreshConnection();
						}, 2000);
				}
			} catch {
				if (
					attempt === generation.current &&
					sequence === refreshSequence.current
				)
					setStatus(undefined);
			}
		},
		[agentId],
	);
	const unbind = useWecomUnbind({
		title: setupTitle,
		unbindChannel,
		onUnbound: () => {
			// 服务端已确认解除：先显示未配置，再回读连接状态。
			refreshSequence.current++;
			setStatus("not_configured");
			void refresh();
		},
	});
	useEffect(() => {
		generation.current++;
		session.current = undefined;
		discardQrResult();
		setBotId("");
		setSecret("");
		setConfirmed(false);
		setBusy(false);
		setStatus(undefined);
		setError("");
		setQr({ phase: "closed" });
		setQrCapability(undefined);
		void refresh();
		return () => {
			generation.current++;
			discardQrResult();
			qrAbort.current?.abort();
			clearTimeout(timer.current);
			clearTimeout(connectionTimer.current);
		};
	}, [refresh, discardQrResult]);
	// 扫码完成进入确认步骤时，焦点落在面板内的确认按钮上（按钮通过 aria-describedby 读出影响说明）。
	useEffect(() => {
		if (qr.phase === "confirming") qrConfirmRef.current?.focus();
	}, [qr.phase]);
	async function poll(attempt: number) {
		if (attempt !== generation.current || !session.current) return;
		try {
			const current = await getWecomSetup({
				path: { agentId, sessionId: session.current },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (attempt !== generation.current) return;
			if (!current.data) throw new Error();
			if (["verifying", "awaiting_input"].includes(current.data.status)) {
				setError(
					current.data.status === "awaiting_input"
						? "提交结果尚未确认，可取消本次配置后重试。"
						: "",
				);
			} else {
				setBusy(false);
				session.current = undefined;
				const active = current.data.status === "active";
				setError(active ? "" : "绑定未完成，请检查凭证后重试。");
				// 设计：手动与扫码绑定成功后都给 Toast「企微机器人已连接」（W-26）。
				if (active) toast(`${setupTitle}已连接`);
				await refresh();
				return;
			}
		} catch {
			if (attempt !== generation.current) return;
			setStatus(undefined);
			setError("配置结果暂未确认，正在重新查询。请勿重复提交。");
		}
		timer.current = setTimeout(() => {
			void poll(attempt);
		}, 2000);
	}
	async function submit() {
		if (busy) return;
		if (!botId.trim() || !secret || !confirmed) {
			setError("请填写 Bot ID、Secret，并确认连接影响。");
			return;
		}
		let credential = secret;
		setSecret("");
		setError("");
		setBusy(true);
		refreshSequence.current++;
		clearTimeout(connectionTimer.current);
		setStatus("verifying");
		const attempt = generation.current;
		try {
			const started = await beginWecomSetup({
				path: { agentId },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (attempt !== generation.current) return;
			if (!started.data) throw new Error();
			session.current = started.data.sessionId;
			const submitted = await submitWecomCredentials({
				path: { agentId, sessionId: started.data.sessionId },
				body: {
					state: started.data.state,
					botId: botId.trim(),
					secret: credential,
					takeoverConfirmed: true,
				},
				responseStyle: "fields",
				throwOnError: false,
			});
			if (attempt !== generation.current) return;
			const statusCode = submitted.response?.status;
			if (
				!submitted.data &&
				statusCode !== undefined &&
				statusCode >= 400 &&
				statusCode < 500 &&
				statusCode !== 408 &&
				statusCode !== 429
			) {
				session.current = undefined;
				setBusy(false);
				setStatus(undefined);
				setError("凭证提交被拒绝，请检查输入并重试。");
				return;
			}
		} catch {
			if (attempt !== generation.current) return;
			if (!session.current) {
				setBusy(false);
				setError("暂时无法开始配置，请重试。");
				await refresh();
			}
		} finally {
			credential = "";
		}
		if (session.current) await poll(attempt);
	}
	// 扫码会话里还没有提交凭证，取消只是尽力释放会话，不影响页面状态。
	async function releaseQrSession(sessionId: string) {
		if (session.current === sessionId) session.current = undefined;
		try {
			await cancelWecomSetup({
				path: { agentId, sessionId },
				responseStyle: "fields",
				throwOnError: false,
			});
		} catch {
			// 会话会在到期后失效。
		}
	}
	// 第一步：按扫码能力打开面板。不打开窗口，也不要求先勾选（CK-09）。
	async function openQrPanel() {
		if (
			busy ||
			qr.phase === "checking" ||
			qr.phase === "authorizing" ||
			qr.phase === "confirming"
		)
			return;
		setError("");
		// 服务端已判定不可用：直接显示手动配置入口，不发出 POST …/wecom-setup（O-08）。
		if (qrCapability && !qrCapability.available) {
			setQr({ phase: "unavailable", reason: qrCapability.reason });
			return;
		}
		if (qr.phase === "available" || qr.phase === "unavailable") return;
		const controller = new AbortController();
		qrAbort.current = controller;
		setQr({ phase: "checking" });
		const attempt = generation.current;
		try {
			// 首屏还没有读到扫码能力时先重读状态 V2；只有服务端确认可用才建立 setup session。
			let capability: QrCapability | undefined = qrCapability;
			if (!capability) {
				const current = await getWecomBotConnectionV2({
					path: { agentId },
					signal: controller.signal,
					responseStyle: "fields",
					throwOnError: false,
				});
				if (attempt !== generation.current || controller.signal.aborted) return;
				capability = qrCapabilityOf(current.data);
				if (!capability) throw new Error("WECOM_QR_CAPABILITY_UNKNOWN");
				setQrCapability(capability);
				if (!capability.available) {
					setQr({ phase: "unavailable", reason: capability.reason });
					return;
				}
			}
			const started = await beginWecomSetup({
				path: { agentId },
				signal: controller.signal,
				responseStyle: "fields",
				throwOnError: false,
			});
			if (attempt !== generation.current || controller.signal.aborted) return;
			if (!started.data) throw new Error("WECom_QR_START_FAILED");
			// 状态读取之后部署判定有变时，以本次会话响应为准并释放会话。
			if (!started.data.qrAvailable) {
				const reason = started.data.qrUnavailableReason ?? null;
				session.current = started.data.sessionId;
				await releaseQrSession(started.data.sessionId);
				if (attempt !== generation.current) return;
				setQrCapability({ available: false, reason });
				setQr({ phase: "unavailable", reason });
				return;
			}
			session.current = started.data.sessionId;
			setQr({ phase: "available", started: started.data });
		} catch {
			if (attempt !== generation.current || controller.signal.aborted) return;
			setQr({ phase: "closed" });
			setError("扫码授权未完成，请重试或使用下方手动配置。");
		} finally {
			if (qrAbort.current === controller) qrAbort.current = undefined;
		}
	}
	function closeQrPanel(focus: "trigger" | "manual") {
		if (qr.phase === "available" || qr.phase === "confirming")
			void releaseQrSession(qr.started.sessionId);
		if (qr.phase === "confirming") {
			// 放弃本次扫码结果：不提交凭证，清空回填的 Bot ID，恢复连接状态轮询。
			discardQrResult();
			setBotId("");
			void refresh();
		}
		setQr({ phase: "closed" });
		// 面板关闭后焦点去处：改用手动配置 → Bot ID；关闭 → 扫码授权按钮。
		window.setTimeout(() => {
			if (focus === "manual") document.getElementById("wecom-bot-id")?.focus();
			else qrTriggerRef.current?.focus();
		});
	}
	// 第二步：扫码可用时由这次点击打开扫码窗口，不要求先勾选上方「我已知悉」（CK-09）。
	// 扫码结果先留在内存里，进入面板内的确认步骤；这里不提交凭证。
	async function authorizeQr(started: QrAvailableSession) {
		if (busy || qrAbort.current) return;
		const controller = new AbortController();
		qrAbort.current = controller;
		setQr({ phase: "authorizing" });
		setBusy(true);
		setError("");
		refreshSequence.current++;
		clearTimeout(connectionTimer.current);
		const attempt = generation.current;
		try {
			const result = await openWecomQrAuthorizationV1({
				...started.qr,
				expiresAt: started.expiresAt,
				signal: controller.signal,
			});
			if (attempt !== generation.current || controller.signal.aborted) {
				result.secret = "";
				return;
			}
			discardQrResult();
			qrResult.current = result;
			setBotId(result.botId);
			setBusy(false);
			setQr({ phase: "confirming", started });
		} catch {
			if (attempt !== generation.current || controller.signal.aborted) return;
			if (session.current) await releaseQrSession(session.current);
			if (attempt !== generation.current) return;
			setBusy(false);
			setQr({ phase: "closed" });
			setError("扫码授权未完成，请重试或使用下方手动配置。");
		} finally {
			if (qrAbort.current === controller) qrAbort.current = undefined;
		}
	}
	// 第三步：Owner 在面板内确认连接影响后才提交扫码凭证，且只提交一次（CK-09、PRD §10.2）。
	async function confirmQr(started: QrAvailableSession) {
		const scanned = qrResult.current;
		if (busy || !scanned) return;
		qrResult.current = undefined;
		const body = {
			state: started.state,
			botId: scanned.botId,
			secret: scanned.secret,
			takeoverConfirmed: true as const,
		};
		scanned.secret = "";
		setBusy(true);
		setError("");
		refreshSequence.current++;
		clearTimeout(connectionTimer.current);
		setStatus("verifying");
		setQr({ phase: "closed" });
		// 确认按钮随面板卸载：焦点交给卡片标题，状态 chip 的变化由其 live 区域播报。
		window.setTimeout(() => titleRef.current?.focus());
		const attempt = generation.current;
		// 轮询与取消都跟随这次扫码的 setup session。
		session.current = started.sessionId;
		try {
			const submitted = await submitWecomCredentials({
				path: { agentId, sessionId: started.sessionId },
				body,
				responseStyle: "fields",
				throwOnError: false,
			});
			if (attempt !== generation.current) return;
			const statusCode = submitted.response?.status;
			if (
				!submitted.data &&
				statusCode !== undefined &&
				statusCode >= 400 &&
				statusCode < 500 &&
				statusCode !== 408 &&
				statusCode !== 429
			) {
				session.current = undefined;
				setBusy(false);
				setStatus(undefined);
				setError("凭证提交被拒绝，请检查输入并重试。");
				return;
			}
		} catch {
			// 响应丢失时提交可能已生效：继续回读原会话，不当作失败。
			if (attempt !== generation.current) return;
		} finally {
			body.secret = "";
		}
		if (session.current) await poll(attempt);
	}
	async function cancel(invalidate = true) {
		qrAbort.current?.abort();
		const id = session.current;
		const attempt = generation.current;
		if (!id) return false;
		try {
			const result = await cancelWecomSetup({
				path: { agentId, sessionId: id },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (attempt !== generation.current || session.current !== id)
				return false;
			if (result.data?.status !== "cancelled") throw new Error();
			if (invalidate) generation.current++;
			clearTimeout(timer.current);
			session.current = undefined;
			setBusy(false);
			setQr({ phase: "closed" });
			setSecret("");
			setError("");
			await refresh();
			return true;
		} catch {
			if (attempt === generation.current && session.current === id) {
				clearTimeout(timer.current);
				setBusy(true);
				await poll(attempt);
				if (attempt === generation.current && session.current === id)
					setError("取消结果未确认，正在继续查询配置状态。");
			}
			return false;
		}
	}

	// 扫码结果等待确认期间锁住手动表单与其他操作，只能在面板内确认或取消。
	const qrConfirming = qr.phase === "confirming";
	const locked = busy || unbind.pending || qrConfirming;
	const qrOpen = qr.phase !== "closed" && qr.phase !== "checking";
	const submitLabel = busy ? "验证中…" : "验证并绑定";
	return (
		<WecomChannelCard
			icon={MessageCircle}
			status={status}
			subtitle="智能机器人 · 长连接"
			title={setupTitle}
			titleId="wecom-bot-title"
			titleRef={titleRef}
		>
			{/* 设计 renderWecomBot 文案（W-21）。 */}
			<p className="wecom-channel-copy">
				支持单聊与群聊，群消息和回复对群成员可见；不同发送者的会话上下文独立。Secret
				只提交一次，页面不回显。
			</p>
			<div className="wecom-channel-fields">
				<Field>
					<Label htmlFor="wecom-bot-id">Bot ID</Label>
					<Input
						id="wecom-bot-id"
						placeholder="输入 Bot ID"
						value={botId}
						disabled={busy || qrConfirming}
						onChange={(e) => setBotId(e.target.value)}
						autoComplete="off"
					/>
				</Field>
				<Field>
					<Label htmlFor="wecom-bot-secret">Secret</Label>
					<Input
						id="wecom-bot-secret"
						type="password"
						placeholder="仅本次提交使用"
						value={secret}
						disabled={busy || qrConfirming}
						onChange={(e) => setSecret(e.target.value)}
						autoComplete="new-password"
					/>
				</Field>
			</div>
			{/* 设计 .check：44px 行内垂直居中，紧接字段（W-20、W-21）。 */}
			<Label variant="option">
				<Checkbox
					checked={confirmed}
					disabled={busy || qrConfirming}
					onCheckedChange={(value) => setConfirmed(value)}
				/>
				<span className="min-w-0">我已知悉可能断开其他连接</span>
			</Label>
			{error ? (
				<Alert tone="danger" role="alert">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<WecomUnbindFailure unbind={unbind} />
			<div className="wecom-channel-actions">
				<Button
					type="button"
					disabled={locked || qr.phase === "checking"}
					aria-label={withObjectName(submitLabel, setupTitle)}
					onClick={() => {
						void submit();
					}}
				>
					{submitLabel}
				</Button>
				<Button
					ref={qrTriggerRef}
					type="button"
					variant="outline"
					// 读取扫码能力期间不禁用按钮，焦点留在按钮上；重复点击由处理函数忽略。
					disabled={locked}
					aria-expanded={qrOpen}
					aria-controls={qrOpen ? "wecom-bot-qr-panel" : undefined}
					onClick={() => void openQrPanel()}
				>
					<Scan aria-hidden="true" data-icon="inline-start" />
					扫码授权
				</Button>
				{busy ? (
					<Button
						type="button"
						variant="outline"
						aria-label={withObjectName("取消配置", setupTitle)}
						onClick={() => {
							void cancel();
						}}
					>
						取消配置
					</Button>
				) : null}
				<Button
					type="button"
					variant="ghost"
					disabled={locked}
					aria-label={withObjectName("刷新状态", setupTitle)}
					onClick={() => {
						void refresh();
					}}
				>
					刷新状态
				</Button>
				{unbind.available && status && status !== "not_configured" && !busy ? (
					<WecomUnbindAction
						disabled={locked}
						kind="bot"
						title={setupTitle}
						titleRef={titleRef}
						unbind={unbind}
					/>
				) : null}
			</div>
			{qr.phase === "unavailable" ? (
				<div
					className="wecom-qr-panel"
					data-phase="unavailable"
					id="wecom-bot-qr-panel"
				>
					<div className="wecom-qr-head">
						<div>
							<strong>扫码授权暂不可用</strong>
							<p>扫码能力由服务端按当前部署判定，当前不会伪造绑定成功。</p>
						</div>
					</div>
					<div
						className="wecom-qr-unavailable"
						role="status"
						aria-live="polite"
					>
						<Info aria-hidden="true" className="size-[18px]" />
						<div>
							<strong>请使用手动配置</strong>
							<p>
								{qrUnavailableCopy(qr.reason)}
								{
									"填写已有机器人的 Bot ID 和 Secret 后，平台会创建配置会话并轮询验证结果。"
								}
							</p>
						</div>
					</div>
					<div className="wecom-qr-actions">
						<Button
							type="button"
							variant="outline"
							onClick={() => closeQrPanel("manual")}
						>
							<Settings aria-hidden="true" data-icon="inline-start" />
							改用手动配置
						</Button>
						<Button
							type="button"
							variant="ghost"
							onClick={() => closeQrPanel("trigger")}
						>
							关闭
						</Button>
					</div>
				</div>
			) : null}
			{qr.phase === "available" ||
			qr.phase === "authorizing" ||
			qr.phase === "confirming" ? (
				<div
					className="wecom-qr-panel"
					data-phase={qr.phase === "confirming" ? "confirming" : "available"}
					id="wecom-bot-qr-panel"
				>
					{qr.phase === "confirming" ? (
						<>
							<div className="wecom-qr-head">
								<div>
									<strong>扫码已完成，确认后绑定</strong>
									<p id="wecom-bot-qr-impact">
										连接此机器人可能断开它在其他服务中的现有连接。确认后平台提交凭证并轮询验证结果。
									</p>
								</div>
							</div>
							<div className="wecom-qr-actions">
								<Button
									ref={qrConfirmRef}
									type="button"
									aria-describedby="wecom-bot-qr-impact"
									onClick={() => void confirmQr(qr.started)}
								>
									确认并绑定
								</Button>
								<Button
									type="button"
									variant="ghost"
									onClick={() => closeQrPanel("trigger")}
								>
									取消
								</Button>
							</div>
						</>
					) : (
						<>
							<div className="wecom-qr-head">
								<div>
									<strong>扫码授权</strong>
									<p>
										在新窗口中用企业微信扫码；扫码完成后在这里确认连接影响，平台再提交凭证并轮询验证结果。
									</p>
								</div>
							</div>
							<div className="wecom-qr-actions">
								<Button
									type="button"
									variant="outline"
									disabled={qr.phase === "authorizing"}
									onClick={() => {
										if (qr.phase === "available") void authorizeQr(qr.started);
									}}
								>
									<Scan aria-hidden="true" data-icon="inline-start" />
									{qr.phase === "authorizing" ? "等待扫码…" : "打开扫码窗口"}
								</Button>
								{qr.phase === "available" ? (
									<Button
										type="button"
										variant="ghost"
										onClick={() => closeQrPanel("trigger")}
									>
										关闭
									</Button>
								) : null}
							</div>
						</>
					)}
				</div>
			) : null}
		</WecomChannelCard>
	);
}
