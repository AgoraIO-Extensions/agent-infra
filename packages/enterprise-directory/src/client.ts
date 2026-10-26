import {
	type DirectorySnapshot,
	DirectoryUnavailableError,
	requireCurrentSnapshot,
} from "./snapshot.js";
import { fromDirectorySnapshot } from "./wire.js";

export interface DirectoryClientConfig {
	endpoint: string;
	token: string;
	/** Maximum time to wait for the directory snapshot response. */
	timeoutMs?: number;
	fetch?: typeof fetch;
}

export function createDirectoryClient(config: DirectoryClientConfig) {
	const endpoint = new URL(config.endpoint);
	if (
		endpoint.protocol !== "https:" ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		Buffer.byteLength(config.token) < 32
	) {
		throw new DirectoryUnavailableError();
	}
	const timeoutMs = config.timeoutMs ?? 5_000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
		throw new DirectoryUnavailableError();
	}
	const fetcher = config.fetch ?? fetch;
	async function fetchSnapshot(): Promise<DirectorySnapshot> {
		const response = await fetcher(endpoint, {
			method: "GET",
			headers: { Authorization: `Bearer ${config.token}` },
			redirect: "error",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) throw new DirectoryUnavailableError();
		return fromDirectorySnapshot(await response.json());
	}
	/**
	 * 正在进行的那次取快照（#2740）。同一时刻的调用共用它，而不是各发一次请求：Worker 重启时
	 * 同一时刻有几十个身份解析，各自新建连接、各做一次 DNS 解析，会排进 libuv 线程池而超时。
	 * 请求结束（成功或失败）就清空，之后的调用重新取，不缓存已经取到的快照。
	 */
	let inflight: Promise<DirectorySnapshot> | undefined;
	return {
		async loadCurrent(now = Date.now()): Promise<DirectorySnapshot> {
			try {
				if (!inflight) {
					const pending = fetchSnapshot();
					inflight = pending;
					void pending
						.finally(() => {
							if (inflight === pending) inflight = undefined;
						})
						.catch(() => undefined);
				}
				const snapshot = await inflight;
				// 有效期仍按每个调用自己的时间校验；每个调用拿到独立副本，互不影响。
				return requireCurrentSnapshot(structuredClone(snapshot), now);
			} catch {
				throw new DirectoryUnavailableError();
			}
		},
	};
}
