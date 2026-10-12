import { expect, it } from "vitest";
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
	timeoutMs: 1_000,
};

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
