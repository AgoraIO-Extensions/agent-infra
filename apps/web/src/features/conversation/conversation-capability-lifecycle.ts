export type ConversationCapabilityLifecycleStateV1 = Readonly<{
	scopeKey: string;
	capabilityKey: string | undefined;
	attemptId: string | undefined;
	phase: "idle" | "confirmed" | "pending" | "unknown" | "terminal";
	parameterText: string;
}>;

export function createConversationCapabilityLifecycleStateV1(scopeKey: string) {
	return {
		scopeKey,
		capabilityKey: undefined as string | undefined,
		attemptId: undefined as string | undefined,
		phase: "idle" as ConversationCapabilityLifecycleStateV1["phase"],
		parameterText: "",
	};
}

export function selectConversationCapabilityV1(
	state: ConversationCapabilityLifecycleStateV1,
	capabilityKey: string,
	parameterText = "",
) {
	if (state.phase === "pending" || state.phase === "unknown") return state;
	return {
		...state,
		capabilityKey,
		parameterText,
		phase: "confirmed" as const,
	};
}

export function acceptConversationCapabilityV1(
	state: ConversationCapabilityLifecycleStateV1,
	attemptId: string,
) {
	if (state.phase !== "confirmed" || !state.capabilityKey || !attemptId)
		return state;
	return { ...state, attemptId, phase: "pending" as const };
}

export function settleConversationCapabilityV1(
	state: ConversationCapabilityLifecycleStateV1,
	phase: "unknown" | "terminal",
) {
	if (state.phase !== "pending" || !state.attemptId) return state;
	return { ...state, phase };
}

export function retryConversationCapabilityV1(
	state: ConversationCapabilityLifecycleStateV1,
) {
	if (state.phase !== "unknown" || !state.attemptId) return state;
	return { ...state, phase: "pending" as const };
}

export function resetConversationCapabilityLifecycleV1(
	state: ConversationCapabilityLifecycleStateV1,
	scopeKey: string,
) {
	return state.scopeKey === scopeKey
		? state
		: createConversationCapabilityLifecycleStateV1(scopeKey);
}

export function canStartConversationCapabilityV1(
	state: ConversationCapabilityLifecycleStateV1,
) {
	return state.phase === "confirmed" && state.capabilityKey !== undefined;
}
