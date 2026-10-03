import { performance } from "node:perf_hooks";
import {
	type PlatformNativeMetadataReadRequestV1,
	PlatformNativeMetadataReadRequestV1Schema,
} from "@agent-infra/contracts";
import { RuntimeNativeMetadataReadResponseV1Schema } from "@agent-infra/contracts/runtime";

// Accommodates worst-case JSON escaping of 128 bounded Unicode descriptions.
const maximumResponseBytes = 8_388_608;
const failureMessage = "Native metadata transport is unavailable";

/** Deployment fixes the exact Worker instance and API source; callers supply neither URL nor credentials. */
export function createPlatformNativeMetadataWorkerClientV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly apiRequestSourceRef: string;
	readonly fetch?: typeof fetch;
}) {
	const { serviceToken, apiRequestSourceRef } = options;
	const fetcher = options.fetch ?? fetch;
	let endpoint: string;
	try {
		const origin = new URL(options.baseUrl);
		if (
			!["http:", "https:"].includes(origin.protocol) ||
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash ||
			typeof serviceToken !== "string" ||
			!/^[\x21-\x7e]{1,8192}$/.test(serviceToken) ||
			typeof apiRequestSourceRef !== "string" ||
			!apiRequestSourceRef ||
			apiRequestSourceRef.includes("\0")
		)
			throw new Error();
		endpoint = new URL(
			"/internal/platform-worker/v1/native-metadata/reads",
			origin,
		).href;
	} catch {
		throw new Error(failureMessage);
	}
	return {
		async submit(
			value: PlatformNativeMetadataReadRequestV1,
			signal: AbortSignal,
		): Promise<unknown> {
			let active = true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			let response: Response | undefined;
			let cancel = () => {};
			try {
				const request = PlatformNativeMetadataReadRequestV1Schema.parse(value);
				if (request.apiRequestSourceRef !== apiRequestSourceRef)
					throw new Error();
				const remaining = Math.min(30_000, request.expiresAt - Date.now());
				const monotonicDeadline = performance.now() + remaining;
				function assertActive() {
					if (
						!active ||
						signal.aborted ||
						Date.now() >= request.expiresAt ||
						performance.now() >= monotonicDeadline
					)
						throw new Error(failureMessage);
				}
				assertActive();
				const cancelled = new Promise<never>((_resolve, reject) => {
					cancel = () => {
						active = false;
						reject(new Error(failureMessage));
						void reader?.cancel().catch(() => {});
					};
				});
				signal.addEventListener("abort", cancel, { once: true });
				timer = setTimeout(cancel, remaining);
				timer.unref();
				async function wait<T>(action: () => Promise<T>): Promise<T> {
					assertActive();
					const result = await Promise.race([
						cancelled,
						Promise.resolve().then(() => {
							assertActive();
							return action();
						}),
					]);
					assertActive();
					return result;
				}
				response = await wait(() =>
					fetcher(endpoint, {
						method: "POST",
						redirect: "error",
						credentials: "omit",
						cache: "no-store",
						headers: {
							authorization: `Bearer ${serviceToken}`,
							"content-type": "application/json",
							accept: "application/json",
							"x-trace-id": request.traceId,
						},
						body: JSON.stringify(request),
						signal,
					}).then((candidate) => {
						response = candidate;
						if (!active || signal.aborted) {
							void candidate.body?.cancel().catch(() => {});
							throw new Error(failureMessage);
						}
						return candidate;
					}),
				);
				assertActive();
				if (
					response.status !== 200 ||
					response.redirected ||
					(response.url && response.url !== endpoint) ||
					!/^application\/json(?:\s*;|$)/i.test(
						response.headers.get("content-type") ?? "",
					) ||
					!response.body ||
					Number(response.headers.get("content-length")) > maximumResponseBytes
				)
					throw new Error();
				const bodyReader = response.body.getReader();
				reader = bodyReader;
				const chunks: Uint8Array[] = [];
				let bytes = 0;
				for (;;) {
					const next = await wait(() => bodyReader.read());
					assertActive();
					if (next.done) break;
					bytes += next.value.byteLength;
					if (bytes > maximumResponseBytes) throw new Error();
					chunks.push(next.value);
				}
				const text = new TextDecoder("utf-8", { fatal: true }).decode(
					Buffer.concat(chunks, bytes),
				);
				const result = RuntimeNativeMetadataReadResponseV1Schema.parse(
					JSON.parse(text),
				);
				void reader.cancel().catch(() => {});
				reader.releaseLock();
				reader = undefined;
				assertActive();
				return result;
			} catch {
				throw new Error(failureMessage);
			} finally {
				active = false;
				clearTimeout(timer);
				signal.removeEventListener("abort", cancel);
				void reader?.cancel().catch(() => {});
				if (!reader) void response?.body?.cancel().catch(() => {});
			}
		},
	};
}
