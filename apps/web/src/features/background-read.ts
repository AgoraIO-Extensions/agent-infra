/**
 * 后台重读不替换已显示的内容（#3387，见 docs/development/web-ui.md「组件与调用方」）。
 *
 * 回到标签页、窗口重新聚焦（refetchOnWindowFocus）、轮询与失效后重取都是后台重读。页面已经显示过一次
 * 读取结果时，后台重读进行中或遇到可重试的失败（503、网络中断等），继续显示上一次结果与未保存的输入，
 * 不另加提示（同 directory-names）；下一次读到时更新。没有结果、失败不可重试（登录失效、无权、不存在、
 * 响应无效），或用户发起的读取（页头刷新、「查询」「重置」、「核实原执行状态」、「重新登录」确认会话）
 * 仍按 D2-59 显示读取中与读取失败：发起前调用 markUserRead，失败一直显示到下一次读到结果为止。
 *
 * 记录按 owner 保存：owner 是读取所属的对象（查询或页面的读取范围）。范围随身份或查询变化重建时，
 * 上一个范围的结果与标记不会带到新范围。
 */

/** 一次读取的时间线：最近一次读到结果（contentAt）与最近一次失败（failureAt）的时间（ms）。 */
export type ReadTimeline = {
	readonly contentAt: number;
	readonly failureAt: number;
};

type ReadRecord = {
	userReadSince?: number;
	content?: { readonly value: unknown; readonly at: number };
};

const records = new WeakMap<object, ReadRecord>();

function record(owner: object): ReadRecord {
	let current = records.get(owner);
	if (!current) {
		current = {};
		records.set(owner, current);
	}
	return current;
}

/**
 * 记下一次用户发起的读取。上一次用户读取之后还没有读到结果时沿用它：读取失败后按「重试」「重新加载」
 * 仍算同一次，失败保留到读到结果为止，重读进行中不回到旧内容。
 */
export function markUserRead(owner: object, contentAt: number) {
	const current = record(owner);
	if (current.userReadSince === undefined || current.userReadSince <= contentAt)
		current.userReadSince = Date.now();
}

/** 用户发起的读取在读到结果之前是否已经失败。 */
export function userReadFailed(
	owner: object | undefined,
	read: ReadTimeline,
): boolean {
	const since = owner ? records.get(owner)?.userReadSince : undefined;
	return (
		since !== undefined && since > read.contentAt && read.failureAt >= since
	);
}

/**
 * 用户发起的读取是否还没有结果（既没有读到，也没有失败）；调用方再结合 isFetching。
 * 与发起同一毫秒的失败按发起前的那一次处理（后台重读刚失败就按「刷新」）：读取进行中时它不可能是这次的结果。
 */
export function userReadPending(
	owner: object | undefined,
	read: ReadTimeline,
): boolean {
	const since = owner ? records.get(owner)?.userReadSince : undefined;
	return (
		since !== undefined && since > read.contentAt && since >= read.failureAt
	);
}

/** TanStack Query 观察结果中判断读取失败所需的字段。 */
export type QueryRead = {
	readonly data: unknown;
	readonly error: unknown;
	readonly isError: boolean;
	readonly dataUpdatedAt: number;
	readonly errorUpdatedAt: number;
};

/**
 * 查询结果是否按读取失败替换内容：没有结果、失败不可重试，或用户发起的读取失败。
 * TanStack Query 的重读失败保留上一次的 data（status 为 error），后台重读的可重试失败据此继续显示内容。
 */
export function readFailed(
	query: QueryRead,
	retryable: (error: unknown) => boolean,
	owner?: object,
): boolean {
	return (
		query.isError &&
		(query.data === undefined ||
			!retryable(query.error) ||
			userReadFailed(owner, {
				contentAt: query.dataUpdatedAt,
				failureAt: query.errorUpdatedAt,
			}))
	);
}

/** 用户发起的查询读取是否进行中（后台重读不算）。 */
export function queryUserReading(
	query: Pick<QueryRead, "dataUpdatedAt" | "errorUpdatedAt"> & {
		readonly isFetching: boolean;
	},
	owner: object | undefined,
): boolean {
	return (
		query.isFetching &&
		userReadPending(owner, {
			contentAt: query.dataUpdatedAt,
			failureAt: query.errorUpdatedAt,
		})
	);
}

/**
 * 读取函数把可重试的失败作为结果返回时（查询状态为 success），缓存里的上一次结果已被替换：
 * 在 owner 上记住最近一次读到的内容，后台重读的可重试失败期间继续返回它。用户发起的读取失败、
 * 不可重试的结果（登录失效、无权等）仍原样返回。
 */
export function retainContent<T>(
	owner: object,
	state: T,
	{
		isContent,
		isRetryableFailure,
		updatedAt,
	}: {
		isContent: (state: T) => boolean;
		isRetryableFailure: (state: T) => boolean;
		/** 本次结果的时间（dataUpdatedAt；失败为抛出时的 errorUpdatedAt）。 */
		updatedAt: number;
	},
): T {
	const current = record(owner);
	if (isContent(state)) {
		current.content = { value: state, at: updatedAt };
		return state;
	}
	if (!isRetryableFailure(state)) {
		// 读取中（重置后重读）与不可重试的结果都让旧内容作废，之后的失败不再回到它。
		current.content = undefined;
		return state;
	}
	const retained = current.content;
	return retained &&
		!userReadFailed(owner, { contentAt: retained.at, failureAt: updatedAt })
		? (retained.value as T)
		: state;
}

/** 与 retainContent 配套：最近一次读到内容的时间，没有时为 0（markUserRead 的 contentAt）。 */
export function retainedContentAt(owner: object): number {
	return records.get(owner)?.content?.at ?? 0;
}
