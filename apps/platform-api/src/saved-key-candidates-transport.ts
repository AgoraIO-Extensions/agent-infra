import { Buffer } from "node:buffer";
import {
	type RuntimeSavedKeyCandidatesRequestV1,
	RuntimeSavedKeyCandidatesRequestV1Schema,
	RuntimeSavedKeyCandidatesResponseV1Schema,
} from "@agent-infra/contracts/runtime";

const maximumResponseBytes = 1_048_576;

function endpoint(baseUrl: string) {
	const origin = new URL(baseUrl);
	if (
		origin.protocol !== "http:" ||
		origin.username ||
		origin.password ||
		(origin.pathname !== "/" && origin.pathname !== "") ||
		origin.search ||
		origin.hash
	)
		throw new TypeError("Platform Worker base URL is invalid");
	return new URL(
		"internal/worker/v1/saved-key-candidates",
		`${origin.origin}/`,
	);
}

async function boundedJson(response: Response) {
	const reader = response.body?.getReader();
	if (!reader)
		throw new Error("PLATFORM_WORKER_SAVED_KEY_CANDIDATES_UNAVAILABLE");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.value) {
				bytes += next.value.byteLength;
				if (bytes > maximumResponseBytes)
					throw new Error("PLATFORM_WORKER_SAVED_KEY_CANDIDATES_UNAVAILABLE");
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

/** API → Worker saved-Key candidate transport; no plaintext crosses the API. */
export function createWorkerSavedKeyCandidatesTransportV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
}) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("Platform Worker service token is invalid");
	const url = endpoint(options.baseUrl);
	const fetcher = options.fetch ?? fetch;
	return {
		async read(
			value: RuntimeSavedKeyCandidatesRequestV1,
			signal?: AbortSignal,
		) {
			const request = RuntimeSavedKeyCandidatesRequestV1Schema.parse(value);
			const response = await fetcher(url, {
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
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
					: AbortSignal.timeout(30_000),
			});
			if (
				!response.ok ||
				response.redirected ||
				!/^application\/json(?:\s*;|$)/i.test(
					response.headers.get("content-type") ?? "",
				)
			)
				throw new Error("PLATFORM_WORKER_SAVED_KEY_CANDIDATES_UNAVAILABLE");
			return RuntimeSavedKeyCandidatesResponseV1Schema.parse(
				await boundedJson(response),
			);
		},
	};
}
