import { afterEach, expect, it, vi } from "vitest";
import { openWecomQrAuthorizationV1 } from "./wecom-qr-authorization.js";

function harness() {
	const listeners = new Set<(event: MessageEvent<unknown>) => void>();
	const popup = { close: () => {} };
	return {
		popup,
		addEventListener: (
			_name: "message",
			listener: (event: MessageEvent<unknown>) => void,
		) => listeners.add(listener),
		removeEventListener: (
			_name: "message",
			listener: (event: MessageEvent<unknown>) => void,
		) => listeners.delete(listener),
		post(event: MessageEvent<unknown>) {
			for (const listener of listeners) listener(event);
		},
	};
}

const base = {
	authorizationUrl: "https://auth.example.test/authorize?state=state-1",
	authOrigin: "https://auth.example.test",
	source: "agent-infra",
	state: "state-1",
	expiresAt: new Date(Date.now() + 60_000).toISOString(),
	timeoutMs: 1_000,
};

afterEach(() => {
	vi.useRealTimers();
});

it("accepts one exact popup source/origin/state result", async () => {
	const h = harness();
	const promise = openWecomQrAuthorizationV1({
		...base,
		open: () => h.popup,
		addEventListener: h.addEventListener,
		removeEventListener: h.removeEventListener,
	});
	h.post(
		new MessageEvent("message", {
			origin: base.authOrigin,
			source: h.popup as unknown as MessageEventSource,
			data: {
				source: base.source,
				state: base.state,
				botId: "bot-1",
				secret: "secret-1",
			},
		}),
	);
	await expect(promise).resolves.toEqual({
		botId: "bot-1",
		secret: "secret-1",
		state: base.state,
	});
});

it("ignores foreign popup source/origin and rejects stale state", async () => {
	const h = harness();
	const foreign = { close: () => {} };
	const promise = openWecomQrAuthorizationV1({
		...base,
		open: () => h.popup,
		addEventListener: h.addEventListener,
		removeEventListener: h.removeEventListener,
	});
	h.post(
		new MessageEvent("message", {
			origin: "https://evil.example.test",
			source: foreign as unknown as MessageEventSource,
			data: {
				source: base.source,
				state: base.state,
				botId: "bot-evil",
				secret: "secret-evil",
			},
		}),
	);
	h.post(
		new MessageEvent("message", {
			origin: base.authOrigin,
			source: h.popup as unknown as MessageEventSource,
			data: {
				source: base.source,
				state: "stale",
				botId: "bot-stale",
				secret: "secret-stale",
			},
		}),
	);
	await expect(promise).rejects.toThrow("WECom_QR_RESULT_INVALID");
});

it("rejects an already expired setup session before opening a popup", async () => {
	const h = harness();
	await expect(
		openWecomQrAuthorizationV1({
			...base,
			expiresAt: new Date(Date.now() - 1).toISOString(),
			open: () => h.popup,
		}),
	).rejects.toThrow("WECom_QR_EXPIRED");
});

it("settles promptly when the popup is closed", async () => {
	const h = harness();
	const popup = { closed: false, close: () => {} };
	const promise = openWecomQrAuthorizationV1({
		...base,
		open: () => popup,
		addEventListener: h.addEventListener,
		removeEventListener: h.removeEventListener,
	});
	popup.closed = true;
	await expect(promise).rejects.toThrow("WECom_QR_CANCELLED");
});

it("rejects a queued result after the popup was closed", async () => {
	const h = harness();
	const popup = { closed: false, close: () => {} };
	const promise = openWecomQrAuthorizationV1({
		...base,
		open: () => popup,
		addEventListener: h.addEventListener,
		removeEventListener: h.removeEventListener,
	});
	popup.closed = true;
	h.post(
		new MessageEvent("message", {
			origin: base.authOrigin,
			source: popup as unknown as MessageEventSource,
			data: {
				source: base.source,
				state: base.state,
				botId: "bot-closed",
				secret: "secret-closed",
			},
		}),
	);
	await expect(promise).rejects.toThrow("WECom_QR_CANCELLED");
});

it("rejects a queued result after the popup wait deadline", async () => {
	vi.useFakeTimers();
	const h = harness();
	const popup = { closed: false, close: () => {} };
	const promise = openWecomQrAuthorizationV1({
		...base,
		timeoutMs: 1_000,
		open: () => popup,
		addEventListener: h.addEventListener,
		removeEventListener: h.removeEventListener,
	});
	vi.setSystemTime(Date.now() + 1_001);
	h.post(
		new MessageEvent("message", {
			origin: base.authOrigin,
			source: popup as unknown as MessageEventSource,
			data: {
				source: base.source,
				state: base.state,
				botId: "bot-late",
				secret: "secret-late",
			},
		}),
	);
	await expect(promise).rejects.toThrow("WECom_QR_TIMEOUT");
});

// 企微官方扫码页（@wecom/wecom-aibot-sdk 协议）只发 {type, payload}，不回传 state（#2894）。
const official = {
	...base,
	authorizationUrl:
		"https://work.weixin.qq.com/ai/qc/gen?source=agent-infra&state=state-1",
	authOrigin: "https://work.weixin.qq.com",
};

function officialMessage(
	popup: unknown,
	data: unknown,
	origin = official.authOrigin,
) {
	return new MessageEvent("message", {
		origin,
		source: popup as MessageEventSource,
		data,
	});
}

it("accepts the official AUTH_SUCCESS result from the popup it opened (#2894)", async () => {
	const h = harness();
	const promise = openWecomQrAuthorizationV1({
		...official,
		open: () => h.popup,
		addEventListener: h.addEventListener,
		removeEventListener: h.removeEventListener,
	});
	h.post(
		officialMessage(h.popup, {
			type: "AUTH_SUCCESS",
			payload: { botid: "bot-official", secret: "secret-official" },
		}),
	);
	await expect(promise).resolves.toEqual({
		botId: "bot-official",
		secret: "secret-official",
		state: official.state,
	});
});

it("keeps waiting on unrelated official messages and ignores foreign windows (#2894)", async () => {
	const h = harness();
	const foreign = { close: () => {} };
	const promise = openWecomQrAuthorizationV1({
		...official,
		open: () => h.popup,
		addEventListener: h.addEventListener,
		removeEventListener: h.removeEventListener,
	});
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	h.post(officialMessage(h.popup, { type: "QR_CODE_READY", payload: {} }));
	const forged = {
		type: "AUTH_SUCCESS",
		payload: { botid: "bot-evil", secret: "secret-evil" },
	};
	h.post(officialMessage(foreign, forged));
	h.post(officialMessage(h.popup, forged, "https://evil.example.test"));
	await Promise.resolve();
	expect(settled).toBe(false);
	h.post(
		officialMessage(h.popup, {
			type: "AUTH_SUCCESS",
			payload: { botid: "bot-official", secret: "secret-official" },
		}),
	);
	await expect(promise).resolves.toMatchObject({ botId: "bot-official" });
});

it.each([
	["AUTH_CANCEL", "WECom_QR_CANCELLED"],
	["WINDOW_CLOSE", "WECom_QR_CANCELLED"],
	["AUTH_ERROR", "WECom_QR_AUTH_FAILED"],
])("settles the official %s message as %s (#2894)", async (type, error) => {
	const h = harness();
	const promise = openWecomQrAuthorizationV1({
		...official,
		open: () => h.popup,
		addEventListener: h.addEventListener,
		removeEventListener: h.removeEventListener,
	});
	h.post(officialMessage(h.popup, { type, payload: { error: { code: "X" } } }));
	await expect(promise).rejects.toThrow(error);
});

it("rejects an official success without both credentials (#2894)", async () => {
	const h = harness();
	const promise = openWecomQrAuthorizationV1({
		...official,
		open: () => h.popup,
		addEventListener: h.addEventListener,
		removeEventListener: h.removeEventListener,
	});
	h.post(
		officialMessage(h.popup, {
			type: "AUTH_SUCCESS",
			payload: { botid: "bot-official" },
		}),
	);
	await expect(promise).rejects.toThrow("WECom_QR_RESULT_INVALID");
});

it("waits until 30 seconds before the setup session expires by default (#2894)", async () => {
	vi.useFakeTimers();
	const h = harness();
	const popup = { closed: false, close: () => {} };
	const start = () =>
		openWecomQrAuthorizationV1({
			...official,
			timeoutMs: undefined,
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
			open: () => popup,
			addEventListener: h.addEventListener,
			removeEventListener: h.removeEventListener,
		});
	const scanned = start();
	// 原先固定 120 秒就会超时；现在 200 秒时扫码结果仍被接受。
	await vi.advanceTimersByTimeAsync(200_000);
	h.post(
		officialMessage(popup, {
			type: "AUTH_SUCCESS",
			payload: { botid: "bot-slow", secret: "secret-slow" },
		}),
	);
	await expect(scanned).resolves.toMatchObject({ botId: "bot-slow" });
	const abandoned = start();
	const outcome = expect(abandoned).rejects.toThrow("WECom_QR_TIMEOUT");
	await vi.advanceTimersByTimeAsync(270_001);
	await outcome;
});
