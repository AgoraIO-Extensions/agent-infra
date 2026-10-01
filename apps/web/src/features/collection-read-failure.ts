export type CollectionReadFailureReason =
	| "authentication-required"
	| "denied"
	| "not-found"
	| "invalid-response";

export type CollectionReadUnavailable = {
	kind: "unavailable";
	retryable: boolean;
	reason?: CollectionReadFailureReason;
};

/** Preserve received HTTP failures without treating a missing endpoint as logout. */
export function collectionReadFailure(
	status: number | undefined,
): CollectionReadUnavailable {
	return {
		kind: "unavailable",
		retryable: status === undefined || status === 429 || status >= 500,
		...(status === 401
			? { reason: "authentication-required" as const }
			: status === 403
				? { reason: "denied" as const }
				: status === 404
					? { reason: "not-found" as const }
					: {}),
	};
}
