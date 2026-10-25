import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { markUserRead, readFailed } from "./background-read.js";
import { loadBrowserSession } from "./browser-session.js";

export const BrowserSessionQueryContext = createContext<
	QueryClient | undefined
>(undefined);

const browserSessionQueryKey = ["browser-session"] as const;

function sessionQuery(client: QueryClient) {
	return client
		.getQueryCache()
		.find({ queryKey: browserSessionQueryKey, exact: true });
}

/**
 * 记下一次用户发起的会话确认（「重新检查」「重新登录」、登录与退出后）：确认仍不可用时按 R4-02 显示
 * 「暂时无法确认登录状态」。回到标签页等后台重读不调用，已就绪的会话不因暂时确认不了而整页替换（#3387）。
 */
export function markSessionRecheck(client: QueryClient) {
	const query = sessionQuery(client);
	if (query) markUserRead(query, query.state.dataUpdatedAt);
}

export function useBrowserSession() {
	const sessionClient = useContext(BrowserSessionQueryContext);
	const client = useQueryClient(sessionClient);
	const query = useQuery(
		{
			queryKey: browserSessionQueryKey,
			queryFn: () => loadBrowserSession(),
		},
		sessionClient,
	);
	// 可重试的失败才会抛出（不可重试的结果作为 unavailable 返回），已就绪的会话据此保留。
	const failed = readFailed(query, () => true, sessionQuery(client));

	return {
		...query,
		/** 用户发起的会话确认；失败时页面按读取失败处理。 */
		recheck: () => {
			markSessionRecheck(client);
			return query.refetch();
		},
		state: query.isPending
			? ({ kind: "loading" } as const)
			: failed || !query.data
				? ({ kind: "unavailable", retryable: true } as const)
				: query.data,
	};
}
