import { Buffer } from "node:buffer";
import {
	type RuntimeModelDirectoryRequestV1,
	RuntimeModelDirectoryRequestV1Schema,
	RuntimeModelDirectoryResponseV1Schema,
} from "@agent-infra/contracts/runtime";

const maximumResponseBytes = 1_048_576;

function endpoint(baseUrl: string) {
	let origin: URL;
	try {
		origin = new URL(baseUrl);
	} catch {
		throw new TypeError("RuntimeHost base URL is invalid");
	}
	if (
		origin.protocol !== "http:" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash
	)
		throw new TypeError("RuntimeHost base URL is invalid");
	return new URL(
		"internal/runtime/v1/model-directory",
		`${origin.href.replace(/\/$/, "")}/`,
	);
}

async function responseText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("RUNTIME_MODEL_DIRECTORY_UNAVAILABLE");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.value) {
				bytes += next.value.byteLength;
				if (bytes > maximumResponseBytes)
					throw new Error("RUNTIME_MODEL_DIRECTORY_UNAVAILABLE");
				chunks.push(next.value);
			}
			if (next.done) break;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks, bytes),
		);
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

/**
 * Authenticated Worker → RuntimeHost model-directory transport.  The caller
 * must provide the already bound Session scope and proof; this client never
 * accepts an origin, Agent id or identity from a browser request.
 */
export function createWorkerRuntimeModelDirectoryClientV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
}) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("RuntimeHost service token is invalid");
	const url = endpoint(options.baseUrl);
	const fetcher = options.fetch ?? fetch;
	return {
		async read(value: RuntimeModelDirectoryRequestV1, signal?: AbortSignal) {
			const request = RuntimeModelDirectoryRequestV1Schema.parse(value);
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
					signal,
				});
				if (
					!response.ok ||
					response.redirected ||
					!/^application\/json(?:\s*;|$)/i.test(
						response.headers.get("content-type") ?? "",
					)
				)
					throw new Error("RUNTIME_MODEL_DIRECTORY_UNAVAILABLE");
				const body = RuntimeModelDirectoryResponseV1Schema.parse(
					JSON.parse(await responseText(response)),
				);
				if (
					body.hostSessionRef !== request.hostSessionRef ||
					body.executionId !== request.executionId
				)
					throw new Error("RUNTIME_MODEL_DIRECTORY_BINDING_INVALID");
				return body;
			} catch {
				await response?.body?.cancel().catch(() => undefined);
				throw new Error("RUNTIME_MODEL_DIRECTORY_UNAVAILABLE");
			}
		},
	};
}
