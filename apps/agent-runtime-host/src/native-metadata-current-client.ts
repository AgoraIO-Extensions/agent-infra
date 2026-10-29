import {
	type NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentRequestV1Schema,
	type NativeMetadataCurrentResponseV1,
	NativeMetadataCurrentResponseV1Schema,
	runtimeNativeMetadataRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import { createNativeMetadataJsonTransport } from "@agent-infra/native-metadata-transport";

const path = "internal/platform-worker/v1/native-metadata/current";
const maximumResponseBytes = 64 * 1024;
const timeoutMs = 10_000;

function binding(
	value: Extract<NativeMetadataCurrentRequestV1, { phase: "read_metadata" }>,
) {
	const { phase: _phase, ...rest } = value;
	return rest;
}

/** Host → fixed Worker current-confirmation transport. */
export function createRuntimeNativeMetadataCurrentClientV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
}) {
	const post = createNativeMetadataJsonTransport({
		...options,
		peer: "Platform Worker",
		path: path,
		maximumResponseBytes,
		strictJson: false,
	});
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
				const response = await post(
					JSON.stringify({
						apiRequestSourceRef: input.apiRequestSourceRef,
						request: metadataRequest,
					}),
					{ signal },
				);
				const result = NativeMetadataCurrentResponseV1Schema.parse(
					response.value,
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
