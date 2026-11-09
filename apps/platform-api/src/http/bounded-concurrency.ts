/**
 * #4048：列表接口逐项投影的并发上限。每项投影会查询多个 Store，而每个 Store 有独立
 * 连接池；不设上限时，一页 50 项会把用到的每个池都撑到它的 max，单次请求就打开几十个
 * 数据库连接。
 */
export const listProjectionConcurrency = 4;

/** 同时运行的任务不超过 `limit`；任务完成时把名额直接交给下一个等待者。 */
export function createConcurrencyLimit(limit: number) {
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new RangeError("Concurrency limit must be a positive integer");
	let active = 0;
	const waiting: (() => void)[] = [];
	return async function run<T>(task: () => Promise<T>): Promise<T> {
		if (active < limit) active++;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await task();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}
