import type {
	RuntimeHost,
	RuntimeHostNativeMetadataReadContextV1,
} from "@agent-infra/agent-runtime";
import { RuntimeHostError } from "@agent-infra/agent-runtime";
import {
	type RuntimeNativeMetadataReadRequestV1,
	RuntimeNativeMetadataReadRequestV1Schema,
} from "@agent-infra/contracts/runtime";

export interface RuntimeNativeMetadataReadAssemblyV1 {
	/**
	 * Resolve the request-local Worker proof/current binding. Implementations
	 * must use the fixed deployment association for this Host and never accept a
	 * caller-selected URL, service identity, or scope.
	 */
	resolveContext(input: {
		readonly request: RuntimeNativeMetadataReadRequestV1;
		readonly signal: AbortSignal;
	}): Promise<RuntimeHostNativeMetadataReadContextV1 | null>;
}

/**
 * Bind the deployment-owned proof/current resolver to the RuntimeHost
 * lifecycle. RuntimeHost remains the authority for pre/post Driver checks and
 * projection validation; the resolver only supplies request-local evidence.
 */
export function createRuntimeNativeMetadataReadV1(
	host: Pick<RuntimeHost, "readNativeMetadataV1">,
	assembly: RuntimeNativeMetadataReadAssemblyV1,
) {
	if (
		typeof host?.readNativeMetadataV1 !== "function" ||
		typeof assembly?.resolveContext !== "function"
	)
		throw new TypeError("Runtime native metadata assembly is invalid");
	return async (
		value: RuntimeNativeMetadataReadRequestV1,
		signal: AbortSignal,
	) => {
		const parsed = RuntimeNativeMetadataReadRequestV1Schema.safeParse(value);
		if (!parsed.success)
			throw new RuntimeHostError(
				"RUNTIME_REQUEST_INVALID",
				"Runtime request is invalid",
				400,
			);
		const request = parsed.data;
		if (signal.aborted) throw unavailable();
		try {
			const context = await assembly.resolveContext({ request, signal });
			if (!context) throw unavailable();
			return await host.readNativeMetadataV1(request, { ...context, signal });
		} catch (error) {
			if (error instanceof RuntimeHostError) throw error;
			throw unavailable();
		}
	};
}

function unavailable() {
	return new RuntimeHostError(
		"RUNTIME_NATIVE_METADATA_UNAVAILABLE",
		"Runtime native metadata is unavailable",
		503,
		true,
	);
}
