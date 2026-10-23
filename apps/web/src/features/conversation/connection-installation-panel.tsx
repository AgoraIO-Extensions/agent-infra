import { ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import {
	beginConnectionInstallation,
	type ConnectionInstallationState,
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

	const refreshStatus = useCallback(async () => {
		if (!authorizationId) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setError(undefined);
		setRefreshing(true);
		try {
			const next = await readConnectionInstallation({
				client,
				authorizationId,
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			if (next.kind === "unavailable") {
				setError("暂时无法读取安装状态。");
				return;
			}
			setState(next);
		} catch {
			if (!controller.signal.aborted) setError("暂时无法读取安装状态。");
		} finally {
			if (!controller.signal.aborted) {
				setRefreshing(false);
				setPolls((value) => value + 1);
			}
		}
	}, [authorizationId, client]);

	useEffect(() => {
		if (
			!authorizationId ||
			state.kind !== "awaiting_confirmation" ||
			refreshing ||
			polls >= maximumPolls
		)
			return;
		const timer = window.setTimeout(() => {
			void refreshStatus();
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
