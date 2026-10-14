export type BrowserHandoffTimelineStatusV1 =
	| "requested"
	| "active"
	| "returning"
	| "completed"
	| "revoked"
	| "expired"
	| "crashed"
	| "unknown";

export type BrowserHandoffTimelineEventV1 = Readonly<{
	type: "browser.handoff";
	payload: Readonly<{
		handoffId: string;
		status: BrowserHandoffTimelineStatusV1;
		reason: "login" | "mfa" | "captcha" | "human_judgment";
		expiresAt: string;
		operatorId?: string;
		terminalReason?: string;
		binding: Readonly<{
			subjectId: string;
			agentId: string;
			conversationId: string;
			executionId: string;
			sessionGeneration: number;
			resourceFence: number;
			workloadRevision: number;
			imageDigest: string;
			capabilityVersion: number;
			pageRevision: number;
		}>;
	}>;
}>;

/** Retains the latest server event; timeline cursor/event-id deduplication is
 * still owned by the existing Conversation timeline reader. */
export function latestBrowserHandoffTimelineEventV1(
	events: readonly unknown[],
): BrowserHandoffTimelineEventV1 | undefined {
	for (const candidate of [...events].reverse()) {
		if (
			typeof candidate !== "object" ||
			candidate === null ||
			(candidate as { readonly type?: unknown }).type !== "browser.handoff"
		)
			continue;
		const payload = (candidate as { readonly payload?: unknown }).payload;
		if (
			typeof payload !== "object" ||
			payload === null ||
			typeof (payload as { readonly handoffId?: unknown }).handoffId !==
				"string" ||
			(payload as { readonly handoffId: string }).handoffId.length === 0
		)
			continue;
		return candidate as BrowserHandoffTimelineEventV1;
	}
	return undefined;
}
