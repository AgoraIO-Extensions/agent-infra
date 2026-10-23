import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BrowserSessionState } from "./browser-session.js";
import { useSessionRecheck } from "./session-recheck.js";
import { BrowserSessionQueryContext } from "./use-browser-session.js";

const readySession: BrowserSessionState = {
	kind: "ready",
	session: {
		schemaVersion: 1,
		user: {
			userId: "recheck-user",
			displayName: "复核用户",
			roles: ["employee"],
		},
	},
};

/** 壳层的会话缓存：已有一次会话结果，每次重读按 next 返回会话状态或失败。 */
function shell(next: () => BrowserSessionState | Error) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const read = vi.fn(async () => {
		const value = next();
		if (value instanceof Error) throw value;
		return value;
	});
	client.setQueryDefaults(["browser-session"], { queryFn: read });
	client.setQueryData(["browser-session"], readySession);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BrowserSessionQueryContext.Provider value={client}>
			{children}
		</BrowserSessionQueryContext.Provider>
	);
	return { client, read, wrapper };
}

describe("useSessionRecheck", () => {
	it("reports whether the session is still valid and only then calls onStillValid (W-03)", async () => {
		let next: BrowserSessionState | Error = readySession;
		const { read, wrapper } = shell(() => next);
		const onStillValid = vi.fn();
		const { result } = renderHook(() => useSessionRecheck(onStillValid), {
			wrapper,
		});
		let valid: boolean | undefined;
		await act(async () => {
			valid = await result.current.recheck();
		});
		expect(read).toHaveBeenCalledTimes(1);
		expect(valid).toBe(true);
		expect(onStillValid).toHaveBeenCalledOnce();

		next = { kind: "unavailable", retryable: true };
		await act(async () => {
			valid = await result.current.recheck();
		});
		expect(valid).toBe(false);
		expect(onStillValid).toHaveBeenCalledOnce();

		next = new Error("controlled anonymous session");
		await act(async () => {
			valid = await result.current.recheck();
		});
		expect(valid).toBe(false);
		expect(onStillValid).toHaveBeenCalledOnce();
		expect(result.current.checking).toBe(false);
	});

	it("works without a callback for pages that own their read (Relay Key)", async () => {
		const { wrapper } = shell(() => readySession);
		const { result } = renderHook(() => useSessionRecheck(), { wrapper });
		let valid: boolean | undefined;
		await act(async () => {
			valid = await result.current.recheck();
		});
		expect(valid).toBe(true);
	});

	it("returns false without a shell session client", async () => {
		const { result } = renderHook(() => useSessionRecheck(vi.fn()));
		let valid: boolean | undefined;
		await act(async () => {
			valid = await result.current.recheck();
		});
		expect(valid).toBe(false);
	});
});
