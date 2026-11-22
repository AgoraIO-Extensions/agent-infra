/** HLD §8.2.1: archive work never changes the persisted business result. */
export interface ConversationArchiveStateV1 {
	readonly schemaVersion: 1;
	readonly ref: string;
	readonly revision: number;
	readonly status: "pending" | "unavailable" | "complete";
	readonly startedAtMs: number;
	readonly deadlineAtMs: number;
	readonly lastProgressAtMs: number | null;
	readonly cursor: string | null;
	readonly acknowledgedCursor: string | null;
}

export interface ConversationArchiveProjectionV1 {
	readonly schemaVersion: 1;
	readonly status: "pending" | "unavailable";
	readonly deadlineAt: string;
}

export function parseConversationArchiveStateV1(
	input: unknown,
): ConversationArchiveStateV1 {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new TypeError("Invalid archive state");
	const v = input as Record<string, unknown>;
	if (
		Object.keys(v).sort().join(",") !==
			"acknowledgedCursor,cursor,deadlineAtMs,lastProgressAtMs,ref,revision,schemaVersion,startedAtMs,status" ||
		v.schemaVersion !== 1 ||
		typeof v.ref !== "string" ||
		!v.ref ||
		v.ref.length > 128 ||
		!Number.isSafeInteger(v.revision) ||
		(v.revision as number) < 1 ||
		!["pending", "unavailable", "complete"].includes(v.status as string) ||
		!Number.isSafeInteger(v.startedAtMs) ||
		!Number.isSafeInteger(v.deadlineAtMs) ||
		(v.startedAtMs as number) < 0 ||
		(v.deadlineAtMs as number) <= (v.startedAtMs as number) ||
		!(
			v.lastProgressAtMs === null ||
			(Number.isSafeInteger(v.lastProgressAtMs) &&
				(v.lastProgressAtMs as number) >= (v.startedAtMs as number))
		) ||
		![v.cursor, v.acknowledgedCursor].every(
			(x) =>
				x === null ||
				(typeof x === "string" && x.length > 0 && x.length <= 8192),
		)
	)
		throw new TypeError("Invalid archive state");
	return input as ConversationArchiveStateV1;
}

export function projectConversationArchiveV1(
	input: unknown,
): ConversationArchiveProjectionV1 | undefined {
	if (input == null) return undefined;
	const state = parseConversationArchiveStateV1(input);
	return state.status === "complete"
		? undefined
		: {
				schemaVersion: 1,
				status: state.status,
				deadlineAt: new Date(state.deadlineAtMs).toISOString(),
			};
}

/** Advance only control-archive facts; retry, lease changes and progress never extend the deadline. */
export function advanceConversationArchiveV1(input: {
	readonly previous?: ConversationArchiveStateV1;
	readonly ref: string;
	readonly nowMs: number;
	readonly budgetMs: number;
	readonly cursor: string | null;
	readonly acknowledgedCursor?: string;
	readonly complete?: true;
	/** HLD §8.2.1: an enum-only result may expire only with original-target unavailability. */
	readonly terminalSourceVerified?: boolean;
	readonly targetUnavailable?: boolean;
}): ConversationArchiveStateV1 {
	const before = input.previous;
	const archive: ConversationArchiveStateV1 = before ?? {
		schemaVersion: 1,
		ref: input.ref,
		revision: 1,
		status: "pending",
		startedAtMs: input.nowMs,
		deadlineAtMs: input.nowMs + input.budgetMs,
		cursor: input.cursor,
		acknowledgedCursor: null,
		lastProgressAtMs: null,
	};
	const acknowledgedCursor =
		input.acknowledgedCursor ?? archive.acknowledgedCursor;
	return parseConversationArchiveStateV1({
		...archive,
		status: input.complete
			? "complete"
			: input.nowMs >= archive.deadlineAtMs &&
					(input.terminalSourceVerified !== false ||
						input.targetUnavailable === true)
				? "unavailable"
				: archive.status,
		cursor: input.cursor,
		acknowledgedCursor,
		lastProgressAtMs:
			(before && before.cursor !== input.cursor) ||
			archive.acknowledgedCursor !== acknowledgedCursor
				? input.nowMs
				: archive.lastProgressAtMs,
	});
}
