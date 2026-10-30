import { ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import {
	beginConnectionInstallation,
	type ConnectionInstallationState,
	confirmConnectionInstallation,
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
	const [authorizationId, setAuthorizationId] = useState<string>();
	const [polls, setPolls] = useState(0);
	const [error, setError] = useState<string>();
	const [refreshing, setRefreshing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [confirmationUncertain, setConfirmationUncertain] = useState(false);
	const beginKey = useRef<string | undefined>(undefined);
	const confirmationKey = useRef<string | undefined>(undefined);
	const command = useRef<"begin" | "confirm" | undefined>(undefined);
	const request = useRef<AbortController | undefined>(undefined);
	const stepButton = useRef<HTMLButtonElement>(null);
	const confirmButton = useRef<HTMLButtonElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new execution or client invalidates the entire installation and its pending response.
	useLayoutEffect(() => {
		setState({ kind: "idle" });
		setAuthorizationId(undefined);
		setPolls(0);
		setError(undefined);
		setRefreshing(false);
		setConfirming(false);
		setConfirmationUncertain(false);
		beginKey.current = undefined;
		confirmationKey.current = undefined;
		command.current = undefined;
		return () => request.current?.abort();
	}, [executionId, client]);

	const authorizationUrl =
		state.kind === "awaiting_confirmation"
			? safeConnectionAuthorizationUrl(state.projection.authorizationUrl)
			: undefined;

	const applyProjection = useCallback((next: ConnectionInstallationState) => {
		if (
			next.kind !== "awaiting_confirmation" &&
			document.activeElement === confirmButton.current
		)
			stepButton.current?.focus();
		setState(next);
	}, []);

	const begin = async () => {
		if (command.current) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		command.current = "begin";
		beginKey.current ??= crypto.randomUUID();
		setError(undefined);
		setAuthorizationId(undefined);
		setPolls(0);
		setConfirmationUncertain(false);
		confirmationKey.current = undefined;
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
			if ("projection" in next) {
				setAuthorizationId(next.projection.authorizationId);
				beginKey.current = undefined;
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				setError("暂时无法开始 Connection 安装，请稍后重试。");
				setState({
					kind: "unavailable",
					retryable: !invalidInstallationResponse(error),
				});
			}
		} finally {
			if (!controller.signal.aborted) command.current = undefined;
		}
	};

	const confirm = async () => {
		if (
			command.current ||
			!authorizationId ||
			!authorizationUrl ||
			state.kind !== "awaiting_confirmation"
		)
			return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		command.current = "confirm";
		confirmationKey.current ??= crypto.randomUUID();
		setError(undefined);
		setRefreshing(false);
		setConfirming(true);
		try {
			const next = await confirmConnectionInstallation({
				client,
				authorizationId,
				idempotencyKey: confirmationKey.current,
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			if (next.kind === "unavailable") {
				setConfirmationUncertain(true);
				if (!next.retryable) applyProjection(next);
				setError("确认结果尚未核实，请查询原安装状态。");
				return;
			}
			setConfirmationUncertain(false);
			applyProjection(next);
		} catch {
			if (!controller.signal.aborted) {
				setConfirmationUncertain(true);
				setError("确认结果尚未核实，请查询原安装状态。");
			}
		} finally {
			if (!controller.signal.aborted) {
				command.current = undefined;
				setConfirming(false);
			}
		}
	};

	const refreshStatus = useCallback(
		async (background = false) => {
			if (!authorizationId || command.current) return;
			request.current?.abort();
			const controller = new AbortController();
			request.current = controller;
			if (!background) setError(undefined);
			setRefreshing(true);
			const failed = (retryable: boolean) => {
				if (!retryable) {
					setError(undefined);
					applyProjection({ kind: "unavailable", retryable: false });
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
				setConfirmationUncertain(false);
				applyProjection(next);
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
		[authorizationId, client, applyProjection],
	);

	useEffect(() => {
		if (
			!authorizationId ||
			state.kind !== "awaiting_confirmation" ||
			refreshing ||
			confirming ||
			confirmationUncertain ||
			polls >= maximumPolls
		)
			return;
		const timer = window.setTimeout(
			() => void refreshStatus(true),
			pollIntervalMs,
		);
		return () => window.clearTimeout(timer);
	}, [
		authorizationId,
		polls,
		refreshStatus,
		refreshing,
		confirming,
		confirmationUncertain,
		state.kind,
	]);

	const terminal = ["confirmed", "revoked", "expired"].includes(state.kind);
	const canRead = Boolean(authorizationId) && !terminal;
	return (
		<section
			aria-label="Connection 安装确认"
			className="space-y-3 border-border border-t pt-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h3 className="font-semibold">Connection 安装</h3>
					<p className="text-muted-foreground text-sm">
						只展示安装确认状态，不会在平台保存或显示凭据。
					</p>
				</div>
				{/* Keep the step button mounted as its action changes, including during requests. */}
				<Button
					ref={stepButton}
					type="button"
					variant="outline"
					disabled={state.kind === "loading" || refreshing || confirming}
					focusableWhenDisabled
					onClick={() => (canRead ? void refreshStatus() : void begin())}
				>
					{canRead ? (
						<RefreshCw aria-hidden="true" />
					) : (
						<KeyRound aria-hidden="true" />
					)}
					{canRead
						? refreshing
							? "查询中"
							: "查询状态"
						: terminal
							? "重新开始"
							: "开始安装"}
				</Button>
			</div>
			{state.kind === "loading" && <p role="status">正在准备授权…</p>}
			{"projection" in state && (
				<div className="flex flex-wrap items-center gap-2">
					<Badge tone="gray">{statusLabels[state.kind]}</Badge>
					{authorizationUrl && (
						<>
							<Button
								type="button"
								variant="link"
								onClick={() =>
									window.open(authorizationUrl, "_blank", "noopener,noreferrer")
								}
							>
								<ExternalLink aria-hidden="true" data-icon="inline-start" />
								打开授权页
							</Button>
							<Button
								ref={confirmButton}
								type="button"
								disabled={confirming || refreshing}
								focusableWhenDisabled
								onClick={() => void confirm()}
							>
								<KeyRound aria-hidden="true" />
								{confirming
									? "确认中"
									: confirmationUncertain
										? "重试确认"
										: "确认安装"}
							</Button>
						</>
					)}
				</div>
			)}
			{state.kind === "awaiting_confirmation" && (
				<p className="text-muted-foreground text-sm">
					{authorizationUrl
						? "请在授权页完成授权，再确认将此安装用于当前执行。"
						: "正在准备授权入口，请稍后查询状态。"}
				</p>
			)}
			{state.kind === "confirmed" && (
				<p className="text-muted-foreground text-sm">
					已记录你的安装确认，Connection 授权是否可用仍需核实。
				</p>
			)}
			{state.kind === "awaiting_confirmation" && polls >= maximumPolls && (
				<p className="text-muted-foreground text-sm">
					轮询已暂停，请稍后重新读取状态。
				</p>
			)}
			{state.kind === "unavailable" && (
				<Alert tone="warn" role="alert">
					<AlertDescription>Connection 安装暂不可用。</AlertDescription>
					{state.retryable && !authorizationId && (
						<AlertAction>
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
			{error && (
				<p aria-live="polite" className="text-destructive text-sm">
					{error}
				</p>
			)}
		</section>
	);
}
