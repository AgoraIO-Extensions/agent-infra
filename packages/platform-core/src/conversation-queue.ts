/**
 * Web 与托管渠道执行中消息的有界排队（工程 Spec §12.5，ADR-0033 决策 1、2、4）。
 *
 * 排队消息就是 `waiting` 状态的 Execution，与任务 API 共用 `task_wait_order`、
 * `task_wait_deadline` 和认领决策；这里只放渠道无关的上限、期限与位次规则。
 */

/** 每个 Conversation 最多排队的消息数。 */
export const conversationQueueCapacityV1 = 3;

/** 每条排队消息的最长等待时间，由平台固定，调用方不能设置。 */
export const conversationQueueWaitMsV1 = 10 * 60_000;

/** 企微排队期限不晚于该消息回复有效期结束前 30 秒（§14.2.4）。 */
export const conversationQueueReplyLeadMsV1 = 30_000;

/**
 * 进入排队时刻起的等待期限：10 分钟与渠道上限取较早者。上限不晚于受理时刻时无法排队，
 * 返回 null，由调用方按繁忙处理。
 */
export function conversationQueueDeadlineV1(
	acceptedAt: Date,
	limit?: string,
): Date | null {
	const accepted = acceptedAt.getTime();
	const base = accepted + conversationQueueWaitMsV1;
	const cap = limit === undefined ? base : Math.min(base, Date.parse(limit));
	if (!Number.isSafeInteger(cap) || cap <= accepted) return null;
	return new Date(cap);
}

/** 渠道回复有效期给出的排队期限上限（RFC 3339）。 */
export function conversationQueueDeadlineLimitV1(
	replyExpiresAt: string,
): string {
	const expires = Date.parse(replyExpiresAt);
	if (!Number.isFinite(expires)) throw new TypeError("Reply expiry is invalid");
	return new Date(expires - conversationQueueReplyLeadMsV1).toISOString();
}

/**
 * 位次 N 是同一 Conversation 中等待顺序不大于本条的等待 Execution 数；前面还有 N−1 条。
 * 输入为本会话全部等待中 Execution 的顺序。
 */
export function conversationQueuePositionV1(
	ownOrder: number,
	waitingOrders: readonly number[],
): number {
	if (!Number.isSafeInteger(ownOrder) || ownOrder < 1)
		throw new TypeError("Queue order is invalid");
	return waitingOrders.filter((order) => order <= ownOrder).length;
}
