import {
	type RuntimeNativeMetadataReadRequestV1,
	RuntimeNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataReadResponseV1Schema,
	runtimeNativeMetadataRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import { createNativeMetadataJsonTransport } from "@agent-infra/native-metadata-transport";

const maximumResponseBytes = 1_048_576;

/** Authenticated Worker → RuntimeHost native metadata transport. */
export function createWorkerRuntimeNativeMetadataClientV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
}) {
	const post = createNativeMetadataJsonTransport({
		...options,
		peer: "RuntimeHost",
		path: "internal/runtime/v1/native-metadata",
		maximumResponseBytes,
		strictJson: true,
		allowBasePath: true,
	});
	return {
		async read(
			value: RuntimeNativeMetadataReadRequestV1,
			signal?: AbortSignal,
		) {
			const request = RuntimeNativeMetadataReadRequestV1Schema.parse(value);
			try {
				const response = await post(JSON.stringify(request), {
					signal: signal,
					traceId: request.traceId,
				});
				const result = RuntimeNativeMetadataReadResponseV1Schema.parse(
					response.value,
				);
				const { projection: _projection, ...responseBinding } = result;
				const {
					proof: _proof,
					apiRequestSourceRef: _source,
					...requestBinding
				} = request;
				if (
					runtimeNativeMetadataRequestSigningPayloadV1(responseBinding) !==
					runtimeNativeMetadataRequestSigningPayloadV1(requestBinding)
				)
					throw new Error("RUNTIME_NATIVE_METADATA_BINDING_INVALID");
				return result;
			} catch {
				throw new Error("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
			}
		},
	};
}
