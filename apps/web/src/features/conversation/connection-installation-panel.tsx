import { ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import {
	beginConnectionInstallation,
	type ConnectionInstallationState,
	invalidInstallationResponse,
	readConnectionInstallation,
	safeConnectionAuthorizationUrl,
} from "./connection-installation.js";

const pollIntervalMs = 2_000;
const maximumPolls = 30;

const statusLabels: Record<
	Exclude<
		ConnectionInstallationState["kind"],
		"idle" | "loading" | "unavailable"
	>,
	string
> = {
	awaiting_confirmation: "等待 Connection 确认",
	confirmed: "已确认",
	revoked: "已撤销",
	expired: "已过期",
	unknown: "状态待核实",
};

export function ConnectionInstallationPanel({
	executionId,
	client,
}: {
	executionId: string;
	client?: Client;
}) {
	const [state, setState] = useState<ConnectionInstallationState>({
		kind: "idle",
	});
	const [authorizationId, setAuthorizationId] = useState<string | undefined>(
		undefined,
	);
	const [polls, setPolls] = useState(0);
	const [openedUrl, setOpenedUrl] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [refreshing, setRefreshing] = useState(false);
	const beginKey = useRef<string | undefined>(undefined);
	const request = useRef<AbortController | undefined>(undefined);
	const stepButton = useRef<HTMLButtonElement>(null);

	useEffect(() => () => request.current?.abort(), []);

	const openAuthorization = (url: unknown) => {
		const safe = safeConnectionAuthorizationUrl(url);
		if (!safe) {
			setError("授权入口不可用，平台已拒绝打开无效地址。");
			return;
		}
		setOpenedUrl(safe);
		window.open(safe, "_blank", "noopener,noreferrer");
	};

	const begin = async () => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		beginKey.current ??= crypto.randomUUID();
		setError(undefined);
		setOpenedUrl(undefined);
		setPolls(0);
		setState({ kind: "loading" });
		try {
			const next = await beginConnectionInstallation({
				client,
				executionId,
				idempotencyKey: beginKey.current,
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			setState(next);
			if (
				next.kind === "awaiting_confirmation" &&
				!safeConnectionAuthorizationUrl(next.projection.authorizationUrl)
			) {
				setError("授权入口不可用，平台已拒绝继续安装。");
				setState({ kind: "unavailable", retryable: false });
				beginKey.current = undefined;
				return;
			}
			if (next.kind === "awaiting_confirmation")
				setOpenedUrl(
					safeConnectionAuthorizationUrl(next.projection.authorizationUrl),
				);
			if (next.kind !== "unavailable") beginKey.current = undefined;
			if (next.kind === "awaiting_confirmation" || next.kind === "confirmed")
				setAuthorizationId(next.projection.authorizationId);
		} catch {
			if (!controller.signal.aborted) {
				setError("暂时无法开始 Connection 安装，请稍后重试。");
				setState({ kind: "unavailable", retryable: true });
			}
		}
	};

	/**
	 * 读取安装状态。轮询（background）按 #3418 的轮询规则（#3433）：可重试的失败（503、网络中断）保留
	 * 「等待 Connection 确认」并按原节奏继续，不另加提示；不可重试的失败（登录失效、无权、不存在、响应
	 * 无效）停止轮询并显示「Connection 安装暂不可用。」；读到终态停止。用户按「查询状态」的读取可重试地
	 * 失败时照旧提示「暂时无法读取安装状态。」。
	 */
	const refreshStatus = useCallback(
		async (background = false) => {
			if (!authorizationId) return;
			request.current?.abort();
			const controller = new AbortController();
			request.current = controller;
			// 用户读取的失败一直显示到下一次读到结果：轮询开始时不清掉它。
			if (!background) setError(undefined);
			setRefreshing(true);
			const failed = (retryable: boolean) => {
				if (!retryable) {
					setError(undefined);
					setState({ kind: "unavailable", retryable: false });
				} else if (!background) setError("暂时无法读取安装状态。");
			};
			try {
				const next = await readConnectionInstallation({
					client,
					authorizationId,
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				if (next.kind === "unavailable") {
					failed(next.retryable);
					return;
				}
				setError(undefined);
				setState(next);
			} catch (error) {
				if (!controller.signal.aborted)
					failed(!invalidInstallationResponse(error));
			} finally {
				if (!controller.signal.aborted) {
					setRefreshing(false);
					setPolls((value) => value + 1);
				}
			}
		},
		[authorizationId, client],
	);

	useEffect(() => {
		if (
			!authorizationId ||
			state.kind !== "awaiting_confirmation" ||
			refreshing ||
			polls >= maximumPolls
		)
			return;
		const timer = window.setTimeout(() => {
			void refreshStatus(true);
		}, pollIntervalMs);
		return () => {
			window.clearTimeout(timer);
		};
	}, [authorizationId, polls, refreshStatus, refreshing, state.kind]);

	const terminal = ["confirmed", "revoked", "expired", "unknown"].includes(
		state.kind,
	);
	return (
		<section
			aria-label="Connection 安装确认"
			className="space-y-3 border-border border-t pt-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h3 className="font-semibold">Connection 安装</h3>
					<p className="text-muted-foreground text-sm">
						只展示授权状态，不会在平台保存或显示凭据。
					</p>
				</div>
				{/* 「开始安装」「查询状态」「重新开始」占同一个位置、复用同一个按钮元素（#3242 K7-02、#3269
				    N8-3-02）：准备授权与读取中是可聚焦的禁用，焦点留在按钮上；状态推进后按钮原地换成下一步，
				    焦点不随旧按钮卸载落到 body 或被执行详情弹窗收回。 */}
				{state.kind === "awaiting_confirmation" ? (
					<Button
						ref={stepButton}
						type="button"
						variant="outline"
						disabled={refreshing}
						focusableWhenDisabled
						onClick={() => void refreshStatus()}
					>
						<RefreshCw aria-hidden="true" />
						{refreshing ? "查询中" : "查询状态"}
					</Button>
				) : (
					<Button
						ref={stepButton}
						type="button"
						variant="outline"
						disabled={state.kind === "loading"}
						focusableWhenDisabled
						onClick={() => void begin()}
					>
						<KeyRound aria-hidden="true" />
						{terminal ? "重新开始" : "开始安装"}
					</Button>
				)}
			</div>
			{state.kind === "loading" && <p role="status">正在准备授权…</p>}
			{state.kind !== "idle" &&
				state.kind !== "loading" &&
				state.kind !== "unavailable" && (
					<div className="flex flex-wrap items-center gap-2">
						<Badge tone="gray">{statusLabels[state.kind]}</Badge>
						{openedUrl && state.kind === "awaiting_confirmation" && (
							<Button
								type="button"
								variant="link"
								onClick={() => openAuthorization(openedUrl)}
							>
								<ExternalLink aria-hidden="true" data-icon="inline-start" />
								打开授权页
							</Button>
						)}
					</div>
				)}
			{state.kind === "awaiting_confirmation" && polls >= maximumPolls && (
				<p className="text-muted-foreground text-sm">
					轮询已暂停，请稍后重新读取状态。
				</p>
			)}
			{state.kind === "unavailable" && (
				<Alert tone="warn" role="alert">
					<AlertDescription>Connection 安装暂不可用。</AlertDescription>
					{state.retryable && (
						<AlertAction>
							{/* 提示随重新开始卸载：焦点先交给同一位置的「开始安装」（准备期间可聚焦的禁用）。 */}
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									stepButton.current?.focus();
									void begin();
								}}
							>
								<RefreshCw aria-hidden="true" data-icon="inline-start" />
								重新开始
							</Button>
						</AlertAction>
					)}
				</Alert>
			)}
			{error && <p className="text-destructive text-sm">{error}</p>}
		</section>
	);
}
