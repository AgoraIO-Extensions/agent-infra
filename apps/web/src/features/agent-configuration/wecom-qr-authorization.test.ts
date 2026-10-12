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
