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

function parseResult(
	value: unknown,
	expectedSource: string,
	expectedState: string,
): WecomQrAuthorizationResultV1 | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		Object.keys(candidate).sort().join(",") !== "botId,secret,source,state" ||
		candidate.source !== expectedSource ||
		candidate.state !== expectedState ||
		typeof candidate.botId !== "string" ||
		typeof candidate.secret !== "string" ||
		candidate.botId.length === 0 ||
		candidate.botId.length > 1024 ||
		candidate.secret.length === 0 ||
		candidate.secret.length > 1024
	)
		return undefined;
	return {
		botId: candidate.botId,
		secret: candidate.secret,
		state: expectedState,
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
	const remainingMs = expiresAt - Date.now();
	if (!Number.isFinite(expiresAt) || remainingMs <= 0)
		return Promise.reject(new Error("WECom_QR_EXPIRED"));
	const timeoutMs = Math.min(input.timeoutMs ?? 120_000, remainingMs);
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1_000 ||
		timeoutMs > 600_000
	)
		return Promise.reject(new Error("WECom_QR_TIMEOUT_INVALID"));
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
			if (Date.now() >= expiresAt) return finish(new Error("WECom_QR_EXPIRED"));
			if (event.source !== popup || event.origin !== input.authOrigin) return;
			const result = parseResult(event.data, input.source, input.state);
			if (!result) return finish(new Error("WECom_QR_RESULT_INVALID"));
			finish(undefined, result);
		};
		add("message", onMessage);
		if (input.signal?.aborted) onAbort();
		else input.signal?.addEventListener("abort", onAbort, { once: true });
	});
}
