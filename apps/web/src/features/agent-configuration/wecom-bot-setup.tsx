import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	beginWecomSetup,
	cancelWecomSetup,
	getWecomBotConnection,
	getWecomSetup,
	submitWecomCredentials,
} from "../../pilot/generated/sdk.gen.js";
import type { AgentConfigurationUpdateRequestV2Writable } from "../../pilot/generated-v2/types.gen.js";

const labels = {
	not_configured: "未配置",
	callback: "已配置回调模式",
	verifying: "验证中",
	connected: "已连接",
	disconnected: "已断开",
	auth_failed: "认证失败",
};
export function WecomBotSetup({
	agentId,
	onUnbind,
}: {
	agentId: string;
	onUnbind: (body: AgentConfigurationUpdateRequestV2Writable) => void;
}) {
	const [botId, setBotId] = useState("");
	const [secret, setSecret] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<keyof typeof labels>();
	const [error, setError] = useState("");
	const session = useRef<string | undefined>(undefined);
	const generation = useRef(0);
	const refreshSequence = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const connectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const refresh = useCallback(
		async function refreshConnection() {
			clearTimeout(connectionTimer.current);
			const attempt = generation.current;
			const sequence = ++refreshSequence.current;
			try {
				const result = await getWecomBotConnection({
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
	useEffect(() => {
		generation.current++;
		session.current = undefined;
		setBotId("");
		setSecret("");
		setConfirmed(false);
		setBusy(false);
		setStatus(undefined);
		setError("");
		void refresh();
		return () => {
			generation.current++;
			clearTimeout(timer.current);
			clearTimeout(connectionTimer.current);
		};
	}, [refresh]);
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
				setError(
					current.data.status === "active"
						? ""
						: "绑定未完成，请检查凭证后重试。",
				);
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
	async function cancel() {
		const id = session.current;
		if (!id) return;
		try {
			const result = await cancelWecomSetup({
				path: { agentId, sessionId: id },
				responseStyle: "fields",
				throwOnError: false,
			});
			if (result.data?.status !== "cancelled") throw new Error();
			generation.current++;
			clearTimeout(timer.current);
			session.current = undefined;
			setBusy(false);
			setSecret("");
			setError("");
			await refresh();
		} catch {
			setError("取消结果未确认，正在继续查询配置状态。");
		}
	}

	return (
		<section
			aria-label="智能机器人配置"
			className="space-y-4 rounded-lg border border-slate-200 p-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 className="font-semibold">智能机器人</h3>
				<p aria-live="polite" className="text-sm">
					{status ? labels[status] : "连接状态暂不可用"}
				</p>
			</div>
			<div className="flex flex-wrap gap-3">
				<Button
					type="button"
					variant="outline"
					onClick={() => setError("扫码授权暂不可用，请使用下方手动配置。")}
				>
					扫码授权
				</Button>
				<p className="self-center text-slate-600 text-sm">
					也可填写已有机器人的 Bot ID 和 Secret，无需公网回调。
				</p>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="wecom-bot-id">Bot ID</Label>
					<Input
						id="wecom-bot-id"
						value={botId}
						disabled={busy}
						onChange={(e) => setBotId(e.target.value)}
						autoComplete="off"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="wecom-bot-secret">Secret</Label>
					<Input
						id="wecom-bot-secret"
						type="password"
						value={secret}
						disabled={busy}
						onChange={(e) => setSecret(e.target.value)}
						autoComplete="new-password"
					/>
				</div>
			</div>
			<Label className="flex min-h-11 items-center gap-3 text-sm">
				<Checkbox
					checked={confirmed}
					disabled={busy}
					onCheckedChange={(value) => setConfirmed(value)}
				/>
				我已知悉：连接此机器人可能断开它在其他服务中的现有连接。
			</Label>
			<p className="text-slate-600 text-sm">
				群消息和回复对群成员可见，每位发送者的会话上下文独立。Secret
				提交后清空。
			</p>
			{error ? (
				<p role="alert" className="text-red-700 text-sm">
					{error}
				</p>
			) : null}
			<div className="flex flex-wrap gap-3">
				<Button
					type="button"
					disabled={busy}
					onClick={() => {
						void submit();
					}}
				>
					{busy ? "验证中…" : "验证并绑定"}
				</Button>
				{busy ? (
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							void cancel();
						}}
					>
						取消配置
					</Button>
				) : null}
				<Button
					type="button"
					variant="outline"
					disabled={busy}
					onClick={() => {
						void refresh();
					}}
				>
					刷新状态
				</Button>
				{status && status !== "not_configured" ? (
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() =>
							onUnbind({
								schemaVersion: 2,
								channels: [{ kind: "wecom_bot", enabled: false }],
							})
						}
					>
						解除机器人绑定
					</Button>
				) : null}
			</div>
		</section>
	);
}
