export interface WecomQrAuthorizationResultV1 {
	readonly botId: string;
	secret: string;
	readonly state: string;
}

interface PopupWindowV1 {
	close(): void;
	readonly closed?: boolean;
	readonly location?: { href: string };
}

function credential(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

type ParsedMessageV1 =
	| { readonly kind: "result"; readonly result: WecomQrAuthorizationResultV1 }
	| { readonly kind: "cancelled" }
	| { readonly kind: "failed" }
	| { readonly kind: "ignored" }
	| { readonly kind: "invalid" };

/**
 * 解析扫码弹窗发来的消息（调用方已核对 origin 与弹窗本身）：
 * - 企微官方扫码页（@wecom/wecom-aibot-sdk 协议）：{type:"AUTH_SUCCESS", payload:{botid, secret}}，
 *   不回传 state；官方定义的其他类型按取消 / 失败处理，未知类型忽略（#2894）。
 * - 部署自有的中转页：{botId, secret, source, state}，source 与一次性 state 必须一致。
 * 官方结果的关联凭据是「本页为这次配置会话打开的那个弹窗」；一次性 state 仍由本页提交给服务端校验。
 */
function parseMessage(
	value: unknown,
	expectedSource: string,
	expectedState: string,
): ParsedMessageV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { kind: "invalid" };
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.type === "string") {
		switch (candidate.type) {
			case "AUTH_SUCCESS": {
				const payload = candidate.payload as Record<string, unknown> | null;
				if (
					typeof payload !== "object" ||
					payload === null ||
					Array.isArray(payload) ||
					!credential(payload.botid) ||
					!credential(payload.secret)
				)
					return { kind: "invalid" };
				return {
					kind: "result",
					result: {
						botId: payload.botid,
						secret: payload.secret,
						state: expectedState,
					},
				};
			}
			case "AUTH_CANCEL":
			case "WINDOW_CLOSE":
				return { kind: "cancelled" };
			case "AUTH_ERROR":
				return { kind: "failed" };
			default:
				// 例如 QR_CODE_READY：继续等待扫码结果。
				return { kind: "ignored" };
		}
	}
	if (
		Object.keys(candidate).sort().join(",") !== "botId,secret,source,state" ||
		candidate.source !== expectedSource ||
		candidate.state !== expectedState ||
		!credential(candidate.botId) ||
		!credential(candidate.secret)
	)
		return { kind: "invalid" };
	return {
		kind: "result",
		result: {
			botId: candidate.botId,
			secret: candidate.secret,
			state: expectedState,
		},
	};
}

/**
 * Open a deployment-approved QR popup and accept only the exact source,
 * origin, and one-time state bound to the current setup session.
 */
export function openWecomQrAuthorizationV1(input: {
	readonly authorizationUrl: string;
	readonly authOrigin: string;
	readonly source: string;
	readonly state: string;
	readonly expiresAt: string;
	readonly popup?: PopupWindowV1;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly open?: (url: string) => PopupWindowV1 | null;
	readonly addEventListener?: (
		name: "message",
		listener: (event: MessageEvent<unknown>) => void,
	) => void;
	readonly removeEventListener?: (
		name: "message",
		listener: (event: MessageEvent<unknown>) => void,
	) => void;
}): Promise<WecomQrAuthorizationResultV1> {
	const expiresAt = Date.parse(input.expiresAt);
	const startedAt = Date.now();
	const remainingMs = expiresAt - startedAt;
	if (!Number.isFinite(expiresAt) || remainingMs <= 0)
		return Promise.reject(new Error("WECom_QR_EXPIRED"));
	// 默认等到配置会话到期前 30 秒：官方二维码本身有效 300 秒，Owner 还要在手机上创建机器人；
	// 留出的 30 秒用于面板确认、提交与 Worker 验证（#2894）。原先固定 120 秒，常常来不及扫完。
	const timeoutMs = Math.min(
		input.timeoutMs ?? Math.max(remainingMs - 30_000, 1_000),
		remainingMs,
	);
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1_000 ||
		timeoutMs > 600_000
	)
		return Promise.reject(new Error("WECom_QR_TIMEOUT_INVALID"));
	const waitDeadline = startedAt + timeoutMs;
	const open = input.open ?? ((url) => window.open(url, "wecom-qr"));
	const add =
		input.addEventListener ??
		((name, listener) => window.addEventListener(name, listener));
	const remove =
		input.removeEventListener ??
		((name, listener) => window.removeEventListener(name, listener));
	const popup = input.popup ?? open(input.authorizationUrl);
	if (!popup) return Promise.reject(new Error("WECom_QR_POPUP_UNAVAILABLE"));
	if (popup.closed) return Promise.reject(new Error("WECom_QR_CANCELLED"));
	if (input.popup) {
		try {
			if (!popup.location) throw new Error("WECom_QR_POPUP_UNAVAILABLE");
			popup.location.href = input.authorizationUrl;
		} catch {
			popup.close();
			return Promise.reject(new Error("WECom_QR_POPUP_UNAVAILABLE"));
		}
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const closedTimer = setInterval(() => {
			if (popup.closed) finish(new Error("WECom_QR_CANCELLED"));
		}, 100);
		const timer = setTimeout(
			() => finish(new Error("WECom_QR_TIMEOUT")),
			timeoutMs,
		);
		const finish = (error?: Error, result?: WecomQrAuthorizationResultV1) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(closedTimer);
			remove("message", onMessage);
			input.signal?.removeEventListener("abort", onAbort);
			popup.close();
			if (error) reject(error);
			else if (result) resolve(result);
			else reject(new Error("WECom_QR_RESULT_INVALID"));
		};
		const onAbort = () => finish(new Error("WECom_QR_CANCELLED"));
		const onMessage = (event: MessageEvent<unknown>) => {
			const now = Date.now();
			if (now >= expiresAt) return finish(new Error("WECom_QR_EXPIRED"));
			if (now >= waitDeadline) return finish(new Error("WECom_QR_TIMEOUT"));
			if (popup.closed) return finish(new Error("WECom_QR_CANCELLED"));
			if (event.source !== popup || event.origin !== input.authOrigin) return;
			const parsed = parseMessage(event.data, input.source, input.state);
			if (parsed.kind === "ignored") return;
			if (parsed.kind === "cancelled")
				return finish(new Error("WECom_QR_CANCELLED"));
			if (parsed.kind === "failed")
				return finish(new Error("WECom_QR_AUTH_FAILED"));
			if (parsed.kind === "invalid")
				return finish(new Error("WECom_QR_RESULT_INVALID"));
			finish(undefined, parsed.result);
		};
		add("message", onMessage);
		if (input.signal?.aborted) onAbort();
		else input.signal?.addEventListener("abort", onAbort, { once: true });
	});
}
