import { Buffer } from "node:buffer";
import {
	type RuntimeModelDirectoryDispatchRequestV1,
	RuntimeModelDirectoryDispatchRequestV1Schema,
	RuntimeModelDirectoryResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import type { RuntimeModelDirectoryDispatchTransportV1 } from "./runtime-model-selection-reader.js";

const maximumResponseBytes = 1_048_576;

function endpoint(baseUrl: string) {
	let origin: URL;
	try {
		origin = new URL(baseUrl);
	} catch {
		throw new TypeError("Platform Worker base URL is invalid");
	}
	if (
		origin.protocol !== "http:" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash
	)
		throw new TypeError("Platform Worker base URL is invalid");
	return new URL(
		"internal/worker/v1/model-directory",
		`${origin.href.replace(/\/$/, "")}/`,
	);
}

async function boundedJson(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("PLATFORM_WORKER_MODEL_DIRECTORY_UNAVAILABLE");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.value) {
				bytes += next.value.byteLength;
				if (bytes > maximumResponseBytes)
					throw new Error("PLATFORM_WORKER_MODEL_DIRECTORY_UNAVAILABLE");
				chunks.push(next.value);
			}
			if (next.done) break;
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.concat(chunks, bytes),
			),
		);
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

/** Authenticated API → Worker model-directory transport. */
export function createWorkerRuntimeModelDirectoryTransportV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
}): RuntimeModelDirectoryDispatchTransportV1 {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("Platform Worker service token is invalid");
	const url = endpoint(options.baseUrl);
	const fetcher = options.fetch ?? fetch;
	return {
		async read(value: RuntimeModelDirectoryDispatchRequestV1, signal) {
			const request = RuntimeModelDirectoryDispatchRequestV1Schema.parse(value);
			let response: Response | undefined;
			try {
				response = await fetcher(url, {
					method: "POST",
					redirect: "error",
					credentials: "omit",
					headers: {
						authorization: `Bearer ${options.serviceToken}`,
						"content-type": "application/json",
						accept: "application/json",
						"x-trace-id": request.traceId,
					},
					body: JSON.stringify(request),
					signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
				});
				if (
					!response.ok ||
					response.redirected ||
					!/^application\/json(?:\s*;|$)/i.test(
						response.headers.get("content-type") ?? "",
					)
				)
					throw new Error("PLATFORM_WORKER_MODEL_DIRECTORY_UNAVAILABLE");
				return RuntimeModelDirectoryResponseV1Schema.parse(
					await boundedJson(response),
				);
			} catch {
				await response?.body?.cancel().catch(() => undefined);
				throw new Error("PLATFORM_WORKER_MODEL_DIRECTORY_UNAVAILABLE");
			}
		},
	};
}
