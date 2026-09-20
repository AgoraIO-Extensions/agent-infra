import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexConnectionBootstrapResponse } from "./codex-connection-client.js";
import {
	type CodexNativeCallbackHandler,
	type CodexNativeCallbackResponse,
	type CodexNativeConnectionBootstrapHandler,
	serveCodexNativeCallbacks,
	serveCodexNativeCallbacksV1,
} from "./codex-native-callback.js";

const corpus = JSON.parse(
	readFileSync(
		new URL(
			"../../../deploy/runtime/vendor/codex/callback-v2-corpus.json",
			import.meta.url,
		),
		"utf8",
	),
) as {
	cases: { id: string; frame: unknown }[];
	framingCases: { id: string; wireUtf8?: string; wireHex?: string }[];
};
function frame(id: string): unknown {
	return structuredClone(corpus.cases.find((item) => item.id === id)?.frame);
}
function pair() {
	const requests = new PassThrough();
	const replies = new PassThrough();
	const server = Duplex.from({ readable: requests, writable: replies });
	const native = Duplex.from({ readable: replies, writable: requests });
	native.on("error", () => {});
	return { server, native };
}
afterEach(() => vi.restoreAllMocks());

async function rejected(input: unknown, response?: unknown, bytes?: Buffer) {
	const { server, native } = pair();
	const failure = vi.fn();
	const received: Buffer[] = [];
	native.on("data", (chunk) => received.push(chunk));
	// Invalid producer results are intentionally injected to test the real wire gate.
	const operation = vi.fn<CodexNativeCallbackHandler>(
		async () => response as CodexNativeCallbackResponse,
	);
	const bootstrap = vi.fn<CodexNativeConnectionBootstrapHandler>(
		async () => response as CodexConnectionBootstrapResponse,
	);
	const channel = serveCodexNativeCallbacks(
		server,
		operation,
		bootstrap,
		failure,
	);
	native.write(bytes ?? `${JSON.stringify(input)}\n`);
	await channel.finished;
	expect(failure).toHaveBeenCalledOnce();
	expect(received).toEqual([]);
	native.destroy();
	return { operation, bootstrap };
}

describe("private V2 credential lane", () => {
	it("sends bootstrap only to the credential handler, outside the ordinary callback", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const { server, native } = pair();
		const failure = vi.fn();
		const operation = vi.fn<CodexNativeCallbackHandler>();
		const response = frame("v2-bootstrap-user-permit");
		const bootstrap = vi.fn<CodexNativeConnectionBootstrapHandler>(
			async () => response as CodexConnectionBootstrapResponse,
		);
		const channel = serveCodexNativeCallbacks(
			server,
			operation,
			bootstrap,
			failure,
		);
		try {
			const replied = once(native, "data");
			native.write(
				`${JSON.stringify(frame("v2-bootstrap-request-before-native-session"))}\n`,
			);
			const [bytes] = await replied;
			expect(JSON.parse(bytes.toString())).toEqual(response);
			expect(bootstrap).toHaveBeenCalledOnce();
			expect(operation).not.toHaveBeenCalled();
			expect(failure).not.toHaveBeenCalled();
		} finally {
			channel.close();
			await channel.finished;
			native.destroy();
		}
	});
	it("exchanges a V2 permit only when the complete original descriptor matches", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const { server, native } = pair();
		const failure = vi.fn();
		const response = frame("v2-connection-permit");
		const operation = vi.fn<CodexNativeCallbackHandler>(
			async () => response as CodexNativeCallbackResponse,
		);
		const channel = serveCodexNativeCallbacks(
			server,
			operation,
			undefined,
			failure,
		);
		try {
			const replied = once(native, "data");
			native.write(`${JSON.stringify(frame("v2-connection-intent"))}\n`);
			const [bytes] = await replied;
			expect(JSON.parse(bytes.toString())).toEqual(response);
			expect(failure).not.toHaveBeenCalled();
		} finally {
			channel.close();
			await channel.finished;
			native.destroy();
		}
	});
	it("rejects a mismatched V2 permit descriptor and bootstrap request binding", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		await rejected(
			frame("v2-connection-intent"),
			frame("semantic-reject-permit-response-descriptor-swap"),
		);
		await rejected(
			frame("v2-bootstrap-request-before-native-session"),
			frame("semantic-reject-bootstrap-response-requestid-swap"),
		);
	});
	it("rejects token fields in ordinary frames before invoking any handler", async () => {
		const handlers = await rejected(frame("reject-credential-in-operation"));
		expect(handlers.operation).not.toHaveBeenCalled();
		expect(handlers.bootstrap).not.toHaveBeenCalled();
	});
	it("never sends an oversized or poisoned token response", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		await rejected(
			frame("v2-bootstrap-request-before-native-session"),
			frame("reject-oversized-token"),
		);
		await rejected(
			frame("v2-bootstrap-request-before-native-session"),
			frame("reject-refresh-token-injection"),
		);
	});
	it.each(corpus.framingCases)(
		"rejects shared framing case $id before any handler",
		async (item) => {
			const bytes = item.wireHex
				? Buffer.from(item.wireHex, "hex")
				: Buffer.from(item.wireUtf8 ?? "");
			const handlers = await rejected(
				undefined,
				undefined,
				Buffer.concat([bytes, Buffer.from("\n")]),
			);
			expect(handlers.operation).not.toHaveBeenCalled();
			expect(handlers.bootstrap).not.toHaveBeenCalled();
		},
	);
	it("detects escaped duplicate keys without confusing colons inside string values", async () => {
		const input = JSON.stringify(
			frame("v2-bootstrap-request-before-native-session"),
		);
		const duplicate = `${input.slice(0, -1)},"\\u0070rofileRef":"connection-fixture-v1"}\n`;
		const handlers = await rejected(
			undefined,
			undefined,
			Buffer.from(duplicate),
		);
		expect(handlers.bootstrap).not.toHaveBeenCalled();
	});
	it("cannot enable bootstrap through the legacy V1 reader", async () => {
		const { server, native } = pair();
		const handle = vi.fn();
		const failure = vi.fn();
		const channel = serveCodexNativeCallbacksV1(server, handle, failure);
		native.write(
			`${JSON.stringify(frame("v2-bootstrap-request-before-native-session"))}\n`,
		);
		await channel.finished;
		expect(handle).not.toHaveBeenCalled();
		expect(failure).toHaveBeenCalledOnce();
		native.destroy();
	});
});

describe("private recovery process channel", () => {
	it("routes a verify response only through the read-only handler", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const { server, native } = pair();
		const failure = vi.fn();
		const operation = vi.fn<CodexNativeCallbackHandler>();
		const bootstrap = vi.fn<CodexNativeConnectionBootstrapHandler>();
		const response = frame(
			"recovery-verify-valid",
		) as import("./codex-connection-client.js").CodexConnectionRecoveryResponse;
		const recover = vi.fn(async () => response);
		const channel = serveCodexNativeCallbacks(
			server,
			operation,
			bootstrap,
			failure,
			recover,
		);
		const replied = once(native, "data");
		native.write(`${JSON.stringify(response.request)}\n`);
		const [bytes] = await replied;
		expect(JSON.parse(bytes.toString())).toEqual(response);
		expect(recover).toHaveBeenCalledOnce();
		expect(operation).not.toHaveBeenCalled();
		expect(bootstrap).not.toHaveBeenCalled();
		channel.close();
		await channel.finished;
		native.destroy();
		expect(failure).not.toHaveBeenCalled();
	});

	it.each(["done", "unavailable", "sixteen", "premature", "trailing"] as const)(
		"enforces %s EOF completion without accepting partial frames",
		async (mode) => {
			vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
			const { server, native } = pair();
			const failure = vi.fn();
			const response = frame(
				mode === "done" || mode === "trailing"
					? "recovery-done-valid"
					: mode === "unavailable"
						? "recovery-unavailable-valid"
						: "recovery-verify-valid",
			) as import("./codex-connection-client.js").CodexConnectionRecoveryResponse;
			let issued = 0;
			let terminal = false;
			const channel = serveCodexNativeCallbacks(
				server,
				vi.fn<CodexNativeCallbackHandler>(),
				undefined,
				failure,
				async (request) => {
					if (response.decision === "verify") issued++;
					else terminal = true;
					return { ...response, requestId: request.requestId, request };
				},
				() => terminal || issued >= 16,
			);
			for (let index = 0; index < (mode === "sixteen" ? 16 : 1); index++) {
				const replied = once(native, "data");
				native.write(`${JSON.stringify(response.request)}\n`);
				await replied;
			}
			if (mode === "trailing") native.write("{");
			native.end();
			await channel.finished;
			expect(failure).toHaveBeenCalledTimes(
				mode === "premature" || mode === "trailing" ? 1 : 0,
			);
			native.destroy();
		},
	);
});
