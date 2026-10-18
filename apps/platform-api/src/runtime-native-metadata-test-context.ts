import { afterEach } from "vitest";
import type { IdentityContext } from "./http/identity.js";
import {
	createRuntimeNativeMetadataRequestContextV1,
	type RuntimeNativeMetadataRequestContextV1,
} from "./runtime-native-metadata-request-context.js";

const contexts = new Set<RuntimeNativeMetadataRequestContextV1>();
afterEach(() => {
	for (const context of contexts) context.close();
	contexts.clear();
});

/** Synthetic authentication only; actual route/HTTP evidence lives in the lifetime suite. */
export function nativeMetadataTestContext(
	identity: IdentityContext,
	binding?: { readonly readStartedAt: number; readonly expiresAt: number },
	now = () => binding?.readStartedAt ?? Date.now(),
) {
	const context = createRuntimeNativeMetadataRequestContextV1({
		signal: new AbortController().signal,
		authenticate: async () => identity,
		now,
	});
	if (binding) context.limit(binding.expiresAt);
	contexts.add(context);
	return context;
}
