import { Buffer } from "node:buffer";
import {
	type RuntimeNativeMetadataReadRequestV1,
	RuntimeNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataReadResponseV1Schema,
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
		"internal/runtime/v1/native-metadata",
		`${origin.href.replace(/\/$/, "")}/`,
	);
}

async function responseText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.value) {
				bytes += next.value.byteLength;
				if (bytes > maximumResponseBytes)
					throw new Error("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
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

/** Authenticated Worker → RuntimeHost native metadata transport. */
export function createWorkerRuntimeNativeMetadataClientV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
}) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("RuntimeHost service token is invalid");
	const url = endpoint(options.baseUrl);
	const fetcher = options.fetch ?? fetch;
	return {
		async read(
			value: RuntimeNativeMetadataReadRequestV1,
			signal?: AbortSignal,
		) {
			const request = RuntimeNativeMetadataReadRequestV1Schema.parse(value);
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
					throw new Error("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
				const result = RuntimeNativeMetadataReadResponseV1Schema.parse(
					JSON.parse(await responseText(response)),
				);
				if (
					result.readId !== request.readId ||
					result.selector !== request.selector ||
					result.scope.executionId !== request.scope.executionId ||
					result.originalHostScopeRef !== request.originalHostScopeRef
				)
					throw new Error("RUNTIME_NATIVE_METADATA_BINDING_INVALID");
				return result;
			} catch {
				await response?.body?.cancel().catch(() => undefined);
				throw new Error("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
			}
		},
	};
}
