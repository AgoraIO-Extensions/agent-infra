// Adapted from Paseo JsonlRpcProcess/PiCliRuntimeSession, d1b705a0cd91617a5707fae25d80cb0be3057950.
// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see THIRD_PARTY_NOTICES.md.
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
	type NativeProcessLaunch,
	spawnNativeProcess,
} from "./native-process.js";

export type PiFrame = Record<string, unknown>;
export const piRecord = (value: unknown): PiFrame | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as PiFrame)
		: undefined;
const unavailable = () => new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");

/** Persistent Pi RPC correlation. Peer frames and stderr never become diagnostics. */
export async function openPiRpc(
	directory: string,
	cwd: string,
	launch: NativeProcessLaunch,
	onEvent: (event: PiFrame) => void,
	onExit: () => void,
) {
	const owned = await spawnNativeProcess(
		directory,
		cwd,
		launch,
		"AGENT_INFRA_PI_OWNER",
	).catch(async () => {
		await launch.close?.();
		throw unavailable();
	});
	const pending = new Map<
		string,
		{
			command: string;
			resolve: (data: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let disposed = false;
	let closing: Promise<void> | undefined;
	const fail = () => {
		if (disposed) return;
		disposed = true;
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(unavailable());
		}
		pending.clear();
		onExit();
	};
	const close = () => {
		closing ??= (async () => {
			fail();
			try {
				await owned.close();
			} finally {
				await launch.close?.();
			}
		})();
		return closing;
	};
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	owned.child.stdout.on("data", (chunk: Buffer) => {
		buffer += decoder.write(chunk);
		let newline = buffer.indexOf("\n");
		while (newline >= 0 && !disposed) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (Buffer.byteLength(line) > 1_048_576) {
				void close().catch(() => {});
				return;
			}
			try {
				const frame = piRecord(JSON.parse(line));
				if (!frame || typeof frame.type !== "string") throw unavailable();
				if (frame.type === "response") {
					const request =
						typeof frame.id === "string" ? pending.get(frame.id) : undefined;
					if (request) {
						clearTimeout(request.timer);
						pending.delete(String(frame.id));
						if (frame.command !== request.command) {
							request.reject(unavailable());
							void close().catch(() => {});
							return;
						}
						if (frame.success !== true) request.reject(unavailable());
						else request.resolve(frame.data);
					}
				} else onEvent(frame);
			} catch {
				void close().catch(() => {});
				return;
			}
			newline = buffer.indexOf("\n");
		}
		if (Buffer.byteLength(buffer) > 1_048_576) void close().catch(() => {});
	});
	owned.child.stdin.on("error", () => {
		void close().catch(() => {});
	});
	void owned.exited.then(fail);
	const send = (frame: PiFrame) => {
		if (disposed || !owned.child.stdin.writable) throw unavailable();
		owned.child.stdin.write(`${JSON.stringify(frame)}\n`);
	};
	return {
		close,
		send,
		reusable: () => !disposed,
		request(type: string, values: PiFrame = {}) {
			if (disposed) return Promise.reject(unavailable());
			const id = randomUUID();
			return new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(unavailable());
					void close().catch(() => {});
				}, 30_000);
				pending.set(id, { command: type, resolve, reject, timer });
				try {
					send({ ...values, type, id });
				} catch {
					clearTimeout(timer);
					pending.delete(id);
					reject(unavailable());
				}
			});
		},
	};
}
