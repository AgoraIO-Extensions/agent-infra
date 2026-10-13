import { Buffer } from "node:buffer";
import {
	type PlatformNativeMetadataReadRequestV1,
	PlatformNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataReadResponseV1Schema,
} from "@agent-infra/contracts/runtime";

const maximumResponseBytes = 1_048_576;
const transportTimeoutMs = 10_000;

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
		"internal/platform-worker/v1/native-metadata",
		`${origin.href.replace(/\/$/, "")}/`,
	);
}

async function responseText(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("PLATFORM_WORKER_UNAVAILABLE");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maximumResponseBytes)
				throw new Error("PLATFORM_WORKER_UNAVAILABLE");
			chunks.push(next.value);
		}
		return Buffer.concat(chunks, bytes).toString("utf8");
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

/** API → fixed Worker gateway transport; API never creates a native proof. */
export function createPlatformWorkerNativeMetadataGatewayClientV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
	readonly transportTimeoutMs?: number;
}) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("Platform Worker service token is invalid");
	const url = endpoint(options.baseUrl);
	const fetcher = options.fetch ?? fetch;
	const timeoutMs = options.transportTimeoutMs ?? transportTimeoutMs;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
		throw new TypeError("Platform Worker transport timeout is invalid");
	return {
		async read(
			value: PlatformNativeMetadataReadRequestV1,
			signal?: AbortSignal,
		) {
			const request = PlatformNativeMetadataReadRequestV1Schema.parse(value);
			const transportSignal = signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs);
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
					},
					body: JSON.stringify(request),
					signal: transportSignal,
				});
				if (!response.ok || response.redirected)
					throw new Error("PLATFORM_WORKER_UNAVAILABLE");
				return RuntimeNativeMetadataReadResponseV1Schema.parse(
					JSON.parse(await responseText(response)),
				);
			} catch {
				await response?.body?.cancel().catch(() => undefined);
				throw new Error("PLATFORM_WORKER_UNAVAILABLE");
			}
		},
	};
}
