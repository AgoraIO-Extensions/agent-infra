import {
	type PlatformNativeMetadataReadRequestV1,
	PlatformNativeMetadataReadRequestV1Schema,
	RuntimeNativeMetadataProofMaximumLifetimeMsV1,
	RuntimeNativeMetadataReadResponseV1Schema,
} from "@agent-infra/contracts/runtime";
import { createNativeMetadataJsonTransport } from "@agent-infra/native-metadata-transport";

const maximumResponseBytes = 1_048_576;
// Current-confirmation callbacks share the original request's fixed deadline.
// A shorter transport default can reject a healthy chain before that deadline.
const transportTimeoutMs = RuntimeNativeMetadataProofMaximumLifetimeMsV1;

/** API → fixed Worker gateway transport; API never creates a native proof. */
export function createPlatformWorkerNativeMetadataGatewayClientV1(options: {
	readonly baseUrl: string;
	readonly serviceToken: string;
	readonly fetch?: typeof fetch;
	readonly transportTimeoutMs?: number;
}) {
	const post = createNativeMetadataJsonTransport({
		...options,
		peer: "Platform Worker",
		path: "internal/platform-worker/v1/native-metadata",
		maximumResponseBytes,
		strictJson: false,
	});
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
			try {
				const response = await post(JSON.stringify(request), {
					signal: transportSignal,
				});
				return RuntimeNativeMetadataReadResponseV1Schema.parse(response.value);
			} catch {
				throw new Error("PLATFORM_WORKER_UNAVAILABLE");
			}
		},
	};
}
