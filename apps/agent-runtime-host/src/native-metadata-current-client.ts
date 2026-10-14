import { Buffer } from "node:buffer";
import {
	type NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentRequestV1Schema,
	type NativeMetadataCurrentResponseV1,
	NativeMetadataCurrentResponseV1Schema,
	runtimeNativeMetadataRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";

const path = "internal/platform-worker/v1/native-metadata/current";
const maximumResponseBytes = 64 * 1024;
const timeoutMs = 10_000;

function binding(
	value: Extract<NativeMetadataCurrentRequestV1, { phase: "read_metadata" }>,
) {
	const { phase: _phase, ...rest } = value;
	return rest;
}

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
		(origin.pathname !== "/" && origin.pathname !== "") ||
		origin.search ||
		origin.hash
	)
		throw new TypeError("Platform Worker base URL is invalid");
	return new URL(path, `${origin.origin}/`);
}

async function responseText(response: Response) {
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
		return Buffer.concat(chunks, bytes).toString("utf8");
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

/** Host → fixed Worker current-confirmation transport. */
export function createRuntimeNativeMetadataCurrentClientV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
}) {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("Platform Worker service token is invalid");
	const url = endpoint(options.baseUrl);
	const fetcher = options.fetch ?? fetch;
	return {
		async check(input: {
			readonly request: NativeMetadataCurrentRequestV1;
			readonly apiRequestSourceRef: string;
			readonly signal: AbortSignal;
		}): Promise<NativeMetadataCurrentResponseV1> {
			try {
				if (input.request.phase !== "read_metadata")
					return { outcome: "unavailable" };
				if (
					typeof input.apiRequestSourceRef !== "string" ||
					input.apiRequestSourceRef.length < 1 ||
					input.apiRequestSourceRef.length > 256
				)
					return { outcome: "unavailable" };
				const request = NativeMetadataCurrentRequestV1Schema.parse(
					input.request,
				);
				const metadataRequest = request as Extract<
					NativeMetadataCurrentRequestV1,
					{ phase: "read_metadata" }
				>;
				const signal = AbortSignal.any([
					input.signal,
					AbortSignal.timeout(timeoutMs),
				]);
				const response = await fetcher(url, {
					method: "POST",
					redirect: "error",
					credentials: "omit",
					headers: {
						authorization: `Bearer ${options.serviceToken}`,
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({
						apiRequestSourceRef: input.apiRequestSourceRef,
						request: metadataRequest,
					}),
					signal,
				});
				if (!response.ok || response.redirected) throw new Error();
				const result = NativeMetadataCurrentResponseV1Schema.parse(
					JSON.parse(await responseText(response)),
				);
				if (
					result.outcome === "allowed" &&
					(result.request.phase !== "read_metadata" ||
						runtimeNativeMetadataRequestSigningPayloadV1(
							binding(result.request),
						) !==
							runtimeNativeMetadataRequestSigningPayloadV1(
								binding(metadataRequest),
							))
				)
					return { outcome: "unavailable" };
				return result;
			} catch {
				return { outcome: "unavailable" };
			}
		},
	};
}
