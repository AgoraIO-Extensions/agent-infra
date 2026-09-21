import type { Client, RequestResult } from "../pilot/generated/client/index.js";
import { getCurrentSession } from "../pilot/generated/sdk.gen.js";
import type {
	BrowserSessionProjectionV1,
	GetCurrentSessionErrors,
	GetCurrentSessionResponses,
} from "../pilot/generated/types.gen.js";

export type BrowserSessionState =
	| {
			kind: "ready";
			session: BrowserSessionProjectionV1;
			sessionGeneration?: string;
	  }
	| { kind: "unavailable"; retryable: boolean };

function unavailable(error: { retryable?: boolean } | undefined) {
	if (error?.retryable !== false)
		throw Object.assign(
			new Error("Agent administration is temporarily unavailable"),
			{
				retryable: true,
			},
		);
	return { kind: "unavailable" as const, retryable: false };
}

export async function loadBrowserSession(
	client?: Client,
): Promise<BrowserSessionState> {
	const result: Awaited<
		RequestResult<GetCurrentSessionResponses, GetCurrentSessionErrors, false>
	> = await getCurrentSession<false>({
		client,
		responseStyle: "fields",
		throwOnError: false,
	});
	const generation = result.response?.headers.get(
		"x-platform-session-generation",
	);
	return result.data
		? {
				kind: "ready",
				session: result.data,
				...(generation && /^[A-Za-z0-9_-]{43}$/.test(generation)
					? { sessionGeneration: generation }
					: {}),
			}
		: unavailable(result.error);
}
